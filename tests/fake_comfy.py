r"""Fake ComfyUI execution backend for UI development (used by dev_server.py --fake-comfy).

Emulates, with the same payload shapes and the same client-targeting rules as ComfyUI 0.42 server.py/execution.py:
  GET  /ws?clientId=      JSON messages + binary preview frames (type 1 and type 4)
  GET  /queue, POST /queue {delete:[ids]} / {clear:true}
  POST /interrupt {prompt_id?}
  GET  /api/jobs, GET /api/jobs/{id}, POST /api/jobs/{id}/cancel, POST /api/jobs/cancel
  GET  /history, POST /prompt {prompt, client_id, extra_data}   (any input text == "__invalid__" -> 400 with node_errors)
Dev helpers:
  POST /fake/enqueue?n=1&client=<clientId>&fail=0&steps=20&name=Title
       client omitted -> job is "foreign": only broadcast frames (status, interrupted) reach websockets, exactly
       like a job queued from the desktop UI (real ComfyUI sends progress/preview/start/success to the queuing client only).
Jobs use an existing image from the output dir as their result (nothing is written to disk).
"""
import asyncio
import io
import json
import os
import struct
import time
import uuid
from collections import OrderedDict

from aiohttp import WSMsgType, web

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp")


def _now_ms():
    return int(time.time() * 1000)


def sample_prompt(steps=20, name="FakeFlow", seed=None):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "_meta": {"title": "Load Model"}, "inputs": {"ckpt_name": "fake.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "_meta": {"title": "Positive Prompt"}, "inputs": {"text": "a cat in a spacesuit", "clip": ["1", 1]}},
        "3": {"class_type": "EmptyLatentImage", "_meta": {"title": "Canvas"}, "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "4": {"class_type": "KSampler", "_meta": {"title": "Sampler"}, "inputs": {"seed": seed or 1, "steps": steps, "cfg": 5}},
        "5": {"class_type": "VAEDecode", "_meta": {"title": "Decode"}, "inputs": {}},
        "6": {"class_type": "SaveImage", "_meta": {"title": "Save Image"}, "inputs": {"filename_prefix": name}},
    }


class FakeComfy:
    def __init__(self, output_dir, step_ms=250, mirror=True):
        self.mirror = mirror       # emulate the backend mirror to "cpocket-" sockets (progress/previews of foreign jobs)
        self.output_dir = output_dir
        self.step_ms = step_ms
        self.number = 0
        self.pending = []          # (number, pid, prompt, extra, outs)
        self.running = None
        self.history = OrderedDict()
        self.sockets = {}
        self.interrupt = False
        self.wake = asyncio.Event()
        self.opts = {}             # pid -> {"fail": bool}

    # ---- transport
    async def _send_ws(self, ws, kind, payload):
        try:
            if kind == "json":
                await ws.send_json(payload)
            else:
                await ws.send_bytes(payload)
        except Exception:
            pass

    def _dests(self, sid, everyone):
        """everyone=True -> broadcast. Otherwise only the queuing client, plus (when mirroring, like the mobile backend does)
        every socket whose clientId starts with "cpocket-"."""
        out = []
        for s, ws in list(self.sockets.items()):
            if everyone or s == sid or (self.mirror and s.startswith("cpocket-")):
                out.append(ws)
        return out

    async def send_json(self, event, data, sid=None, everyone=True):
        msg = {"type": event, "data": data}
        for ws in self._dests(sid, everyone):
            await self._send_ws(ws, "json", msg)

    async def send_bytes(self, event, body, sid=None, everyone=True):
        frame = struct.pack(">I", event) + body
        for ws in self._dests(sid, everyone):
            await self._send_ws(ws, "bytes", frame)

    async def status(self):
        n = len(self.pending) + (1 if self.running else 0)
        await self.send_json("status", {"status": {"exec_info": {"queue_remaining": n}}})

    def preview_png(self, step, steps):
        from PIL import Image, ImageDraw
        im = Image.new("RGB", (160, 160), (30 + step * 8 % 200, 20, 90))
        d = ImageDraw.Draw(im)
        for i in range(0, 160, 16):
            d.line([(i, 0), (160 - i, 160)], fill=(120 + step * 6 % 130, 80 + i, 255 - i), width=3)
        d.rectangle([4, 150, 4 + int(152 * step / max(1, steps)), 156], fill=(255, 255, 255))
        buf = io.BytesIO()
        fmt = "PNG" if step % 2 else "JPEG"
        im.save(buf, format=fmt)
        return fmt, buf.getvalue()

    # ---- queue ops
    def enqueue(self, prompt, client_id=None, fail=False, extra=None):
        pid = str(uuid.uuid4())
        self.number += 1
        extra = dict(extra or {})
        if client_id:
            extra["client_id"] = client_id
        extra["create_time"] = _now_ms()
        self.pending.append((self.number, pid, prompt, extra, ["6"]))
        self.opts[pid] = {"fail": fail}
        self.wake.set()
        asyncio.get_event_loop().create_task(self.status())
        return pid

    def find_output(self):
        best = None
        for root, dirs, files in os.walk(self.output_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f.lower().endswith(IMG_EXT):
                    p = os.path.join(root, f)
                    m = os.path.getmtime(p)
                    if best is None or m > best[0]:
                        best = (m, p)
        if not best:
            return {"filename": "missing.png", "subfolder": "", "type": "output"}
        rel = os.path.relpath(best[1], self.output_dir).replace(os.sep, "/")
        sub, _, name = rel.rpartition("/")
        return {"filename": name, "subfolder": sub, "type": "output"}

    # ---- execution
    async def worker(self):
        while True:
            if not self.pending:
                self.wake.clear()
                await self.wake.wait()
                continue
            self.pending.sort(key=lambda i: i[0])
            item = self.pending.pop(0)
            self.running = item
            self.interrupt = False
            try:
                await self.run(item)
            except Exception as e:  # keep the worker alive
                print("fake worker error", repr(e), flush=True)
            finally:
                self.running = None
                await self.status()

    async def run(self, item):
        number, pid, prompt, extra, outs = item
        sid = extra.get("client_id")  # None -> broadcast, like ComfyUI when no client_id
        targeted = sid is not None or self.mirror  # who can see detail frames
        msgs = []

        async def emit(event, data, broadcast=False, mem=True):
            data = {**data, "timestamp": _now_ms()}
            if mem:
                msgs.append([event, data])
            if targeted or broadcast:
                await self.send_json(event, data, sid, everyone=broadcast)

        steps = int(prompt.get("4", {}).get("inputs", {}).get("steps", 20))
        fail = self.opts.get(pid, {}).get("fail")
        await emit("execution_start", {"prompt_id": pid})
        await self.status()
        cached = ["1"]
        await emit("execution_cached", {"nodes": cached, "prompt_id": pid})
        states = {n: {"value": 0, "max": 1, "state": "pending", "node_id": n, "prompt_id": pid, "display_node_id": n, "parent_node_id": None, "real_node_id": n} for n in prompt}
        for n in cached:
            states[n]["state"] = "finished"
            states[n]["value"] = 1

        async def pstate():
            if targeted:
                nodes = {k: v for k, v in states.items() if v["state"] != "pending"}
                await self.send_json("progress_state", {"prompt_id": pid, "nodes": nodes}, sid, everyone=False)

        status_str, completed, result = "success", True, None
        for node in ["2", "3", "4", "5", "6"]:
            if targeted:
                await self.send_json("executing", {"node": node, "display_node": node, "prompt_id": pid}, sid, everyone=False)
            states[node]["state"] = "running"
            await pstate()
            if node == "4":
                for step in range(1, steps + 1):
                    if self.interrupt:
                        break
                    await asyncio.sleep(self.step_ms / 1000)
                    states[node]["value"] = step
                    states[node]["max"] = steps
                    if targeted:
                        await self.send_json("progress", {"value": step, "max": steps, "prompt_id": pid, "node": node}, sid, everyone=False)
                        await pstate()
                        fmt, img = self.preview_png(step, steps)
                        if step % 3 == 0:  # legacy frame: u32 image type + bytes
                            await self.send_bytes(1, struct.pack(">I", 2 if fmt == "PNG" else 1) + img, sid, everyone=False)
                        else:              # type 4: u32 metadata length + metadata json + bytes
                            meta = json.dumps({"node_id": node, "prompt_id": pid, "display_node_id": node, "parent_node_id": None,
                                               "real_node_id": node, "image_type": "image/png" if fmt == "PNG" else "image/jpeg"}).encode()
                            await self.send_bytes(4, struct.pack(">I", len(meta)) + meta + img, sid, everyone=False)
                    if fail and step == max(2, steps // 3):
                        raise_error = True
                        status_str, completed = "error", False
                        await emit("execution_error", {"prompt_id": pid, "node_id": node, "node_type": "KSampler", "executed": [],
                                                       "exception_message": "CUDA out of memory (fake)", "exception_type": "torch.OutOfMemoryError",
                                                       "traceback": ["fake"], "current_inputs": {}, "current_outputs": []})
                        break
                if status_str == "error":
                    break
                if self.interrupt:
                    status_str, completed = "error", False
                    await emit("execution_interrupted", {"prompt_id": pid, "node_id": node, "node_type": "KSampler", "executed": []}, broadcast=True)
                    break
            else:
                await asyncio.sleep(self.step_ms / 1000 * 1.5)
            states[node]["state"] = "finished"
            if node == "6":
                result = self.find_output()
                if targeted:
                    await self.send_json("executed", {"node": node, "display_node": node, "output": {"images": [result]}, "prompt_id": pid}, sid, everyone=False)
            await pstate()
        if status_str == "success":
            await emit("execution_success", {"prompt_id": pid})
        self.history[pid] = {
            "prompt": [number, pid, prompt, extra, outs],
            "outputs": {"6": {"images": [result]}} if result and status_str == "success" else {},
            "status": {"status_str": status_str, "completed": completed, "messages": msgs},
        }

    # ---- job shapes
    def job_dict(self, pid, full=False):
        if self.running and self.running[1] == pid:
            it, st = self.running, "in_progress"
        else:
            it = next((p for p in self.pending if p[1] == pid), None)
            st = "pending"
        if it:
            return {"id": pid, "status": st, "priority": it[0], "create_time": it[3].get("create_time"), "outputs_count": 0, "previewable_outputs_count": 0}
        h = self.history.get(pid)
        if not h:
            return None
        msgs = h["status"]["messages"]
        start = next((m[1]["timestamp"] for m in msgs if m[0] == "execution_start"), None)
        end = msgs[-1][1]["timestamp"] if msgs else None
        err = next((m[1] for m in msgs if m[0] == "execution_error"), None)
        interrupted = any(m[0] == "execution_interrupted" for m in msgs)
        status = "completed" if h["status"]["status_str"] == "success" else ("cancelled" if interrupted else "failed")
        n = sum(len(v.get("images", [])) for v in h["outputs"].values())
        job = {"id": pid, "status": status, "priority": h["prompt"][0], "create_time": h["prompt"][3].get("create_time"),
               "execution_start_time": start, "execution_end_time": end, "outputs_count": n, "previewable_outputs_count": n}
        if err:
            job["execution_error"] = err
        if full:
            job["outputs"] = h["outputs"]
        return job

    def all_jobs(self):
        ids = ([self.running[1]] if self.running else []) + [p[1] for p in self.pending] + list(self.history)
        jobs = [self.job_dict(i) for i in ids]
        return sorted([j for j in jobs if j], key=lambda j: j.get("create_time") or 0, reverse=True)

    def history_getter(self, limit):
        return OrderedDict(list(self.history.items())[-limit:])

    def history_item_getter(self, pid):
        return OrderedDict([(pid, self.history[pid])]) if pid in self.history else {}

    def cancel(self, pid):
        if self.running and self.running[1] == pid:
            self.interrupt = True
            return True
        n = len(self.pending)
        self.pending = [p for p in self.pending if p[1] != pid]
        return len(self.pending) != n


def install(routes, app, output_dir, step_ms=250, mirror=True):
    f = FakeComfy(output_dir, step_ms, mirror)

    async def start(app_):
        app_["fake_worker"] = asyncio.get_event_loop().create_task(f.worker())

    async def stop(app_):
        app_["fake_worker"].cancel()

    app.on_startup.append(start)
    app.on_cleanup.append(stop)

    @routes.get("/ws")
    async def ws_handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        sid = request.query.get("clientId") or uuid.uuid4().hex
        f.sockets[sid] = ws
        n = len(f.pending) + (1 if f.running else 0)
        await ws.send_json({"type": "status", "data": {"status": {"exec_info": {"queue_remaining": n}}, "sid": sid}})
        try:
            async for m in ws:
                if m.type == WSMsgType.TEXT:
                    try:
                        j = json.loads(m.data)
                    except ValueError:
                        continue
                    if j.get("type") == "feature_flags":
                        await ws.send_json({"type": "feature_flags", "data": {"supports_preview_metadata": True}})
        finally:
            if f.sockets.get(sid) is ws:
                del f.sockets[sid]
        return ws

    def strip(item):
        return list(item[:5])

    @routes.get("/queue")
    async def queue(request):
        return web.json_response({"queue_running": [strip(f.running)] if f.running else [], "queue_pending": [strip(p) for p in f.pending]})

    @routes.post("/queue")
    async def queue_post(request):
        j = await request.json()
        if j.get("clear"):
            f.pending.clear()
        for pid in j.get("delete", []):
            f.pending = [p for p in f.pending if p[1] != pid]
        await f.status()
        return web.Response(status=200)

    @routes.post("/interrupt")
    async def interrupt(request):
        try:
            j = await request.json()
        except ValueError:
            j = {}
        pid = j.get("prompt_id")
        if f.running and (not pid or pid == f.running[1]):
            f.interrupt = True
        return web.Response(status=200)

    @routes.get("/api/jobs")
    async def jobs(request):
        jobs_ = f.all_jobs()
        st = request.query.get("status")
        if st:
            want = {s.strip() for s in st.split(",")}
            jobs_ = [j for j in jobs_ if j["status"] in want]
        total = len(jobs_)
        off = int(request.query.get("offset", 0))
        lim = request.query.get("limit")
        jobs_ = jobs_[off:] if not lim else jobs_[off:off + int(lim)]
        return web.json_response({"jobs": jobs_, "pagination": {"offset": off, "limit": int(lim) if lim else None, "total": total, "has_more": off + len(jobs_) < total}})

    @routes.get("/api/jobs/{job_id}")
    async def job(request):
        j = f.job_dict(request.match_info["job_id"], full=True)
        return web.json_response(j) if j else web.json_response({"error": "Job not found"}, status=404)

    @routes.post("/api/jobs/{job_id}/cancel")
    async def job_cancel(request):
        c = f.cancel(request.match_info["job_id"])
        await f.status()
        return web.json_response({"cancelled": c})

    @routes.post("/api/jobs/cancel")
    async def jobs_cancel(request):
        j = await request.json()
        c = any([f.cancel(i) for i in j.get("job_ids", [])])
        await f.status()
        return web.json_response({"cancelled": c})

    @routes.get("/history")
    async def history(request):
        return web.json_response(f.history)

    @routes.post("/prompt")
    async def prompt(request):
        j = await request.json()
        bad = [k for k, n in (j.get("prompt") or {}).items() if isinstance(n, dict) and (n.get("inputs") or {}).get("text") == "__invalid__"]
        if bad:  # test hook: ComfyUI-shaped validation failure
            return web.json_response({
                "error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", "details": "", "extra_info": {}},
                "node_errors": {k: {"errors": [{"type": "value_not_in_list", "message": "Value not in list", "details": "text: '__invalid__' not allowed (fake)", "extra_info": {}}],
                                    "dependent_outputs": ["6"], "class_type": j["prompt"][k].get("class_type")} for k in bad},
            }, status=400)
        pid = f.enqueue(j["prompt"], j.get("client_id"), extra=j.get("extra_data"))
        return web.json_response({"prompt_id": pid, "number": f.number, "node_errors": {}})

    @routes.post("/fake/enqueue")
    async def fake_enqueue(request):
        q = request.query
        ids = []
        for _ in range(int(q.get("n", 1))):
            ids.append(f.enqueue(sample_prompt(int(q.get("steps", 20)), q.get("name", "FakeFlow")), q.get("client") or None, fail=q.get("fail") == "1"))
        return web.json_response({"ids": ids})

    return f
