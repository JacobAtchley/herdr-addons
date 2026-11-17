"""ado-feed state engine: baseline, new/notified, auto-resolve, reopen, windows, purge.

Run: python3 -m unittest discover -s azure-devops/tests/ado-feed
"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "mods", "ado-feed"))
import feed  # noqa: E402

NOW = datetime(2026, 11, 16, 12, 0, 0, tzinfo=timezone.utc)
ALL = {"pr", "build", "wi"}


def obs(key, kind="pr", event_at="2026-11-16T10:00:00Z", **kw):
    d = {"key": key, "kind": kind, "title": "Title " + key, "sub": "repo-a", "url": "https://example.test/" + key,
         "ref": {"id": 1}, "event_at": event_at, "event_text": "opened", "action": "approve"}
    d.update(kw)
    return d


def ago(**kw):
    return feed.iso(NOW - timedelta(**kw))


def row(conn, key):
    r = conn.execute("SELECT * FROM items WHERE key=?", (key,)).fetchone()
    return dict(r) if r else None


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.c = feed.connect(":memory:")

    def baseline(self, observations=()):
        feed.apply_sync(self.c, list(observations), ALL, NOW)

    def test_parse_time_handles_ado_fractions(self):
        a = feed.parse_time("2026-11-16T10:00:00.1234567Z")
        b = feed.parse_time("2026-11-16T10:00:00Z")
        self.assertGreater(a, b)
        self.assertEqual(a.utcoffset(), timedelta(0))
        self.assertEqual(b.utcoffset(), timedelta(0))
        self.assertEqual(feed.parse_time("2026-11-16T12:00:00+02:00"), b)

    def test_first_sync_is_baseline(self):
        r = feed.apply_sync(self.c, [obs("a"), obs("b")], ALL, NOW)
        self.assertTrue(r["first"])
        self.assertEqual(r["new"], [])
        self.assertEqual(feed.open_count(self.c), 2)

    def test_new_key_after_baseline_is_new(self):
        self.baseline()
        r = feed.apply_sync(self.c, [obs("a")], ALL, NOW)
        self.assertFalse(r["first"])
        self.assertEqual([x["key"] for x in r["new"]], ["a"])

    def test_new_stays_new_until_marked(self):
        self.baseline()
        for _ in range(2):
            r = feed.apply_sync(self.c, [obs("a")], ALL, NOW)
            self.assertEqual([x["key"] for x in r["new"]], ["a"])
        feed.mark_notified(self.c, ["a"])
        self.assertEqual(feed.apply_sync(self.c, [obs("a")], ALL, NOW)["new"], [])

    def test_missing_open_row_auto_resolves(self):
        self.baseline([obs("a")])
        feed.apply_sync(self.c, [], ALL, NOW)
        self.assertEqual(row(self.c, "a")["resolved_by"], "auto")
        self.assertEqual(feed.open_count(self.c), 0)

    def test_failed_kind_does_not_auto_resolve(self):
        self.baseline([obs("a")])
        feed.apply_sync(self.c, [], {"build", "wi"}, NOW)
        self.assertIsNone(row(self.c, "a")["resolved_at"])
        self.assertEqual(feed.open_count(self.c), 1)

    def test_resolved_row_reopens_on_newer_event(self):
        self.baseline([obs("a")])
        feed.set_resolved(self.c, "a", "user", "done", NOW)
        newer = feed.iso(NOW + timedelta(hours=1))
        r = feed.apply_sync(self.c, [obs("a", event_at=newer)], ALL, NOW + timedelta(hours=2))
        got = row(self.c, "a")
        self.assertIsNone(got["resolved_at"])
        self.assertIsNone(got["resolved_by"])
        self.assertIsNone(got["note"])
        self.assertEqual(got["notified"], 0)
        self.assertEqual([x["key"] for x in r["new"]], ["a"])

    def test_resolved_row_stays_resolved_on_same_event(self):
        self.baseline([obs("a")])
        feed.set_resolved(self.c, "a", "user", "done", NOW)
        r = feed.apply_sync(self.c, [obs("a", event_at=ago(hours=1), title="New title")], ALL, NOW)
        got = row(self.c, "a")
        self.assertIsNotNone(got["resolved_at"])
        self.assertEqual(got["title"], "New title")
        self.assertEqual(r["new"], [])
        self.assertEqual(feed.open_count(self.c), 0)

    def test_list_windows(self):
        self.baseline()
        feed.apply_sync(self.c, [obs("h2", event_at=ago(hours=2)), obs("h30", event_at=ago(hours=30)),
                                 obs("d10", event_at=ago(days=10)), obs("r3", event_at=ago(hours=3))], ALL, NOW)
        feed.set_resolved(self.c, "r3", "user", "", NOW)
        keys = lambda w, res=False: [x["key"] for x in feed.list_rows(self.c, w, res, NOW)]
        self.assertEqual(keys("24h"), ["h2"])
        self.assertEqual(keys("48h"), ["h2", "h30"])
        self.assertEqual(keys("1w"), ["h2", "h30", "d10"])
        self.assertEqual(keys("1w", True), ["h2", "r3", "h30", "d10"])
        self.assertEqual(feed.list_rows(self.c, "24h", False, NOW)[0]["ref"], {"id": 1})

    def test_unresolve_reopens_without_popup(self):
        self.baseline([obs("a")])
        feed.set_resolved(self.c, "a", "user", "x", NOW)
        feed.set_unresolved(self.c, "a")
        self.assertEqual(feed.open_count(self.c), 1)
        self.assertEqual(feed.apply_sync(self.c, [obs("a")], ALL, NOW)["new"], [])

    def test_purge_old_resolved(self):
        self.baseline([obs("a"), obs("b")])
        feed.set_resolved(self.c, "a", "user", "", NOW - timedelta(days=31))
        feed.set_resolved(self.c, "b", "user", "", NOW - timedelta(days=29))
        feed.apply_sync(self.c, [], set(), NOW)
        self.assertIsNone(row(self.c, "a"))
        self.assertIsNotNone(row(self.c, "b"))

    def test_summary_text(self):
        self.assertEqual(feed.summary([obs("a"), obs("b"), obs("c", kind="build")]),
                         {"title": "3 new in ADO", "body": "2 PRs to review · 1 failed build"})
        self.assertEqual(feed.summary([obs("w", kind="wi")]),
                         {"title": "1 new in ADO", "body": "1 item assigned to you"})
        self.assertIsNone(feed.summary([]))


if __name__ == "__main__":
    unittest.main()
