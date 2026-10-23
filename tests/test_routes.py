import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from pocket import gallery, server_routes  # noqa: E402
from pocket.workflows import compact_history  # noqa: E402


class RoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        web_dir = os.path.join(self.tmp.name, "web")
        os.makedirs(os.path.join(web_dir, "vendor"))
        for rel in ("app.js", "vendor/p.js"):
            with open(os.path.join(web_dir, rel), "w") as f:
                f.write("x")
        patcher = mock.patch.object(server_routes, "WEB_DIR", web_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        routes = web.RouteTableDef()
        server_routes.register(routes, os.path.join(self.tmp.name, "out"), os.path.join(self.tmp.name, "user"),
                               os.path.join(self.tmp.name, "cache"))
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def test_static_cache_headers(self):
        r = await self.client.get("/pocket/static/app.js")
        self.assertEqual((r.status, r.headers["Cache-Control"]), (200, "no-cache"))
        self.assertIn("ETag", r.headers)
        r = await self.client.get("/pocket/static/vendor/p.js")
        self.assertEqual(r.headers["Cache-Control"], "public, max-age=31536000, immutable")
        with mock.patch("os.path.commonpath", side_effect=ValueError("different drives")):
            self.assertEqual((await self.client.get("/pocket/static/app.js")).status, 404)
        for bad in ("../x", "nope.js", "..%2f..%2fetc"):
            self.assertEqual((await self.client.get("/pocket/static/" + bad)).status, 404)

    async def test_bad_bodies_400(self):
        r = await self.client.post("/pocket/api/favorite", json=[1])
        self.assertEqual(r.status, 400)

    async def test_non_json_content_type_415(self):
        for path in ("/pocket/api/favorite", "/pocket/api/delete", "/pocket/api/trash/restore"):
            r = await self.client.post(path, data='{"paths": []}', headers={"Content-Type": "text/plain"})
            self.assertEqual(r.status, 415, path)
        r = await self.client.put("/pocket/api/presets?id=a", data="{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(r.status, 415)
        r = await self.client.post("/pocket/api/delete", data='{"paths": []}',
                                   headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(r.status, 200)

    async def test_delete_refuses_json_and_trash_roundtrip(self):
        out = os.path.join(self.tmp.name, "out")
        os.makedirs(out, exist_ok=True)
        from PIL import Image
        Image.new("RGB", (8, 8)).save(os.path.join(out, "a.png"))
        with open(os.path.join(out, "w.json"), "w") as f:
            f.write("{}")
        r = await self.client.post("/pocket/api/delete", json={"paths": ["w.json", "a.png"]})
        body = await r.json()
        self.assertEqual((body["deleted"], len(body["errors"])), (["a.png"], 1))
        self.assertTrue(os.path.exists(os.path.join(out, "w.json")))
        items = (await (await self.client.get("/pocket/api/trash")).json())["items"]
        self.assertEqual([i["rel"] for i in items], ["a.png"])
        r = await self.client.post("/pocket/api/trash/restore", json={"ids": [items[0]["id"]]})
        self.assertEqual((await r.json())["restored"], ["a.png"])
        self.assertTrue(os.path.exists(os.path.join(out, "a.png")))
        await self.client.post("/pocket/api/delete", json={"paths": ["a.png"]})
        items = (await (await self.client.get("/pocket/api/trash")).json())["items"]
        r = await self.client.post("/pocket/api/trash/purge", json={"ids": [items[0]["id"]]})
        self.assertEqual((await r.json())["purged"], [items[0]["id"]])

    async def test_unsupported_image_415(self):
        out = os.path.join(self.tmp.name, "out")
        os.makedirs(out, exist_ok=True)
        from PIL import Image
        Image.new("RGB", (8, 8)).save(os.path.join(out, "t.png"), "TIFF")
        r = await self.client.get("/pocket/api/thumb?path=t.png&s=256")
        self.assertEqual(r.status, 415)

    async def test_corrupt_image_and_invalid_names(self):
        out = os.path.join(self.tmp.name, "out")
        os.makedirs(os.path.join(out, "d.png"), exist_ok=True)
        from PIL import Image
        Image.new("RGB", (64, 64), "red").save(os.path.join(out, "c.png"))
        data = open(os.path.join(out, "c.png"), "rb").read()
        open(os.path.join(out, "c.png"), "wb").write(data[:len(data) // 2])
        self.assertEqual((await self.client.get("/pocket/api/thumb?path=c.png")).status, 415)
        for q in ("d.png", "a*.png", "a%3F.png"):
            r = await self.client.get("/pocket/api/thumb?path=" + q)
            self.assertIn(r.status, (400, 404, 415), q)
        r = await self.client.get("/pocket/api/workflows/file?path=a*.json")
        self.assertIn(r.status, (400, 404))

    async def test_error_bodies_have_no_paths(self):
        r = await self.client.get("/pocket/api/thumb?path=missing.png")
        text = await r.text()
        self.assertIn(r.status, (400, 404))
        self.assertNotIn(":\\", text)
        self.assertNotIn(self.tmp.name, text)
        with mock.patch.object(gallery.Gallery, "meta", side_effect=PermissionError("C:\\secret\\dir\\x.png")):
            r = await self.client.get("/pocket/api/meta?path=a.png")
        text = await r.text()
        self.assertEqual((r.status, json.loads(text)["error"]), (500, "server error"))
        self.assertNotIn(":\\", text)
        self.assertNotIn("/", text.replace("</", ""))
        self.assertNotIn("secret", text)


class MiscTest(unittest.TestCase):
    def test_atomic_write_retries_then_raises(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "a.json")
            open(target, "w").close()
            calls = []
            real = os.replace

            def flaky(a, b):
                calls.append(1)
                if len(calls) < 3:
                    raise PermissionError("busy")
                return real(a, b)
            with mock.patch("os.replace", flaky):
                gallery.atomic_write(target, lambda t: open(t, "w").write("new"))
            self.assertEqual(open(target).read(), "new")
            with mock.patch("os.replace", side_effect=PermissionError("busy")):
                with self.assertRaises(PermissionError):
                    gallery.atomic_write(target, lambda t: open(t, "w").write("z"))
                gallery.atomic_write(target, lambda t: open(t, "w").write("z"), tolerate_existing=True)

    def test_history_nonhashable_workflow_id(self):
        h = {"a": {"prompt": (1, "a", {}, {"extra_pnginfo": {"workflow": {"id": ["x"], "name": "n"}}}, []),
                   "outputs": {}, "status": {}}}
        r = compact_history(h, 5, id_map={"k": "a.json"})
        self.assertEqual((len(r), r[0]["workflow_name"]), (1, "n"))

    def test_anima_style_prompt(self):
        s = gallery.summarize_prompt({
            "12": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality, low quality, ugly", "clip": ["80", 0]}},
            "300": {"class_type": "easy positive", "inputs": {"positive": "a cat, best quality"}},
            "227": {"class_type": "CLIPTextEncode", "inputs": {"text": ["300", 0], "clip": ["80", 0]}},
            "82": {"class_type": "CFGGuider", "inputs": {"cfg": 1.3, "model": ["65", 0], "positive": ["227", 0],
                                                         "negative": ["12", 0]}},
            "83": {"class_type": "RandomNoise", "inputs": {"noise_seed": 320886544826738}},
            "238": {"class_type": "KSampler", "inputs": {"seed": 90693485027370, "steps": 20, "cfg": 4,
                                                        "sampler_name": "euler", "scheduler": "beta",
                                                        "positive": ["227", 0], "negative": ["12", 0]}},
            "75": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["82", 0], "noise": ["83", 0]}},
        })
        self.assertEqual(s["positive"], "a cat, best quality")
        self.assertEqual(s["negative"], "worst quality, low quality, ugly")

    def test_loader_holding_both_texts(self):
        s = gallery.summarize_prompt({
            "4": {"class_type": "Efficient Loader", "inputs": {"positive": "pos text", "negative": "neg text"}},
            "5": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 5, "cfg": 2, "positive": ["4", 1],
                                                     "negative": ["4", 2]}},
        })
        self.assertEqual((s["positive"], s["negative"]), ("pos text", "neg text"))


if __name__ == "__main__":
    unittest.main()
