"""Workflows, snapshots, presets and history logic (no ComfyUI imports)."""
import json
import os
import re
import time

from .gallery import JSON_LOCK, PathError, atomic_write, check_rel

ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def _safe_join(base, rel):
    check_rel(rel)
    base = os.path.realpath(base)
    try:
        full = os.path.realpath(os.path.join(base, rel))
    except (OSError, ValueError) as e:  # e.g. WinError 123 for '*' or '?'
        raise PathError("bad path") from e
    try:
        ok = os.path.commonpath([full, base]) == base
    except ValueError:
        ok = False
    if not ok or full == base:
        raise PathError("path outside directory")
    if not full.lower().endswith(".json"):
        raise PathError("only .json allowed")
    return full


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)

    def w(tmp):
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
    with JSON_LOCK:
        atomic_write(path, w)


def _read_json(path):
    with JSON_LOCK, open(path, "r", encoding="utf-8") as f:
        return json.load(f)


class Workflows:
    def __init__(self, user_dir):
        self.wf_dir = os.path.join(user_dir, "default", "workflows")
        self.data_dir = os.path.join(user_dir, "default", "comfyui-pocket")
        self.snap_dir = os.path.join(self.data_dir, "snapshots")
        self.preset_dir = os.path.join(self.data_dir, "presets")
        self._ids = {}  # rel path -> (mtime, workflow id)

    def workflow_ids(self):
        """Map workflow UI id -> rel path, cached per file mtime."""
        seen, out = {}, {}
        for root, dnames, files in os.walk(self.wf_dir):
            dnames[:] = [d for d in dnames if not d.startswith(".")]
            for fn in files:
                if not fn.lower().endswith(".json"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, self.wf_dir).replace(os.sep, "/")
                try:
                    mt = os.stat(full).st_mtime
                except OSError:
                    continue
                cached = self._ids.get(rel)
                if cached and cached[0] == mt:
                    wid = cached[1]
                else:
                    try:
                        d = _read_json(full)
                        wid = d.get("id") if isinstance(d, dict) else None
                    except (OSError, ValueError):
                        wid = None
                seen[rel] = (mt, wid)
                if isinstance(wid, str) and wid:
                    out[wid] = rel
        self._ids = seen
        return out

    # ---- workflows
    def wf_path(self, rel):
        return _safe_join(self.wf_dir, rel)

    def _snap_path(self, rel):
        self.wf_path(rel)
        return _safe_join(self.snap_dir, rel)

    def list(self):
        out = []
        for root, dnames, files in os.walk(self.wf_dir):
            dnames[:] = [d for d in dnames if not d.startswith(".")]
            for fn in files:
                if not fn.lower().endswith(".json"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, self.wf_dir).replace(os.sep, "/")
                try:
                    mt = os.stat(full).st_mtime
                except OSError:
                    continue
                snap = self._load_snap(rel)
                out.append({
                    "name": fn[:-5], "path": rel, "mtime": mt,
                    "has_snapshot": snap is not None,
                    "snapshot_mtime": snap.get("created") if snap else None,
                    "stale": self._stale(snap, mt) if snap else False,
                })
        out.sort(key=lambda w: w["mtime"], reverse=True)
        return out

    def read_workflow(self, rel):
        return _read_json(self.wf_path(rel))

    # ---- snapshots
    @staticmethod
    def _stale(snap, wf_mtime):
        try:
            return wf_mtime > float(snap.get("workflow_mtime")) + 1e-6
        except (TypeError, ValueError):
            return True

    def _load_snap(self, rel):
        try:
            return _read_json(self._snap_path(rel))
        except (OSError, ValueError, PathError):
            return None

    def get_snapshot(self, rel):
        snap = self._load_snap(rel)
        if snap is None:
            raise FileNotFoundError("no snapshot")
        try:
            snap["stale"] = self._stale(snap, os.stat(self.wf_path(rel)).st_mtime)
        except OSError:
            snap["stale"] = True
        return snap

    def put_snapshot(self, rel, body):
        sp = self._snap_path(rel)
        if not isinstance(body, dict) or not isinstance(body.get("prompt"), dict):
            raise ValueError("prompt (object) required")
        wm = body.get("workflow_mtime")
        try:
            if isinstance(wm, bool):
                raise ValueError
            wm = float(wm)
            if wm != wm or wm in (float("inf"), float("-inf")):
                raise ValueError
        except (TypeError, ValueError):
            try:
                wm = os.stat(self.wf_path(rel)).st_mtime
            except OSError:
                wm = None
        src = body.get("source")
        snap = {"workflow_path": rel, "workflow_mtime": wm, "prompt": body["prompt"],
                "created": time.time(), "source": src if src in ("desktop", "phone") else "phone"}
        _add_sections(snap, body)
        _write_json(sp, snap)
        return snap

    def delete_snapshot(self, rel):
        try:
            os.remove(self._snap_path(rel))
            return True
        except FileNotFoundError:
            return False

    # ---- presets
    def _preset_path(self, pid):
        if not isinstance(pid, str) or not ID_RE.match(pid):
            raise PathError("bad preset id")
        return os.path.join(self.preset_dir, pid + ".json")

    def list_presets(self):
        out = []
        if os.path.isdir(self.preset_dir):
            for fn in os.listdir(self.preset_dir):
                if fn.endswith(".json"):
                    try:
                        p = _read_json(os.path.join(self.preset_dir, fn))
                        out.append({"id": p.get("id", fn[:-5]), "name": p.get("name"), "source": p.get("source")})
                    except (OSError, ValueError):
                        pass
        return sorted(out, key=lambda p: str(p["name"]).lower())

    def get_preset(self, pid):
        return _read_json(self._preset_path(pid))

    def put_preset(self, pid, body):
        path = self._preset_path(pid)
        if not isinstance(body, dict) or not isinstance(body.get("prompt"), dict):
            raise ValueError("prompt (object) required")
        fields = body.get("fields", [])
        if not isinstance(fields, list):
            raise ValueError("fields must be a list")
        preset = {"id": pid, "name": str(body.get("name") or pid), "prompt": body["prompt"],
                  "fields": fields, "source": body.get("source")}
        _add_sections(preset, body)
        if isinstance(body.get("wf_path"), str):
            preset["wf_path"] = body["wf_path"]
        _write_json(path, preset)
        return preset

    def delete_preset(self, pid):
        try:
            os.remove(self._preset_path(pid))
            return True
        except FileNotFoundError:
            return False


def _add_sections(dst, body):
    """Optional Sections state from the phone: mode overrides {uiNodeId: 0|2|4} and the converter's structure."""
    modes = body.get("modes")
    if isinstance(modes, dict):
        dst["modes"] = {str(k): v for k, v in modes.items() if v in (0, 2, 4) and not isinstance(v, bool)}
    if isinstance(body.get("structure"), dict):
        dst["structure"] = body["structure"]


def _text_outputs(outputs, prompt, cap=20000):
    """Text results (ui.text of PreviewAny / ShowText / easy showAnything ...) as [{node, title, text}]."""
    out = []
    if not isinstance(outputs, dict):
        return out
    for nid, node_out in outputs.items():
        if not isinstance(node_out, dict):
            continue
        t = node_out.get("text")
        vals = t if isinstance(t, list) else [t]
        vals = [v for v in vals if isinstance(v, str) and v.strip()]
        if not vals:
            continue
        node = prompt.get(str(nid)) if isinstance(prompt, dict) else None
        node = node if isinstance(node, dict) else {}
        meta = node.get("_meta") if isinstance(node.get("_meta"), dict) else {}
        out.append({"node": str(nid), "title": meta.get("title") or node.get("class_type") or "Text",
                    "text": "\n\n".join(vals)[:cap]})
    return out


def compact_history(hist, limit=30, include_prompt=True, id_map=None):
    """hist: ComfyUI get_history() dict {prompt_id: entry} in insertion (oldest first) order.
    Returns newest first. id_map: workflow UI id -> rel path in workflows dir."""
    id_map = id_map or {}
    rows = []
    for pid, e in reversed(list((hist or {}).items())):
        if len(rows) >= max(1, limit):
            break
        try:
            pr = e.get("prompt") or []
            prompt = pr[2] if len(pr) > 2 else None
            extra = pr[3] if len(pr) > 3 and isinstance(pr[3], dict) else {}
            status = e.get("status") or {}
            ts = None
            for m in status.get("messages", []) or []:
                if isinstance(m, (list, tuple)) and len(m) > 1 and isinstance(m[1], dict) and "timestamp" in m[1]:
                    if ts is None or m[0] == "execution_start":
                        ts = m[1]["timestamp"]
            outs = []
            for node_out in (e.get("outputs") or {}).values():
                if not isinstance(node_out, dict):
                    continue
                for v in node_out.values():
                    if isinstance(v, list):
                        for f in v:
                            if isinstance(f, dict) and "filename" in f:
                                outs.append({"filename": f["filename"], "subfolder": f.get("subfolder", ""),
                                             "type": f.get("type", "output")})
            texts = _text_outputs(e.get("outputs"), prompt)
            wf = (extra.get("extra_pnginfo") or {}).get("workflow")
            name = path = None
            if isinstance(wf, dict):
                wid = wf.get("id")
                path = id_map.get(wid) if isinstance(wid, str) else None
                if path:
                    name = path.rsplit("/", 1)[-1][:-5]
                else:
                    name = wf.get("name") or None
            row = {"prompt_id": pid, "ts": ts, "status": status.get("status_str", "unknown"),
                   "outputs": outs, "texts": texts, "workflow_name": name, "workflow_path": path}
            if include_prompt:
                row["prompt"] = prompt
            rows.append(row)
        except (AttributeError, TypeError, IndexError):
            continue
    return rows
