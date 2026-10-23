import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

from pocket import canvas, server_routes  # noqa: E402

INDEX = '<!doctype html><html><head><link rel="stylesheet" href="user.css"><script type="module" src="./assets/a.js"></script></head><body></body></html>'


class CanvasRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "static")
        os.makedirs(self.root)
        with open(os.path.join(self.root, "index.html"), "w", encoding="utf-8") as f:
            f.write(INDEX)
        routes = web.RouteTableDef()
        server_routes.register(routes, os.path.join(self.tmp.name, "out"), os.path.join(self.tmp.name, "user"),
                               os.path.join(self.tmp.name, "cache"), frontend_root=lambda: self.root)
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    async def test_index_is_rewritten_and_read_per_request(self):
        r = await self.client.get("/pocket/canvas")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.headers["Cache-Control"], "no-cache")
        html = await r.text()
        head = html.index("<head>") + len("<head>")
        self.assertTrue(html[head:].startswith('<base href="/"><script src="/pocket/static/canvas/boot.js"></script>'))
        self.assertLess(html.index("boot.js"), html.index("assets/a.js"))
        self.assertIn('canvas.css"></head>', html)
        with open(os.path.join(self.root, "index.html"), "w", encoding="utf-8") as f:
            f.write(INDEX.replace("a.js", "b.js"))
        self.assertIn("assets/b.js", await (await self.client.get("/pocket/canvas/")).text())

    async def test_missing_frontend_is_503(self):
        os.remove(os.path.join(self.root, "index.html"))
        self.assertEqual((await self.client.get("/pocket/canvas")).status, 503)

    async def test_canvas_static_served_and_confined(self):
        r = await self.client.get("/pocket/static/canvas/boot.js")
        self.assertEqual(r.status, 200)
        self.assertIn("canvasBoot", await r.text())
        self.assertEqual((await self.client.get("/pocket/static/canvas/../pocket/index.html")).status, 404)
        self.assertEqual((await self.client.get("/pocket/static/canvas/nope.js")).status, 404)

    def test_widget_provider_packs(self):
        a = os.path.join(self.tmp.name, "w", "a")
        b = os.path.join(self.tmp.name, "w", "b")
        os.makedirs(os.path.join(a, "js"))
        os.makedirs(b)
        with open(os.path.join(a, "js", "x.js"), "w", encoding="utf-8") as f:
            f.write("app.registerExtension({ name: 'x', getCustomWidgets() { return { COLOR: 1 } } })")
        with open(os.path.join(b, "y.js"), "w", encoding="utf-8") as f:
            f.write("app.registerExtension({ name: 'y' })")
        self.assertEqual(canvas.widget_provider_packs({"a": a, "b": b, "gone": os.path.join(self.tmp.name, "none")}), ["a"])

    async def test_node_pack_map(self):
        import types
        root = os.path.join(self.tmp.name, "custom_nodes")
        mk = lambda folder, keys: types.SimpleNamespace(__file__=os.path.join(root, folder, "__init__.py"), NODE_CLASS_MAPPINGS={k: object for k in keys})
        mods = {"orig": mk("Orig-Pack", ["A", "B"]), "wrap": mk("workflow-encrypt", ["A", "C"]),
                "sub": types.SimpleNamespace(__file__=os.path.join(root, "Orig-Pack", "nodes.py"), NODE_CLASS_MAPPINGS={"D": object}),
                "single": types.SimpleNamespace(__file__=os.path.join(root, "single.py"), NODE_CLASS_MAPPINGS={"E": object}),
                "core": types.SimpleNamespace(__file__=os.path.join(self.tmp.name, "nodes.py"), NODE_CLASS_MAPPINGS={"F": object}),
                "nomap": types.SimpleNamespace(__file__=os.path.join(root, "x", "__init__.py"))}
        m = canvas.node_pack_map([root], mods)
        self.assertEqual(m, {"A": ["Orig-Pack", "workflow-encrypt"], "B": ["Orig-Pack"], "C": ["workflow-encrypt"], "D": ["Orig-Pack"]})

    def test_rewrite_needs_head(self):
        with self.assertRaises(ValueError):
            canvas.rewrite_index("<html></html>")


if __name__ == "__main__":
    unittest.main()
