"""Pure gallery logic (no ComfyUI imports): listing, thumbs, meta, trash, favorites."""
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv"}

THUMB_SIZES = (256, 384, 768, 1536)  # `s` snaps to the nearest size at or above (bounded cache keys)
IMAGE_FORMATS = ["PNG", "JPEG", "WEBP", "GIF", "BMP"]
PRUNE_EVERY = 20  # thumb writes between cache-size checks


def _env_num(name, default):
    try:
        v = float(os.environ.get(name, ""))
        return v if v > 0 else default
    except ValueError:
        return default


def snap_size(s):
    try:
        s = int(s)
    except (TypeError, ValueError):
        s = 384
    for t in THUMB_SIZES:
        if s <= t:
            return t
    return THUMB_SIZES[-1]


class PathError(ValueError):
    pass


class UnsupportedImage(ValueError):
    """Image refused: format not whitelisted, unreadable, or over the pixel cap (HTTP 415)."""


def check_rel(rel):
    """Reject unsafe relative paths BEFORE any realpath call (UNC/drive/ADS)."""
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        raise PathError("bad path")
    if ":" in rel or rel[0] in "/\\" or os.path.isabs(rel) or os.path.splitdrive(rel)[0]:
        raise PathError("absolute or drive path not allowed")
    return rel


JSON_LOCK = threading.RLock()  # serializes favorites/snapshots/presets reads and writes


def atomic_write(path, writer, tolerate_existing=False):
    """writer(tmp_path) writes the file. Unique tmp name; replace is retried (Windows
    readers can briefly block it). tolerate_existing: ignore failure if dest exists (thumbs)."""
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        writer(tmp)
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                break
            except OSError:
                if tolerate_existing and os.path.exists(path):
                    break
                if attempt == 4:
                    raise
                time.sleep(0.05)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


class Gallery:
    def __init__(self, output_dir, user_dir, cache_dir, data_dir=None):
        self.output_dir = os.path.realpath(output_dir)
        _fav_dir = os.path.join(user_dir, "default", "comfyui-pocket")
        _old_fav_dir = os.path.join(user_dir, "default", "comfyui-" + "mobile")   # pre-rename name: moved once
        try:
            if os.path.isdir(_old_fav_dir) and not os.path.exists(_fav_dir):
                os.rename(_old_fav_dir, _fav_dir)
        except OSError:
            logging.warning("[pocket] could not move the old user data folder", exc_info=True)
        self.fav_file = os.path.join(_fav_dir, "favorites.json")
        self.thumb_dir = os.path.join(cache_dir, "thumbs")
        # node-local, outside every stock-served root (output/input/temp/user)
        self.data_dir = os.path.abspath(data_dir or os.path.join(os.path.dirname(os.path.abspath(cache_dir)), "data"))
        self.trash_dir = os.path.join(self.data_dir, "trash")
        self.trash_files = os.path.join(self.trash_dir, "files")
        self.trash_index = os.path.join(self.trash_dir, "index.json")
        self.trash_days = _env_num("COMFYUI_POCKET_TRASH_DAYS", 30)
        self.thumb_cache_bytes = int(_env_num("COMFYUI_POCKET_THUMB_CACHE_MB", 300) * 1024 * 1024)
        self.max_pixels = int(_env_num("COMFYUI_POCKET_MAX_PIXELS_MP", 80) * 1_000_000)
        self.prune_every = PRUNE_EVERY
        self._thumb_writes = 0
        self._lock = threading.Lock()
        self._trash_lock = threading.RLock()
        self._prune_lock = threading.Lock()
        self._gen = 0  # bumped on every mutation; _scan discards stale results
        self._sig = None
        self._items = []
        self._folders = []

    # ---- path safety
    def resolve(self, rel):
        return self._resolve(rel)[0]

    def canon(self, rel):
        return self._resolve(rel)[1]

    def _resolve(self, rel):
        check_rel(rel)
        try:
            full = os.path.realpath(os.path.join(self.output_dir, rel))
        except (OSError, ValueError) as e:  # e.g. WinError 123 for '*' or '?'
            raise PathError("bad path") from e
        try:
            inside = os.path.commonpath([full, self.output_dir]) == self.output_dir
        except ValueError:
            inside = False
        if not inside or full == self.output_dir:
            raise PathError("path outside output dir")
        relp = os.path.relpath(full, self.output_dir)
        if any(p.startswith(".") for p in relp.split(os.sep)):
            raise PathError("hidden path")
        return full, relp.replace(os.sep, "/")

    @staticmethod
    def kind_of(name):
        ext = os.path.splitext(name)[1].lower()
        if ext in IMAGE_EXT:
            return "image"
        if ext in VIDEO_EXT:
            return "video"
        return None

    # ---- favorites
    def _load_favs(self):
        try:
            with JSON_LOCK, open(self.fav_file, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except (OSError, ValueError):
            return set()

    def set_favorite(self, rel, fav):
        rel = self.canon(rel)
        with self._lock:
            favs = self._load_favs()
            (favs.add if fav else favs.discard)(rel)
            os.makedirs(os.path.dirname(self.fav_file), exist_ok=True)

            def w(tmp):
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(sorted(favs), f)
            with JSON_LOCK:
                atomic_write(self.fav_file, w)
        return bool(fav)

    # ---- listing
    def _invalidate(self):
        with self._lock:
            self._gen += 1
            self._sig = None

    def _scan(self):
        with self._lock:
            gen = self._gen
        dirs = []
        for root, dnames, _ in os.walk(self.output_dir):
            dnames[:] = [d for d in dnames if not d.startswith(".")]
            try:
                dirs.append((root, os.stat(root).st_mtime_ns))
            except OSError:
                pass
        sig = tuple(dirs)
        with self._lock:
            if sig == self._sig:
                return self._items, self._folders
        items = []
        folders = set()
        for root, _ in dirs:
            rel_root = os.path.relpath(root, self.output_dir)
            folder = "" if rel_root == "." else rel_root.replace(os.sep, "/")
            if folder:
                folders.add(folder)
            try:
                entries = list(os.scandir(root))
            except OSError:
                continue
            for e in entries:
                if e.name.startswith(".") or not e.is_file():
                    continue
                kind = self.kind_of(e.name)
                if not kind:
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                items.append({
                    "path": (folder + "/" if folder else "") + e.name,
                    "name": e.name, "folder": folder, "mtime": st.st_mtime,
                    "size": st.st_size, "kind": kind,
                })
        items.sort(key=lambda i: (i["mtime"], i["path"]), reverse=True)
        with self._lock:
            if gen != self._gen:  # a delete/restore ran mid-scan: result may be stale, don't cache
                return items, sorted(folders)
            self._sig, self._items, self._folders = sig, items, sorted(folders)
            return self._items, self._folders

    def list(self, offset=0, limit=60, folder=None, kind="all", fav=False, q=None):
        items, folders = self._scan()
        favs = self._load_favs()
        q = (q or "").lower()
        sel = []
        for i in items:
            if folder and i["folder"] != folder and not i["folder"].startswith(folder + "/"):
                continue
            if kind in ("image", "video") and i["kind"] != kind:
                continue
            if fav and i["path"] not in favs:
                continue
            if q and q not in i["path"].lower():
                continue
            sel.append(i)
        offset = max(0, offset)
        limit = max(1, min(limit, 500))
        page = [dict(i, fav=i["path"] in favs) for i in sel[offset:offset + limit]]
        return {"items": page, "total": len(sel), "folders": folders}

    # ---- image decoding
    def _open_image(self, full):
        """Open with a format whitelist and a pixel cap checked BEFORE any decode.
        (Not Image.MAX_IMAGE_PIXELS: other packs set it to None.)"""
        from PIL import Image, UnidentifiedImageError
        if os.path.isdir(full):
            raise IsADirectoryError("not a file")
        try:
            im = Image.open(full, formats=IMAGE_FORMATS)
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError, PermissionError):
            raise
        except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as e:
            raise UnsupportedImage("unsupported image") from e
        if im.width * im.height > self.max_pixels:
            im.close()
            raise UnsupportedImage("image too large")
        return im

    # ---- thumbs
    @staticmethod
    def _thumb_key(rel, st, size):
        return hashlib.sha1(f"{rel}|{st.st_mtime_ns}|{st.st_size}|{size}".encode()).hexdigest()

    def thumb(self, rel, size=384):
        full, rel = self._resolve(rel)
        if self.kind_of(full) != "image":
            return None
        size = snap_size(size)
        st = os.stat(full)
        out = os.path.join(self.thumb_dir, self._thumb_key(rel, st, size) + ".webp")
        if not os.path.exists(out):
            os.makedirs(self.thumb_dir, exist_ok=True)
            from PIL import Image
            with self._open_image(full) as im:
                try:  # corrupt/truncated data surfaces as OSError/bomb/ValueError while decoding
                    if im.format == "JPEG":
                        im.draft(None, (size, size))  # decode at reduced scale
                    im.thumbnail((size, size))
                    if im.mode not in ("RGB", "RGBA"):
                        im = im.convert("RGBA" if "A" in im.getbands() or "transparency" in im.info else "RGB")
                    im.load()
                except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as e:
                    raise UnsupportedImage("unsupported image") from e
                atomic_write(out, lambda tmp: im.save(tmp, "WEBP", quality=80), tolerate_existing=True)
            self._note_thumb_write(out)
        return out

    def _note_thumb_write(self, keep=None):
        with self._lock:
            n = self._thumb_writes
            self._thumb_writes += 1
        if n % max(1, self.prune_every) == 0:  # first write after start, then every N
            try:
                self.prune_thumbs(keep)
            except OSError:
                logging.warning("[pocket] thumb cache prune failed", exc_info=True)

    def prune_thumbs(self, keep=None):
        """Delete the oldest thumbs (by mtime) until the cache is within its byte cap.
        `keep` (the thumb just generated) is never evicted."""
        with self._prune_lock:
            return self._prune_locked(os.path.normcase(keep) if keep else None)

    def _prune_locked(self, keep):
        files, total = [], 0
        with os.scandir(self.thumb_dir) as it:
            for e in it:
                if not e.name.endswith(".webp"):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                files.append((st.st_mtime, e.path, st.st_size))
                total += st.st_size
        removed = 0
        if total > self.thumb_cache_bytes:
            files.sort()
            for _, path, size in files:
                if total <= self.thumb_cache_bytes:
                    break
                if keep and os.path.normcase(path) == keep:
                    continue
                try:
                    os.remove(path)
                    total -= size
                    removed += 1
                except OSError:
                    pass
        return removed

    def _drop_thumbs(self, rel, st):
        for size in THUMB_SIZES:
            try:
                os.remove(os.path.join(self.thumb_dir, self._thumb_key(rel, st, size) + ".webp"))
            except OSError:
                pass

    # ---- meta
    def meta(self, rel):
        full = self.resolve(rel)
        if self.kind_of(full) != "image":
            return {"summary": {}, "has_prompt": False, "prompt": None}
        prompt = None
        with self._open_image(full) as im:
            info = dict(im.info)
            w, h = im.size
        raw = info.get("prompt")
        if isinstance(raw, str):
            try:
                prompt = json.loads(raw)
            except ValueError:
                prompt = None
        summary = summarize_prompt(prompt) if isinstance(prompt, dict) else {}
        if not summary.get("width"):
            summary["width"], summary["height"] = w, h
        return {"summary": summary, "has_prompt": isinstance(prompt, dict), "prompt": prompt}

    # ---- trash (node-local data/trash, never served by stock /view)
    def _load_trash(self):
        """{} only when no index exists yet; any other failure raises so callers never
        overwrite (and orphan) an index they could not read."""
        try:
            with open(self.trash_index, "r", encoding="utf-8") as f:
                d = json.load(f)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as e:
            raise OSError("trash index unreadable") from e
        if not isinstance(d, dict):
            raise OSError("trash index malformed")
        return d

    def _save_trash(self, idx):
        os.makedirs(self.trash_dir, exist_ok=True)

        def w(tmp):
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(idx, f)
        atomic_write(self.trash_index, w)

    def _trash_path(self, tid, ent):
        if not isinstance(tid, str) or not re.fullmatch(r"[0-9a-f]{32}", tid):
            raise PathError("bad trash id")
        ext = os.path.splitext(str(ent.get("rel", "")))[1].lower()
        if ext not in IMAGE_EXT and ext not in VIDEO_EXT:
            raise PathError("bad trash entry")
        p = os.path.join(self.trash_files, tid + ext)
        base = os.path.realpath(self.trash_files)
        try:
            ok = os.path.commonpath([os.path.realpath(p), base]) == base
        except ValueError:
            ok = False
        if not ok:
            raise PathError("bad trash entry")
        return p

    def _trash_add(self, idx, src, rel, ts=None):
        """Index entry is persisted BEFORE the move, so a crash can never orphan a file."""
        size = os.stat(src).st_size
        tid = uuid.uuid4().hex
        ent = {"rel": rel, "deleted": ts if ts is not None else time.time(), "size": size}
        os.makedirs(self.trash_files, exist_ok=True)
        dest = self._trash_path(tid, ent)
        idx[tid] = ent
        try:
            self._save_trash(idx)
        except BaseException:
            idx.pop(tid, None)
            raise
        try:
            shutil.move(src, dest)
        except BaseException:
            idx.pop(tid, None)
            if os.path.exists(src) and os.path.exists(dest):  # partial cross-device copy
                try:
                    os.remove(dest)
                except OSError:
                    pass
            try:
                self._save_trash(idx)
            except OSError:
                logging.warning("[pocket] could not roll back trash index", exc_info=True)
            raise
        return tid

    def trash_list(self):
        self.purge_expired()
        with self._trash_lock:
            idx = self._load_trash()
        items = [dict(ent, id=tid) for tid, ent in idx.items() if isinstance(ent, dict)]
        items.sort(key=lambda i: i.get("deleted", 0), reverse=True)
        return {"items": items, "days": self.trash_days}

    def purge_expired(self):
        """Lazy auto-purge of trash older than COMFYUI_POCKET_TRASH_DAYS (default 30)."""
        cutoff = time.time() - self.trash_days * 86400
        with self._trash_lock:
            idx = self._load_trash()
            old = [t for t, e in idx.items() if not isinstance(e, dict) or e.get("deleted", 0) < cutoff]
            return self.purge(old)["purged"] if old else []

    def purge(self, ids):
        purged, errors = [], []
        with self._trash_lock:
            idx = self._load_trash()
            for tid in ids:
                ent = idx.get(tid) if isinstance(tid, str) else None
                if ent is None:
                    errors.append({"id": tid if isinstance(tid, str) else None, "error": "not in trash"})
                    continue
                try:
                    try:
                        p = self._trash_path(tid, ent if isinstance(ent, dict) else {})
                    except PathError:  # corrupt entry: no safe file to remove, drop the record
                        p = None
                    if p and os.path.exists(p):
                        os.remove(p)
                    del idx[tid]
                    purged.append(tid)
                except OSError:
                    logging.warning("[pocket] trash purge failed", exc_info=True)
                    errors.append({"id": tid, "error": "server error"})
            self._save_trash(idx)
        return {"purged": purged, "errors": errors}

    def restore(self, ids):
        restored, errors, moves = [], [], []
        with self._trash_lock:
            idx = self._load_trash()
            for tid in ids:
                ent = idx.get(tid) if isinstance(tid, str) else None
                if not isinstance(ent, dict):
                    errors.append({"id": tid if isinstance(tid, str) else None, "error": "not in trash"})
                    continue
                try:
                    dest = self.resolve(ent["rel"])  # check_rel + inside-output + no hidden parts
                    if not self.kind_of(dest):
                        raise PathError("not a media file")
                    src = self._trash_path(tid, ent)
                    if os.path.lexists(dest):
                        raise PathError("destination exists")
                    if not os.path.isfile(src):
                        raise PathError("trash file missing")
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    shutil.move(src, dest)
                    moves.append((dest, src))
                    del idx[tid]
                    restored.append(ent["rel"])
                except (PathError, KeyError) as ex:
                    errors.append({"id": tid, "error": str(ex) if isinstance(ex, PathError) else "bad entry"})
                except OSError:
                    logging.warning("[pocket] trash restore failed", exc_info=True)
                    errors.append({"id": tid, "error": "server error"})
            try:
                self._save_trash(idx)
            except BaseException:  # index not updated: put files back so nothing is half-restored
                for dest, src in reversed(moves):
                    try:
                        shutil.move(dest, src)
                    except OSError:
                        logging.warning("[pocket] restore rollback failed", exc_info=True)
                self._invalidate()
                raise
        self._invalidate()
        return {"restored": restored, "errors": errors}

    def migrate_old_trash(self):
        """Move output/.trash (publicly served by stock /view) into data/trash. Returns the count moved."""
        old = os.path.join(self.output_dir, ".trash")
        if not os.path.isdir(old):
            return 0
        n = 0
        with self._trash_lock:
            idx = self._load_trash()
            now = time.time()  # real deletion time unknown; don't let the 30-day purge eat them at once
            for root, _, names in os.walk(old):
                for name in names:
                    src = os.path.join(root, name)
                    rel = os.path.relpath(src, old).replace(os.sep, "/")
                    if (any(p.startswith(".") for p in rel.split("/")) or not self.kind_of(name)
                            or os.path.islink(src)):
                        logging.warning("[pocket] not migrating %s (hidden/non-media/link); left in place", rel)
                        continue
                    try:
                        self._trash_add(idx, src, rel, now)
                        n += 1
                    except OSError:
                        logging.warning("[pocket] could not migrate %s", rel, exc_info=True)
        for root, _, _ in os.walk(old, topdown=False):
            try:
                os.rmdir(root)
            except OSError:
                pass
        logging.warning("[pocket] moved %d file(s) from output/.trash into the node-local trash "
                        "(data/trash); output/.trash was downloadable via /view", n)
        return n

    # ---- delete
    def delete(self, rels):
        moved, errors = [], []
        for rel in rels:
            try:
                full, canon = self._resolve(rel)
                with self._trash_lock:
                    if not os.path.isfile(full):
                        raise PathError("not a file")
                    if not self.kind_of(full):
                        raise PathError("not a media file")
                    st = os.stat(full)
                    idx = self._load_trash()
                    self._trash_add(idx, full, canon)
                moved.append(rel)
                self._drop_thumbs(canon, st)
                self.set_favorite(canon, False)
            except PathError as ex:
                errors.append({"path": rel, "error": str(ex)})
            except OSError:
                logging.warning("[pocket] delete failed for %r", rel, exc_info=True)
                errors.append({"path": rel, "error": "server error"})
        self._invalidate()
        try:
            self.purge_expired()
        except OSError:
            logging.warning("[pocket] trash auto-purge failed", exc_info=True)
        return {"deleted": moved, "errors": errors}


def _is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], (str, int))


def _num_or_str(v):
    return isinstance(v, (int, float, str)) and not isinstance(v, bool)


def _text_of(prompt, ref, depth=0, role=None):
    """Trace a conditioning link back to a text string.
    role ("positive"/"negative") picks the matching key on nodes holding both texts."""
    if depth > 8 or not _is_link(ref):
        return None
    node = prompt.get(str(ref[0]))
    if not isinstance(node, dict):
        return None
    ins = node.get("inputs", {})
    if role and isinstance(ins.get(role), str):
        return ins[role]
    for k in ("text", "prompt", "text_g", "string", "value"):
        if isinstance(ins.get(k), str):
            return ins[k]
        if _is_link(ins.get(k)):
            t = _text_of(prompt, ins[k], depth + 1, role)
            if t:
                return t
    for k, v in ins.items():
        if _is_link(v) and k in ("conditioning", "positive", "negative", "conditioning_1", "cond", "guider"):
            t = _text_of(prompt, v, depth + 1, role)
            if t:
                return t
    return None


_VALUE_KEYS = ("value", "int", "float", "number", "seed", "steps", "cfg", "string", "text")
_CHAIN_HINTS = ("sampler", "noise", "scheduler", "guider", "sigmas")


def _literal(prompt, v):
    """Literal value, or the literal of a primitive/seed node the link points at."""
    if _is_link(v):
        n = prompt.get(str(v[0]))
        if not isinstance(n, dict) or not isinstance(n.get("inputs"), dict):
            return None
        for k in _VALUE_KEYS:
            x = n["inputs"].get(k)
            if _num_or_str(x):
                return x
        return None
    return v if _num_or_str(v) else None


def _is_chain(node):
    ct = str(node.get("class_type", "")).lower()
    return any(h in ct for h in _CHAIN_HINTS)


def summarize_prompt(prompt):
    s = {"positive": None, "negative": None, "seed": None, "steps": None, "cfg": None,
         "sampler": None, "scheduler": None, "model": None, "loras": [],
         "width": None, "height": None}
    nodes = {k: v for k, v in prompt.items() if isinstance(v, dict) and isinstance(v.get("inputs"), dict)}
    ordered = sorted(nodes.values(), key=lambda n: 0 if _is_chain(n) else 1)  # stable

    # prompts: prefer sampler/guider nodes that carry positive+negative links
    for n in ordered:
        ins = n["inputs"]
        if _is_link(ins.get("positive")) and _is_link(ins.get("negative")):
            s["positive"] = _text_of(prompt, ins["positive"], role="positive")
            s["negative"] = _text_of(prompt, ins["negative"], role="negative")
            if s["positive"]:
                break

    for src, dst in (("seed", "seed"), ("noise_seed", "seed"), ("steps", "steps"), ("cfg", "cfg"),
                     ("sampler_name", "sampler"), ("scheduler", "scheduler")):
        if s[dst] is not None:
            continue
        for n in ordered:  # chain nodes first
            v = _literal(prompt, n["inputs"].get(src))
            if v is not None:
                s[dst] = v
                break

    for k in ("unet_name", "ckpt_name", "model_name"):  # loaders before upscalers
        for n in nodes.values():
            if isinstance(n["inputs"].get(k), str):
                s["model"] = n["inputs"][k]
                break
        if s["model"]:
            break

    for n in nodes.values():
        ins = n["inputs"]
        if isinstance(ins.get("lora_name"), str) and ins["lora_name"] not in ("", "None"):
            lora = {"name": ins["lora_name"]}
            sm = ins.get("strength_model", ins.get("strength"))
            if isinstance(sm, (int, float)):
                lora["strength"] = sm
            s["loras"].append(lora)
        if s["width"] is None and isinstance(ins.get("width"), int) and isinstance(ins.get("height"), int):
            s["width"], s["height"] = ins["width"], ins["height"]

    if not s["positive"]:
        strs = [v for n in nodes.values() for k, v in n["inputs"].items()
                if isinstance(v, str) and k in ("text", "prompt", "text_g", "string") and v != s["negative"]]
        strs.sort(key=len, reverse=True)
        if strs:
            s["positive"] = strs[0]
    return s
