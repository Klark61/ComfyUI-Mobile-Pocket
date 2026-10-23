r"""Standalone dev server for the Pocket UI (no ComfyUI needed).

  python tests/dev_server.py [--port 8199] [--output DIR] [--user DIR] [--cache DIR] [--host 127.0.0.1] [--fake-comfy [--fake-step-ms 250]]

Serves /pocket/* via pocket.server_routes plus a /view handler (and /api/view) reading from the output dir.
"""
import argparse
import os
import sys
import tempfile

NODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, NODE_DIR)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp import web  # noqa: E402

from pocket import server_routes  # noqa: E402


def _combo(options):
    return [options]


OBJECT_INFO = {
    "KSampler": {"input": {"required": {
        "model": ["MODEL"],
        "seed": ["INT", {"default": 0, "min": 0, "max": 2 ** 64 - 1, "control_after_generate": True}],
        "steps": ["INT", {"default": 20, "min": 1, "max": 10000}],
        "cfg": ["FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01}],
        "sampler_name": _combo(["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_sde", "ddim"]),
        "scheduler": _combo(["normal", "karras", "simple", "beta"]),
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "latent_image": ["LATENT"],
        "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}]}}},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True, "dynamicPrompts": True}], "clip": ["CLIP"]}}},
    "EmptyLatentImage": {"input": {"required": {
        "width": ["INT", {"default": 512, "min": 16, "max": 16384, "step": 8}],
        "height": ["INT", {"default": 512, "min": 16, "max": 16384, "step": 8}],
        "batch_size": ["INT", {"default": 1, "min": 1, "max": 4096}]}}},
    "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": _combo(["fake.safetensors"] + [f"model_{i:02d}.safetensors" for i in range(30)])}}},
    # newer frontends describe combos as ["COMBO", {options: [...]}]
    "LoraLoader": {"input": {"required": {
        "model": ["MODEL"], "clip": ["CLIP"],
        "lora_name": ["COMBO", {"options": ["detail.safetensors", "style_a.safetensors", "style_b.safetensors"]}],
        "strength_model": ["FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}],
        "strength_clip": ["FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01}]}}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING", {"default": "ComfyUI"}]}}},
}

# Stand-in for the desktop frontend running at /?pocketconvert=1 (same postMessage protocol as web/ext/pocket_ext.js).
# The workflow's extra.stub_prompt is returned as the "converted" prompt; extra.stub_mode "error"/"timeout" simulates failures.
CONVERTER_STUB = """<!doctype html><meta charset=utf-8><title>converter stub</title><script>
const O = location.origin;
window.__loads = (Number(sessionStorage.getItem('stubLoads') || 0)) + 1; sessionStorage.setItem('stubLoads', String(window.__loads));
setTimeout(() => parent.postMessage({ type: 'ready' }, O), 700);
addEventListener('message', (ev) => {
  if (ev.source !== parent || ev.origin !== O) return;
  const m = ev.data;
  if (!m || m.type !== 'convert') return;
  const extra = (m.workflow && m.workflow.extra) || {};
  setTimeout(() => {
    if (extra.stub_mode === 'error') parent.postMessage({ type: 'convert_error', id: m.id, message: 'stub conversion failed' }, O);
    else if (extra.stub_mode === 'timeout') { parent.postMessage({ type: 'convert_error', id: m.id, message: 'conversion timed out' }, O); setTimeout(() => location.reload(), 300); }
    else parent.postMessage({ type: 'converted', id: m.id, prompt: extra.stub_prompt || {} }, O);
  }, 500);
});
</script>"""


def build_app(output_dir, user_dir, cache_dir, fake_comfy=False, step_ms=250, mirror=True, object_info_proxy=None):
    routes = web.RouteTableDef()
    app = web.Application()
    fake = None
    if fake_comfy:
        import fake_comfy as fc
        fake = fc.install(routes, app, output_dir, step_ms, mirror)
    server_routes.register(routes, output_dir, user_dir, cache_dir,
                           history_getter=fake.history_getter if fake else None,
                           history_item_getter=fake.history_item_getter if fake else None)

    @routes.get("/view")
    @routes.get("/api/view")
    async def view(request):
        name = request.query.get("filename", "")
        sub = request.query.get("subfolder", "")
        full = os.path.realpath(os.path.join(output_dir, sub, name))
        root = os.path.realpath(output_dir)
        if os.path.commonpath([full, root]) != root or not os.path.isfile(full):
            return web.Response(status=404)
        return web.FileResponse(full)

    @routes.get("/object_info/{cls}")
    async def object_info(request):
        cls = request.match_info["cls"]
        if cls in OBJECT_INFO:
            return web.json_response({cls: OBJECT_INFO[cls]})
        if object_info_proxy:  # read-only GET to a real ComfyUI
            import urllib.parse
            import aiohttp
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(object_info_proxy.rstrip("/") + "/object_info/" + urllib.parse.quote(cls, safe=""), timeout=aiohttp.ClientTimeout(total=10)) as r:
                        return web.json_response(await r.json(content_type=None), status=r.status)
            except Exception:
                pass
        return web.json_response({})

    @routes.get("/")
    async def root(request):
        if request.query.get("pocketconvert") == "1":
            return web.Response(text=CONVERTER_STUB, content_type="text/html")
        return web.Response(text="desktop UI stand-in", content_type="text/html")

    app.add_routes(routes)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--output", default=os.path.normpath(os.path.join(NODE_DIR, "..", "..", "output")))
    ap.add_argument("--user", default=None)
    ap.add_argument("--cache", default=None)
    ap.add_argument("--fake-comfy", action="store_true", help="emulate /ws, /queue, /api/jobs, /interrupt, /prompt (see tests/fake_comfy.py)")
    ap.add_argument("--fake-no-mirror", action="store_true", help="do not mirror foreign-job progress to cpocket- sockets")
    ap.add_argument("--fake-step-ms", type=int, default=250, help="fake sampler step duration")
    ap.add_argument("--object-info-proxy", default=None, help="fallback for /object_info/{class} not in the canned subset, e.g. http://127.0.0.1:8188 (read-only GET)")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="comfypocket_")
    user = a.user or os.path.join(tmp, "user")
    cache = a.cache or os.path.join(tmp, "cache")
    print(f"output={a.output} user={user} cache={cache}", flush=True)
    web.run_app(build_app(a.output, user, cache, a.fake_comfy, a.fake_step_ms, not a.fake_no_mirror, a.object_info_proxy), host=a.host, port=a.port, print=None)


if __name__ == "__main__":
    main()
