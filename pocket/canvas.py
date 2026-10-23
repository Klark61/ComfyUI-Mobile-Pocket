"""Canvas mode: serve ComfyUI's own frontend at /pocket/canvas with a phone layer injected.

The frontend's index.html is read at request time (so frontend updates keep working), then rewritten:
  - <base href="/"> so the bundle's relative asset URLs (./assets/..., user.css, api/...) still resolve from the site root;
  - an early classic <script> (boot.js) as the first thing in <head>, so it runs before the app bundle;
  - canvas.css last in <head>.
GET /pocket/api/canvas/node-packs maps node types to the custom node folders that provide them (used for workflow-aware pruning).
Static files for the layer live in web/canvas and are served at /pocket/static/canvas/...
"""
import asyncio
import logging
import os
import re
import sys

from aiohttp import web

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANVAS_DIR = os.path.join(NODE_DIR, "web", "canvas")
NO_CACHE = {"Cache-Control": "no-cache"}
HEAD_INJECT = '<base href="/"><script src="/pocket/static/canvas/boot.js"></script>'
TAIL_INJECT = '<link rel="stylesheet" href="/pocket/static/canvas/canvas.css">'


def rewrite_index(html):
    """Inject the phone layer into the frontend's index.html."""
    out, n = re.subn(r"<head(\s[^>]*)?>", lambda m: m.group(0) + HEAD_INJECT, html, count=1, flags=re.I)
    if n == 0:
        raise ValueError("index.html has no <head>")
    out, n = re.subn(r"</head>", lambda m: TAIL_INJECT + m.group(0), out, count=1, flags=re.I)
    if n == 0:
        raise ValueError("index.html has no </head>")
    return out


def default_frontend_root():
    """The directory that holds the frontend's index.html (what ComfyUI serves at /)."""
    try:
        from server import PromptServer
        root = getattr(PromptServer.instance, "web_root", None)
        if root and os.path.isfile(os.path.join(root, "index.html")):
            return root
    except Exception:
        pass
    import comfyui_frontend_package
    return os.path.join(os.path.dirname(comfyui_frontend_package.__file__), "static")


def node_pack_map(roots, modules=None):
    """{node type: [custom_nodes folder, ...]} from the NODE_CLASS_MAPPINGS of every loaded custom node module.

    /object_info reports one python_module per node, which is wrong for wrapper packs that re-register other packs' nodes
    (e.g. comfyui-workflow-encrypt). The frontend script that decorates such a node lives in the ORIGINAL pack, so the canvas
    boot needs every pack that provides the type. Folder names equal the /extensions web directory names.
    """
    roots = [os.path.realpath(r) for r in roots]
    out = {}
    for mod in list((modules if modules is not None else sys.modules).values()):
        try:
            mappings = getattr(mod, "NODE_CLASS_MAPPINGS", None)
            f = getattr(mod, "__file__", None)
            if not isinstance(mappings, dict) or not f:
                continue
            f = os.path.realpath(f)
            folder = None
            for r in roots:
                rel = os.path.relpath(f, r)
                if not rel.startswith("..") and os.sep in rel:
                    folder = rel.split(os.sep)[0]
                    break
            if not folder:
                continue
            for t in mappings:
                packs = out.setdefault(str(t), [])
                if folder not in packs:
                    packs.append(folder)
        except Exception:
            continue
    return out


WIDGET_PROVIDERS_KEY = "__widget_providers__"
_WIDGET_RE = re.compile(r"getCustomWidgets")


def widget_provider_packs(web_dirs, max_bytes=3_000_000):
    """Names of the packs whose frontend JS defines getCustomWidgets (they register GLOBAL widget types such as COLOR).

    Dropping such a pack turns every input of that type into a socket and shifts widgets_values, so the canvas boot never
    prunes them. web_dirs: {pack name: directory} (nodes.EXTENSION_WEB_DIRS). Static text scan of every .js file.
    """
    out = []
    for name, d in sorted(web_dirs.items()):
        found = False
        for dp, _dirs, files in os.walk(d):
            for fn in files:
                if not fn.lower().endswith((".js", ".mjs")):
                    continue
                fp = os.path.join(dp, fn)
                try:
                    if os.path.getsize(fp) > max_bytes:
                        continue
                    with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                        if _WIDGET_RE.search(f.read()):
                            found = True
                            break
                except OSError:
                    continue
            if found:
                break
        if found:
            out.append(name)
    return out


def _web_dirs():
    import nodes
    return dict(getattr(nodes, "EXTENSION_WEB_DIRS", {}) or {})


def _custom_roots():
    import folder_paths
    return folder_paths.get_folder_paths("custom_nodes")


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def register(routes, frontend_root=None, custom_roots=None, web_dirs=None):
    """Register /pocket/canvas and /pocket/static/canvas/*. Call BEFORE the generic /pocket/static route."""
    root_of = frontend_root or default_frontend_root

    async def _page(request):
        try:
            html = await asyncio.get_running_loop().run_in_executor(
                None, _read, os.path.join(root_of(), "index.html"))
            return web.Response(text=rewrite_index(html), content_type="text/html", charset="utf-8", headers=NO_CACHE)
        except (OSError, ValueError, ImportError):
            logging.warning("[pocket] canvas mode unavailable", exc_info=True)
            return web.json_response({"error": "canvas mode unavailable"}, status=503)

    routes.get("/pocket/canvas")(_page)
    routes.get("/pocket/canvas/")(_page)

    cache = {}

    @routes.get("/pocket/api/canvas/node-packs")
    async def _node_packs(request):
        key = len(sys.modules)
        if cache.get("key") != key:
            try:
                roots = custom_roots() if callable(custom_roots) else (custom_roots or _custom_roots())
                loop = asyncio.get_running_loop()
                m = await loop.run_in_executor(None, node_pack_map, roots)
                wd = web_dirs() if callable(web_dirs) else (web_dirs if web_dirs is not None else _web_dirs())
                if "widgets" not in cache or cache.get("wd") != sorted(wd):
                    cache.update(wd=sorted(wd), widgets=await loop.run_in_executor(None, widget_provider_packs, wd))
                m = dict(m)
                m[WIDGET_PROVIDERS_KEY] = cache["widgets"]
                cache.update(key=key, map=m)
            except Exception:
                logging.exception("[pocket] node-pack scan failed")
                return web.json_response({"error": "server error"}, status=503)
        return web.json_response(cache["map"], headers=NO_CACHE)

    @routes.get("/pocket/static/canvas/{path:.*}")
    async def _canvas_static(request):
        rel = request.match_info["path"]
        base = os.path.realpath(CANVAS_DIR)
        full = os.path.realpath(os.path.join(base, rel)) if rel and ":" not in rel and rel[0] not in "/\\" else None
        try:
            inside = bool(full) and os.path.commonpath([full, base]) == base
        except ValueError:
            inside = False
        if not inside or not os.path.isfile(full):
            raise web.HTTPNotFound()
        return web.FileResponse(full, headers=NO_CACHE)
