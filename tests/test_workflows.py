import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pocket.gallery import PathError  # noqa: E402
from pocket.workflows import Workflows, compact_history  # noqa: E402


class WorkflowsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.w = Workflows(self.tmp.name)
        os.makedirs(os.path.join(self.w.wf_dir, "sub"))
        self.write("a.json", 1000)
        self.write("sub/b.json", 2000)
        open(os.path.join(self.w.wf_dir, "note.txt"), "w").write("x")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, mtime):
        p = os.path.join(self.w.wf_dir, rel)
        with open(p, "w") as f:
            json.dump({"nodes": []}, f)
        os.utime(p, (mtime, mtime))

    def test_list_and_file(self):
        lst = self.w.list()
        self.assertEqual([x["path"] for x in lst], ["sub/b.json", "a.json"])
        self.assertEqual(lst[0]["name"], "b")
        self.assertFalse(lst[0]["has_snapshot"])
        self.assertEqual(self.w.read_workflow("a.json"), {"nodes": []})

    def test_path_safety(self):
        for bad in ("../x.json", "sub/../../x.json", "a.txt", "", os.path.abspath(__file__)):
            with self.assertRaises(PathError, msg=bad):
                self.w.wf_path(bad)
            with self.assertRaises(PathError, msg=bad):
                self.w.put_snapshot(bad, {"prompt": {}})
        for bad in ("../x", "a/b", ""):
            with self.assertRaises(PathError, msg=bad):
                self.w.get_preset(bad)

    def test_snapshot_lifecycle_and_stale(self):
        s = self.w.put_snapshot("sub/b.json", {"prompt": {"1": {}}, "workflow_mtime": None, "source": "desktop"})
        self.assertEqual(s["workflow_mtime"], 2000)
        self.assertEqual(s["source"], "desktop")
        got = self.w.get_snapshot("sub/b.json")
        self.assertFalse(got["stale"])
        self.assertEqual(got["prompt"], {"1": {}})
        item = [x for x in self.w.list() if x["path"] == "sub/b.json"][0]
        self.assertTrue(item["has_snapshot"])
        self.assertIsNotNone(item["snapshot_mtime"])
        self.write("sub/b.json", 3000)
        self.assertTrue(self.w.get_snapshot("sub/b.json")["stale"])
        self.assertTrue(self.w.delete_snapshot("sub/b.json"))
        self.assertFalse(self.w.delete_snapshot("sub/b.json"))
        with self.assertRaises(FileNotFoundError):
            self.w.get_snapshot("sub/b.json")
        with self.assertRaises(ValueError):
            self.w.put_snapshot("a.json", {"nope": 1})

    def test_presets(self):
        p = self.w.put_preset("p1", {"name": "My", "prompt": {"1": {}}, "fields": [{"node": "1", "input": "x", "label": "X"}],
                                     "source": "phone"})
        self.assertEqual(self.w.get_preset("p1"), p)
        self.assertEqual(self.w.list_presets()[0]["id"], "p1")
        self.assertTrue(self.w.delete_preset("p1"))
        self.assertFalse(self.w.delete_preset("p1"))

    def test_history(self):
        def entry(n, name, files):
            wf = {"name": name} if name else {}
            return {"prompt": (n, f"id{n}", {"1": {}}, {"extra_pnginfo": {"workflow": wf}}, []),
                    "outputs": {"9": {"images": files}},
                    "status": {"status_str": "success", "completed": True,
                               "messages": [["execution_start", {"timestamp": 1234 + n}]]}}
        h = {"id1": entry(1, "wfA", [{"filename": "a.png", "subfolder": "", "type": "output"}]),
             "id2": entry(2, None, [])}
        r = compact_history(h, 10)
        self.assertEqual([x["prompt_id"] for x in r], ["id2", "id1"])
        self.assertEqual(r[1]["workflow_name"], "wfA")
        self.assertIsNone(r[0]["workflow_name"])
        self.assertEqual(r[1]["outputs"][0]["filename"], "a.png")
        self.assertEqual(r[1]["ts"], 1235)
        self.assertEqual(len(compact_history(h, 1)), 1)

    def test_history_text_outputs(self):
        e = {"prompt": [1, "id", {"114": {"class_type": "PreviewAny", "_meta": {"title": "Final prompt"}, "inputs": {}}}, {}],
             "outputs": {"114": {"text": ["hello", "world"]}, "9": {"images": [{"filename": "a.png"}]}, "7": {"text": [""]}},
             "status": {"status_str": "success", "messages": []}}
        r = compact_history({"id": e}, 5)[0]
        self.assertEqual(r["texts"], [{"node": "114", "title": "Final prompt", "text": "hello\n\nworld"}])

    def test_unsafe_paths_and_mtime_validation(self):
        for bad in (chr(92) * 2 + "host" + chr(92) + "share" + chr(92) + "a.json", "C:" + chr(92) + "a.json", "a.json:ads", "/a.json"):
            with self.assertRaises(PathError, msg=bad):
                self.w.wf_path(bad)
        s = self.w.put_snapshot("a.json", {"prompt": {}, "workflow_mtime": "garbage"})
        self.assertEqual(s["workflow_mtime"], 1000)
        s = self.w.put_snapshot("a.json", {"prompt": {}, "workflow_mtime": 5})
        self.assertEqual(s["workflow_mtime"], 5.0)
        _write = __import__("pocket.workflows", fromlist=["_write_json"])._write_json
        _write(self.w._snap_path("a.json"), {"prompt": {}, "workflow_mtime": "x"})
        self.assertTrue(self.w.get_snapshot("a.json")["stale"])

    def test_history_ids_order_and_prompt_flag(self):
        p = os.path.join(self.w.wf_dir, "a.json")
        json.dump({"id": "uuid-1", "nodes": []}, open(p, "w"))
        ids = self.w.workflow_ids()
        self.assertEqual(ids, {"uuid-1": "a.json"})

        def entry(n, wid):
            return {"prompt": (n, f"id{n}", {"1": {}}, {"extra_pnginfo": {"workflow": {"id": wid, "name": "zz"}}}, []),
                    "outputs": {}, "status": {"status_str": "success"}}
        h = {"x": entry(5, "uuid-1"), "y": entry(-3, "other")}  # y front-queued (negative) but inserted later
        r = compact_history(h, 10, include_prompt=False, id_map=ids)
        self.assertEqual([x["prompt_id"] for x in r], ["y", "x"])
        self.assertNotIn("prompt", r[0])
        self.assertEqual((r[1]["workflow_name"], r[1]["workflow_path"]), ("a", "a.json"))
        self.assertEqual(r[0]["workflow_name"], "zz")
        self.assertIn("prompt", compact_history(h, 1, id_map=ids)[0])


if __name__ == "__main__":
    unittest.main()
