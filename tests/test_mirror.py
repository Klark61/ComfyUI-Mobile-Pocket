import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pocket import mirror  # noqa: E402


class FakeServer:
    def __init__(self, sids):
        self.sockets = {s: object() for s in sids}
        self.sent = []

    def send_sync(self, event, data, sid=None):
        self.sent.append((event, data, sid))


class MirrorTest(unittest.TestCase):
    def make(self, sids=("desk", "cpocket-a", "cpocket-b")):
        s = FakeServer(sids)
        self.assertTrue(mirror.install(s))
        return s

    def test_mirrors_to_pocket_only(self):
        s = self.make()
        s.send_sync("progress", {"value": 1}, "desk")
        self.assertEqual(s.sent, [("progress", {"value": 1}, "desk"),
                                  ("progress", {"value": 1}, "cpocket-a"),
                                  ("progress", {"value": 1}, "cpocket-b")])

    def test_broadcast_not_duplicated(self):
        s = self.make()
        s.send_sync("progress", {}, None)
        s.send_sync("status", {}, "desk")  # not a mirrored event
        self.assertEqual(len(s.sent), 2)
        self.assertEqual([x[2] for x in s.sent], [None, "desk"])

    def test_origin_pocket_mirrors_to_other_mobiles_only(self):
        s = self.make()
        s.send_sync("executing", {"node": "1"}, "cpocket-a")
        self.assertEqual(s.sent, [("executing", {"node": "1"}, "cpocket-a"),
                                  ("executing", {"node": "1"}, "cpocket-b")])

    def test_binary_events(self):
        s = self.make()
        s.send_sync(4, (("PNG", object(), 512), {"prompt_id": "p"}), "desk")
        s.send_sync(1, b"x", "desk")
        self.assertEqual(sorted(x[2] for x in s.sent if x[0] == 4), ["cpocket-a", "cpocket-b", "desk"])
        self.assertEqual(len([x for x in s.sent if x[0] == 1]), 3)

    def test_no_pocket_sockets_and_idempotent(self):
        s = self.make(("desk",))
        s.send_sync("progress", {}, "desk")
        self.assertEqual(len(s.sent), 1)
        self.assertFalse(mirror.install(s))
        s.sockets["cpocket-z"] = object()
        s.send_sync("progress", {}, "desk")
        self.assertEqual(len(s.sent), 3)  # one wrapper layer only: orig + 1 mirror

    def test_caps_to_eight_newest_pocket_sockets(self):
        sids = ["desk"] + [f"cpocket-{i}" for i in range(10)]
        s = self.make(sids)
        s.send_sync("progress", {}, "desk")
        self.assertEqual([x[2] for x in s.sent[1:]], [f"cpocket-{i}" for i in range(2, 10)])

    def test_closed_and_backed_up_evicted_first(self):
        sids = ["desk"] + [f"cpocket-{i}" for i in range(10)]
        s = self.make(sids)

        class Closed:
            closed = True

        class Slow:
            class _writer:
                class transport:
                    @staticmethod
                    def get_write_buffer_size():
                        return mirror.MAX_BACKLOG + 1
        s.sockets["cpocket-9"] = Closed()
        s.sockets["cpocket-8"] = Slow()
        s.send_sync("progress", {}, "desk")
        got = [x[2] for x in s.sent[1:]]
        self.assertNotIn("cpocket-9", got)
        self.assertNotIn("cpocket-8", got)  # backed-up newest evicted in favour of healthy older ones
        self.assertEqual(got, [f"cpocket-{i}" for i in range(0, 8)])

    def test_reconnect_same_sid_is_fresh(self):
        sids = ["desk"] + [f"cpocket-{i}" for i in range(9)]
        s = self.make(sids)
        s.send_sync("progress", {}, "desk")  # establishes order
        s.sockets["cpocket-0"] = object()  # phone reconnects: dict keeps its old slot
        s.sent.clear()
        s.send_sync("progress", {}, "desk")
        got = [x[2] for x in s.sent]
        self.assertIn("cpocket-0", got)
        self.assertNotIn("cpocket-1", got)

    def test_backed_up_socket_skips_previews_only(self):
        s = self.make(("desk", "cpocket-a", "cpocket-b"))

        class Slow:
            class _writer:
                class transport:
                    @staticmethod
                    def get_write_buffer_size():
                        return mirror.MAX_BACKLOG + 1
        s.sockets["cpocket-a"] = Slow()
        s.send_sync(1, b"x", "desk")
        s.send_sync("progress", {}, "desk")
        self.assertEqual([(x[0], x[2]) for x in s.sent],
                         [(1, "desk"), (1, "cpocket-b"), ("progress", "desk"),
                          ("progress", "cpocket-a"), ("progress", "cpocket-b")])

    def test_never_raises(self):
        s = self.make()
        s.sockets = None  # broken
        s.send_sync("progress", {}, "desk")
        self.assertEqual(len(s.sent), 1)


if __name__ == "__main__":
    unittest.main()
