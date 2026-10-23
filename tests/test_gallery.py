import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image, PngImagePlugin  # noqa: E402

from pocket.gallery import Gallery, PathError, UnsupportedImage, snap_size  # noqa: E402

def uuid_hex(c):
    return c * 32


PROMPT = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
    "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["1", 1]}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["1", 1]}},
    "4": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 8, "cfg": 1.5, "sampler_name": "euler",
                                               "scheduler": "simple", "positive": ["2", 0], "negative": ["3", 0],
                                               "model": ["1", 0], "latent_image": ["5", 0]}},
    "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 512, "height": 768, "batch_size": 1}},
}


class GalleryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.out = os.path.join(base, "output")
        self.user = os.path.join(base, "user")
        self.cache = os.path.join(base, "cache")
        os.makedirs(os.path.join(self.out, "sub"))
        os.makedirs(os.path.join(self.out, ".hidden"))
        for i in range(5):
            self.img(f"i{i}.png", i)
        self.img("sub/s.png", 10)
        self.img(".hidden/h.png", 20)
        open(os.path.join(self.out, "v.mp4"), "wb").write(b"x")
        os.utime(os.path.join(self.out, "v.mp4"), (1_700_000_000, 1_700_000_000))
        open(os.path.join(self.out, "notes.txt"), "w").write("x")
        self.g = Gallery(self.out, self.user, self.cache)

    def tearDown(self):
        self.tmp.cleanup()

    def img(self, rel, age, prompt=None):
        p = os.path.join(self.out, rel)
        im = Image.new("RGB", (64, 48), "red")
        pnginfo = None
        if prompt:
            pnginfo = PngImagePlugin.PngInfo()
            pnginfo.add_text("prompt", json.dumps(prompt))
        im.save(p, pnginfo=pnginfo)
        t = 1_700_000_000 + age
        os.utime(p, (t, t))
        return p

    def test_listing_and_pagination(self):
        r = self.g.list(limit=3)
        self.assertEqual(r["total"], 7)  # 5 + sub + mp4; hidden and txt skipped
        self.assertEqual(len(r["items"]), 3)
        self.assertEqual(r["items"][0]["path"], "sub/s.png")
        self.assertEqual(r["folders"], ["sub"])
        r2 = self.g.list(offset=3, limit=10)
        self.assertEqual(len(r2["items"]), 4)
        self.assertEqual(len(self.g.list(kind="video")["items"]), 1)
        self.assertEqual(self.g.list(folder="sub")["total"], 1)
        self.assertEqual(self.g.list(q="i3")["total"], 1)

    def test_traversal_rejected(self):
        for bad in ("../x.png", "sub/../../x.png", os.path.abspath(__file__), ".hidden/h.png", ""):
            with self.assertRaises(PathError, msg=bad):
                self.g.resolve(bad)

    def test_thumb_cache(self):
        out = self.g.thumb("i1.png", 32)
        self.assertTrue(out.endswith(".webp"))
        with Image.open(out) as im:
            self.assertEqual(im.format, "WEBP")
            self.assertLessEqual(max(im.size), 256)
        m = os.path.getmtime(out)
        self.assertEqual(self.g.thumb("i1.png", 32), out)
        self.assertEqual(os.path.getmtime(out), m)
        self.assertIsNone(self.g.thumb("v.mp4"))

    def test_meta(self):
        self.img("p.png", 30, PROMPT)
        m = self.g.meta("p.png")
        self.assertTrue(m["has_prompt"])
        s = m["summary"]
        self.assertEqual((s["positive"], s["negative"], s["seed"], s["steps"]), ("a cat", "blurry", 42, 8))
        self.assertEqual((s["cfg"], s["sampler"], s["scheduler"], s["model"]), (1.5, "euler", "simple", "m.safetensors"))
        self.assertEqual((s["width"], s["height"]), (512, 768))
        self.assertFalse(self.g.meta("i0.png")["has_prompt"])

    def test_delete_to_trash(self):
        self.g.set_favorite("sub/s.png", True)
        r = self.g.delete(["sub/s.png", "../evil"])
        self.assertEqual(r["deleted"], ["sub/s.png"])
        self.assertEqual(len(r["errors"]), 1)
        self.assertFalse(os.path.exists(os.path.join(self.out, ".trash")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "sub", "s.png")))
        self.assertEqual(self.g.list()["total"], 6)
        self.assertEqual([i["rel"] for i in self.g.trash_list()["items"]], ["sub/s.png"])

    def test_trash_id_and_path_validation(self):
        self.g.delete(["i1.png"])
        tid = next(iter(self.g._load_trash()))
        ent = {"rel": "i1.png"}
        self.assertTrue(self.g._trash_path(tid, ent).startswith(self.g.trash_files))
        for bad in ("../x", "..\\x", tid[:-1], tid.upper(), "", None):
            with self.assertRaises(PathError):
                self.g._trash_path(bad, ent)
        with self.assertRaises(PathError):
            self.g._trash_path(tid, {"rel": "x.txt"})
        # tampered index entries cannot restore outside output, into hidden dirs, or to non-media
        idx = self.g._load_trash()
        idx[tid]["rel"] = "../evil.png"
        idx[uuid_hex("a")] = {"rel": ".hidden/h.png", "deleted": 1}
        idx[uuid_hex("b")] = {"rel": "C:/x.png", "deleted": 1}
        self.g._save_trash(idx)
        r = self.g.restore([tid, uuid_hex("a"), uuid_hex("b")])
        self.assertEqual(r["restored"], [])
        self.assertEqual(len(r["errors"]), 3)

    def test_corrupt_index_not_clobbered(self):
        self.g.delete(["i1.png"])
        with open(self.g.trash_index, "w") as f:
            f.write("{trunc")
        r = self.g.delete(["i2.png"])
        self.assertEqual(r["deleted"], [])
        self.assertTrue(os.path.exists(os.path.join(self.out, "i2.png")))
        with open(self.g.trash_index) as f:
            self.assertEqual(f.read(), "{trunc")
        with self.assertRaises(OSError):
            self.g.trash_list()

    def test_trash_add_rolls_back_on_failed_move(self):
        src = os.path.join(self.out, "i2.png")
        idx = {}
        with mock.patch("pocket.gallery.shutil.move", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                self.g._trash_add(idx, src, "i2.png")
        self.assertEqual((idx, self.g._load_trash()), ({}, {}))
        self.assertTrue(os.path.exists(src))
        with mock.patch.object(Gallery, "_save_trash", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                self.g._trash_add(idx, src, "i2.png")
        self.assertTrue(os.path.exists(src))
        self.assertEqual(idx, {})

    def test_migrate_skips_hidden_and_non_media(self):
        old = os.path.join(self.out, ".trash")
        os.makedirs(os.path.join(old, ".sec"))
        os.makedirs(os.path.join(old, "ok"))
        for rel in (".sec/a.png", "ok/note.txt", "ok/b.png"):
            open(os.path.join(old, rel), "wb").write(b"x")
        self.assertEqual(self.g.migrate_old_trash(), 1)
        self.assertTrue(os.path.exists(os.path.join(old, ".sec", "a.png")))
        self.assertTrue(os.path.exists(os.path.join(old, "ok", "note.txt")))
        self.assertEqual([i["rel"] for i in self.g.trash_list()["items"]], ["ok/b.png"])

    def test_corrupt_image_is_unsupported(self):
        p = os.path.join(self.out, "bad.png")
        with open(os.path.join(self.out, "i0.png"), "rb") as f:
            data = f.read()
        with open(p, "wb") as f:
            f.write(data[:len(data) // 2])
        with self.assertRaises(UnsupportedImage):
            self.g.thumb("bad.png")

    def test_invalid_names_are_patherror(self):
        for bad in ("a*.png", "a?.png", "a<b.png"):
            with self.assertRaises((PathError, OSError)):
                self.g.thumb(bad)

    def test_delete_clears_favorite_with_canonical_path(self):
        self.g.set_favorite("sub/s.png", True)
        self.g.delete(["sub/s.png"])
        self.assertEqual(self.g._load_favs(), set())

    def test_prune_keeps_just_written(self):
        os.makedirs(self.g.thumb_dir)
        a, b = (os.path.join(self.g.thumb_dir, n) for n in ("a.webp", "b.webp"))
        for p in (a, b):
            open(p, "wb").write(b"x" * 100)
        os.utime(a, (1, 1))
        self.g.thumb_cache_bytes = 0
        self.g.prune_thumbs(keep=a)
        self.assertTrue(os.path.exists(a))
        self.assertFalse(os.path.exists(b))

    def test_scan_discards_result_when_mutated_mid_scan(self):
        real = os.scandir
        g = self.g

        def racing(path):
            g._invalidate()
            return real(path)
        with mock.patch("pocket.gallery.os.scandir", side_effect=racing):
            g._scan()
        self.assertIsNone(g._sig)

    def test_snap_size(self):
        self.assertEqual([snap_size(x) for x in (1, 32, 256, 257, 384, 500, 768, 1000, 1536, 99999, "x")],
                         [256, 256, 256, 384, 384, 768, 768, 1536, 1536, 1536, 384])
        names = set()
        for s in range(32, 1537, 7):
            names.add(self.g.thumb("i1.png", s))
        self.assertLessEqual(len(names), 4)

    def test_thumb_cache_pruned(self):
        first = self.g.thumb("i0.png", 256)
        os.utime(first, (1_000_000, 1_000_000))
        keep = self.g.thumb("i1.png", 256)
        size = os.path.getsize(keep)
        self.g.thumb_cache_bytes = int(size * 2.5)  # room for two files
        self.g.prune_every = 1
        self.g.thumb("i2.png", 256)
        self.g.thumb("i3.png", 256)
        files = [f for f in os.listdir(self.g.thumb_dir) if f.endswith(".webp")]
        total = sum(os.path.getsize(os.path.join(self.g.thumb_dir, f)) for f in files)
        self.assertLessEqual(total, self.g.thumb_cache_bytes)
        self.assertFalse(os.path.exists(first))  # oldest by mtime went first

    def test_delete_removes_thumbs(self):
        t = [self.g.thumb("i2.png", s) for s in (256, 768)]
        self.assertTrue(all(os.path.exists(x) for x in t))
        self.g.delete(["i2.png"])
        self.assertFalse(any(os.path.exists(x) for x in t))

    def test_trash_outside_served_roots_restore_purge(self):
        self.g.delete(["i1.png", "sub/s.png"])
        for root in (self.out, os.path.join(self.tmp.name, "input"), os.path.join(self.tmp.name, "temp"), self.user):
            self.assertNotEqual(os.path.commonpath([self.g.trash_dir, root]), root)
        self.assertTrue(self.g.trash_dir.startswith(self.tmp.name))
        items = {i["rel"]: i for i in self.g.trash_list()["items"]}
        self.assertEqual(set(items), {"i1.png", "sub/s.png"})
        self.assertTrue(all("deleted" in i for i in items.values()))
        r = self.g.restore([items["sub/s.png"]["id"], "nope"])
        self.assertEqual(r["restored"], ["sub/s.png"])
        self.assertEqual(len(r["errors"]), 1)
        self.assertTrue(os.path.exists(os.path.join(self.out, "sub", "s.png")))
        # refuses to overwrite: re-create i1.png, then restore the trashed one
        self.img("i1.png", 99)
        r = self.g.restore([items["i1.png"]["id"]])
        self.assertEqual((r["restored"], r["errors"][0]["error"]), ([], "destination exists"))
        self.assertEqual(len(self.g.trash_list()["items"]), 1)
        p = self.g.purge([items["i1.png"]["id"]])
        self.assertEqual(p["purged"], [items["i1.png"]["id"]])
        self.assertEqual(self.g.trash_list()["items"], [])
        self.assertEqual(os.listdir(self.g.trash_files), [])

    def test_trash_auto_purge(self):
        self.g.delete(["i1.png"])
        idx = self.g._load_trash()
        for e in idx.values():
            e["deleted"] = 1.0
        self.g._save_trash(idx)
        self.assertEqual(self.g.trash_list()["items"], [])
        self.assertEqual(os.listdir(self.g.trash_files), [])

    def test_migrate_old_trash(self):
        os.makedirs(os.path.join(self.out, ".trash", "sub"))
        os.replace(os.path.join(self.out, "sub", "s.png"), os.path.join(self.out, ".trash", "sub", "s.png"))
        self.assertEqual(self.g.migrate_old_trash(), 1)
        self.assertFalse(os.path.exists(os.path.join(self.out, ".trash")))
        items = self.g.trash_list()["items"]
        self.assertEqual([i["rel"] for i in items], ["sub/s.png"])
        self.assertEqual(self.g.restore([items[0]["id"]])["restored"], ["sub/s.png"])

    def test_delete_refuses_non_media(self):
        open(os.path.join(self.out, "w.json"), "w").write("{}")
        r = self.g.delete(["w.json", "notes.txt"])
        self.assertEqual(r["deleted"], [])
        self.assertEqual(len(r["errors"]), 2)
        self.assertTrue(os.path.exists(os.path.join(self.out, "w.json")))

    def test_format_whitelist_and_pixel_cap(self):
        p = os.path.join(self.out, "t.png")  # TIFF content behind a .png name
        Image.new("RGB", (8, 8)).save(p, "TIFF")
        with self.assertRaises(UnsupportedImage):
            self.g.thumb("t.png", 256)
        with self.assertRaises(UnsupportedImage):
            self.g.meta("t.png")
        self.g.max_pixels = 64 * 48 - 1
        with self.assertRaises(UnsupportedImage):
            self.g.thumb("i0.png", 256)
        self.g.max_pixels = 64 * 48
        self.assertTrue(os.path.exists(self.g.thumb("i0.png", 256)))

    def test_favorites(self):
        self.g.set_favorite("i2.png", True)
        r = self.g.list(fav=True)
        self.assertEqual([i["path"] for i in r["items"]], ["i2.png"])
        self.assertTrue(r["items"][0]["fav"])
        self.g.set_favorite("i2.png", False)
        self.assertEqual(self.g.list(fav=True)["total"], 0)
        self.assertTrue(os.path.exists(os.path.join(self.user, "default", "comfyui-pocket", "favorites.json")))

    def test_unsafe_prefixes_and_canonical(self):
        for bad in (chr(92) * 2 + "host" + chr(92) + "share" + chr(92) + "x.png", "//host/share/x.png", "C:" + chr(92) + "x.png", "i1.png:stream", "/i1.png", chr(92) + "i1.png"):
            with self.assertRaises(PathError, msg=bad):
                self.g.resolve(bad)
        self.assertEqual(self.g.canon("sub/../sub/s.png"), "sub/s.png")
        self.g.set_favorite("sub/../sub/s.png", True)
        self.assertEqual([i["path"] for i in self.g.list(fav=True)["items"]], ["sub/s.png"])

    def test_summary_custom_advanced(self):
        from pocket.gallery import summarize_prompt
        p = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux.safetensors"}},
            "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "4x.pth"}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "pos"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "neg"}},
            "5": {"class_type": "CFGGuider", "inputs": {"cfg": 3.5, "positive": ["3", 0], "negative": ["4", 0]}},
            "6": {"class_type": "RandomNoise", "inputs": {"noise_seed": ["7", 0]}},
            "7": {"class_type": "PrimitiveInt", "inputs": {"value": 99}},
            "8": {"class_type": "BasicScheduler", "inputs": {"steps": 20, "scheduler": "simple"}},
            "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "10": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["5", 0], "noise": ["6", 0]}},
        }
        s = summarize_prompt(p)
        self.assertEqual((s["positive"], s["negative"], s["seed"], s["steps"], s["cfg"]), ("pos", "neg", 99, 20, 3.5))
        self.assertEqual((s["sampler"], s["scheduler"], s["model"]), ("euler", "simple", "flux.safetensors"))

    def test_atomic_write_unique_tmp(self):
        from pocket.gallery import atomic_write
        target = os.path.join(self.out, "w.txt")
        atomic_write(target, lambda t: open(t, "w").close())
        self.assertTrue(os.path.exists(target))
        self.assertEqual([f for f in os.listdir(self.out) if f.endswith(".tmp")], [])


if __name__ == "__main__":
    unittest.main()
