"""Mirror execution events sent to one (foreign) client onto every connected Pocket socket.

ComfyUI sends progress/executing/preview frames only to the sid that queued the prompt.
Pocket clients connect with clientId "cpocket-<uuid>"; this wraps PromptServer.send_sync so
jobs queued elsewhere (desktop) are also visible on the phone.

Privacy note: ComfyUI has no authentication, so any LAN client that connects with a "cpocket-*"
clientId can observe progress and preview frames of every job. Mirror targets are capped to the
MAX_TARGETS most recent healthy such sockets (closed/backed-up ones are evicted first), and binary preview frames are skipped for
sockets whose send buffer is backed up.
"""
import logging

POCKET_PREFIX = "cpocket-"
MAX_TARGETS = 8
MAX_BACKLOG = 1 << 20  # bytes queued on a socket before we stop sending it preview frames
BINARY_EVENTS = frozenset({1, 2, 4})
MIRRORED_EVENTS = frozenset({
    "progress", "executing", "execution_start", "executed", "execution_success",
    "execution_error", "execution_cached", "execution_interrupted", "progress_state",
    1, 2, 4,  # BinaryEventTypes: PREVIEW_IMAGE, UNENCODED_PREVIEW_IMAGE, PREVIEW_IMAGE_WITH_METADATA
})


def _backed_up(ws):
    """True if the socket's transport has a large unsent backlog. Uses aiohttp internals; False if unknown."""
    try:
        return ws._writer.transport.get_write_buffer_size() > MAX_BACKLOG
    except Exception:
        return False


def _recent(order, server, pocket):
    """Recency order (oldest first). A socket that reconnects under the same sid is a new
    object: pop before set so it counts as fresh (dict reassignment keeps the old slot)."""
    live = {k: server.sockets.get(k) for k in pocket}
    for k in [k for k in order if k not in live]:
        del order[k]
    for k, ws in live.items():
        if k in order and order[k] is ws:
            continue
        order.pop(k, None)
        order[k] = ws
    return [k for k in order if k in live]


def select_targets(order, server, sid):
    pocket = [k for k in tuple(server.sockets) if isinstance(k, str) and k.startswith(POCKET_PREFIX)]
    cands = [k for k in _recent(order, server, pocket) if k != sid]
    state = {}
    for k in cands:
        ws = server.sockets.get(k)
        if getattr(ws, "closed", False) is True:
            continue
        state[k] = _backed_up(ws)
    live = [k for k in cands if k in state]
    if len(live) > MAX_TARGETS:
        good = [k for k in live if not state[k]]
        keep = good[-MAX_TARGETS:]
        if len(keep) < MAX_TARGETS:
            bad = [k for k in live if state[k]]
            keep += bad[-(MAX_TARGETS - len(keep)):]
        ks = set(keep)
        live = [k for k in live if k in ks]
    return live, state


def install(server):
    """Wrap server.send_sync (idempotent). Never raises."""
    try:
        if getattr(server, "_pocket_mirror_installed", False):
            return False
        original = server.send_sync
        order = {}

        def send_sync(event, data, sid=None):
            original(event, data, sid)
            try:
                if sid is None or not isinstance(sid, str) or event not in MIRRORED_EVENTS:
                    return
                targets, backed = select_targets(order, server, sid)
                for t in targets:
                    if event in BINARY_EVENTS and backed.get(t):
                        continue
                    original(event, data, t)
            except Exception:
                logging.debug("[pocket] mirror failed", exc_info=True)

        server.send_sync = send_sync
        server._pocket_mirror_installed = True
        return True
    except Exception:
        logging.exception("[pocket] could not install event mirror")
        return False
