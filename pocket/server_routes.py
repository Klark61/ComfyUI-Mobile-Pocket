"""aiohttp route registration for the Pocket UI."""
import asyncio
import errno
import functools
import logging
import os

from aiohttp import web

from . import canvas
from .gallery import Gallery, PathError, UnsupportedImage
from .workflows import Workflows, compact_history

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(NODE_DIR, "web", "pocket")
NO_CACHE = {"Cache-Control": "no-cache"}


def _int(request, name, default):
    try:
        return int(request.query.get(name, default))
    except ValueError:
        return default


async def _run(fn, *args):
    """Run blocking file IO off the event loop."""
    return await asyncio.get_running_loop().run_in_executor(None, functools.partial(fn, *args))


async def _body(request):
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType(text='{"error": "application/json required"}',
                                           content_type="application/json")
    body = await request.json()
    if not isinstance(body, dict):
        raise ValueError("JSON object body required")
    return body


def register(routes, output_dir, user_dir, cache_dir=None, history_getter=None, history_item_getter=None,
             frontend_root=None, custom_roots=None):
    g = Gallery(output_dir, user_dir, cache_dir or os.path.join(NODE_DIR, "cache"))
    try:
        g.migrate_old_trash()
        g.purge_expired()
    except Exception:
        logging.exception("[pocket] trash startup maintenance failed")

    def guarded(fn):
        """Generic error bodies only: details (which can hold absolute paths) go to the log."""
        async def handler(request):
            try:
                return await fn(request)
            except UnsupportedImage as e:
                return web.json_response({"error": str(e)}, status=415)
            except PathError as e:
                return web.json_response({"error": str(e)}, status=400)
            except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
                logging.warning("[pocket] not found: %s", request.path_qs, exc_info=True)
                return web.json_response({"error": "not found"}, status=404)
            except OSError as e:
                if getattr(e, "winerror", None) == 123 or e.errno == errno.EINVAL:  # invalid name ('*', '?')
                    return web.json_response({"error": "bad path"}, status=400)
                logging.exception("[pocket] server error: %s", request.path_qs)
                return web.json_response({"error": "server error"}, status=500)
            except ImportError:
                logging.exception("[pocket] server error: %s", request.path_qs)
                return web.json_response({"error": "server error"}, status=500)
            except ValueError as e:  # our own validation messages / JSON decode errors
                return web.json_response({"error": str(e)}, status=400)
            except (TypeError, AttributeError):
                logging.warning("[pocket] bad request: %s", request.path_qs, exc_info=True)
                return web.json_response({"error": "bad request"}, status=400)
        return handler

    canvas.register(routes, frontend_root, custom_roots)  # before the generic /pocket/static route

    @routes.get("/pocket")
    async def _redir(request):
        raise web.HTTPFound("/pocket/")

    @routes.get("/pocket/")
    async def _index(request):
        return web.FileResponse(os.path.join(WEB_DIR, "index.html"), headers=NO_CACHE)

    @routes.get("/pocket/static/{path:.*}")
    async def _static(request):
        rel = request.match_info["path"]
        base = os.path.realpath(WEB_DIR)
        full = os.path.realpath(os.path.join(base, rel)) if rel and ":" not in rel and rel[0] not in "/\\" else None
        try:
            inside = bool(full) and os.path.commonpath([full, base]) == base
        except ValueError:  # e.g. junction onto another drive
            inside = False
        if not inside or not os.path.isfile(full):
            raise web.HTTPNotFound()
        vendor = os.path.relpath(full, base).replace(os.sep, "/").startswith("vendor/")
        cc = "public, max-age=31536000, immutable" if vendor else "no-cache"
        return web.FileResponse(full, headers={"Cache-Control": cc})

    @routes.get("/pocket/api/outputs")
    @guarded
    async def _outputs(request):
        q = request.query
        return web.json_response(await _run(
            lambda: g.list(offset=_int(request, "offset", 0), limit=_int(request, "limit", 60),
                           folder=q.get("folder"), kind=q.get("kind", "all"),
                           fav=q.get("fav") == "1", q=q.get("q"))))

    @routes.get("/pocket/api/thumb")
    @guarded
    async def _thumb(request):
        out = await _run(g.thumb, request.query.get("path", ""), _int(request, "s", 384))
        if out is None:
            return web.json_response({"error": "no thumbnail", "kind": "video"}, status=404)
        return web.FileResponse(out, headers={"Cache-Control": "public, max-age=31536000, immutable",
                                              "Content-Type": "image/webp"})

    @routes.get("/pocket/api/meta")
    @guarded
    async def _meta(request):
        return web.json_response(await _run(g.meta, request.query.get("path", "")))

    @routes.post("/pocket/api/delete")
    @guarded
    async def _delete(request):
        paths = (await _body(request)).get("paths")
        if not isinstance(paths, list):
            return web.json_response({"error": "paths required"}, status=400)
        for p in paths:
            g.resolve(p)  # reject whole request on traversal
        return web.json_response(await _run(g.delete, paths))

    @routes.post("/pocket/api/favorite")
    @guarded
    async def _fav(request):
        body = await _body(request)
        return web.json_response({"fav": await _run(g.set_favorite, body.get("path"), bool(body.get("fav", True)))})

    @routes.get("/pocket/api/trash")
    @guarded
    async def _trash_list(request):
        return web.json_response(await _run(g.trash_list))

    async def _ids(request):
        body = await _body(request)
        ids = body.get("ids")
        if not isinstance(ids, list):
            raise ValueError("ids required")
        return ids

    @routes.post("/pocket/api/trash/restore")
    @guarded
    async def _trash_restore(request):
        return web.json_response(await _run(g.restore, await _ids(request)))

    @routes.post("/pocket/api/trash/purge")
    @guarded
    async def _trash_purge(request):
        return web.json_response(await _run(g.purge, await _ids(request)))

    wf = Workflows(user_dir)

    @routes.get("/pocket/api/workflows")
    @guarded
    async def _wf_list(request):
        return web.json_response({"workflows": await _run(wf.list)})

    @routes.get("/pocket/api/workflows/file")
    @guarded
    async def _wf_file(request):
        return web.json_response(await _run(wf.read_workflow, request.query.get("path", "")))

    @routes.get("/pocket/api/snapshots")
    @guarded
    async def _snap_get(request):
        return web.json_response(await _run(wf.get_snapshot, request.query.get("path", "")))

    @routes.put("/pocket/api/snapshots")
    @guarded
    async def _snap_put(request):
        return web.json_response(await _run(wf.put_snapshot, request.query.get("path", ""), await _body(request)))

    @routes.delete("/pocket/api/snapshots")
    @guarded
    async def _snap_del(request):
        return web.json_response({"deleted": await _run(wf.delete_snapshot, request.query.get("path", ""))})

    @routes.get("/pocket/api/presets")
    @guarded
    async def _preset_get(request):
        pid = request.query.get("id")
        if pid is None:
            return web.json_response({"presets": await _run(wf.list_presets)})
        return web.json_response(await _run(wf.get_preset, pid))

    @routes.put("/pocket/api/presets")
    @guarded
    async def _preset_put(request):
        return web.json_response(await _run(wf.put_preset, request.query.get("id", ""), await _body(request)))

    @routes.delete("/pocket/api/presets")
    @guarded
    async def _preset_del(request):
        return web.json_response({"deleted": await _run(wf.delete_preset, request.query.get("id", ""))})

    @routes.get("/pocket/api/history")
    @guarded
    async def _history(request):
        limit = max(1, min(_int(request, "limit", 30), 100))
        inc = request.query.get("include_prompt") == "1"

        def build():
            hist = history_getter(limit) if history_getter else {}
            return compact_history(hist, limit, include_prompt=inc, id_map=wf.workflow_ids())
        return web.json_response({"history": await _run(build)})

    @routes.get("/pocket/api/history/item")
    @guarded
    async def _history_item(request):
        pid = request.query.get("id", "")

        def build():
            hist = history_item_getter(pid) if history_item_getter else {}
            rows = compact_history(hist, 1, include_prompt=True, id_map=wf.workflow_ids())
            return rows[0] if rows else None
        row = await _run(build)
        if row is None:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(row)

    return g
