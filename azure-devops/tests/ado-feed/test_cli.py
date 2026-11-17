"""ado-feed CLI: sync / list / resolve / unresolve (no network; make_ado and fetchers patched).

Run: python3 -m unittest discover -s azure-devops/tests/ado-feed
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "mods", "ado-feed"))
import feed  # noqa: E402

REAL_PR = feed.pr_observations

ME = {"id": "me-1", "name": "Lee Lead", "mail": "lee.lead@example.test"}
SETTINGS = {"ado": {"org": "acme", "standup": {"project": "Proj", "team": "Core"}}}


def obs(key, kind="pr", action="none", ref=None, ev="2026-11-16T10:00:00.000Z"):
    return {"key": key, "kind": kind, "title": "T " + key, "sub": "s", "url": "https://x.test/" + key,
            "ref": ref or {}, "event_at": ev, "event_text": "e", "action": action}


class FakeAdo:
    org, project = "acme", "Proj"

    def __init__(self, vote=0, state="Pending QA", fail_put=False, required=None):
        self.vote, self.state, self.fail_put, self.required = vote, state, fail_put, required
        self.puts, self.patches, self.gets = [], [], []

    def get(self, url):
        self.gets.append(url)
        if "/reviewers/" in url:
            if self.vote is None:
                raise RuntimeError("HTTP 404: not a reviewer")
            d = {"vote": self.vote}
            if self.required is not None:
                d["isRequired"] = self.required
            return d
        if "/workitems/" in url:
            return {"fields": {"System.State": self.state, "System.WorkItemType": "Bug"}}
        raise AssertionError(url)

    def put(self, url, body):
        if self.fail_put:
            raise RuntimeError("HTTP 403: no permission")
        self.puts.append((url, body))
        return {}

    def patch(self, url, body):
        self.patches.append((url, body))
        return {}


class CliBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name
        self.write_settings(SETTINGS)
        self.ado = FakeAdo()
        self.pr, self.build, self.wi = [], [], []
        self.build_exc = None

        def build_fn(ado, now):
            if self.build_exc:
                raise self.build_exc
            return list(self.build)

        for p in (mock.patch.object(feed, "make_ado", lambda s: self.ado),
                  mock.patch.object(feed, "me", lambda ado: ME),
                  mock.patch.object(feed.standup, "team_info", lambda ado, t: {"groups": ["[Proj]\\Core Devs"]}),
                  mock.patch.object(feed.standup, "state_categories",
                                    lambda ado, types: {t: {"Pending QA": "Resolved", "Closed": "Completed"} for t in types}),
                  mock.patch.object(feed, "pr_observations", lambda ado, who, groups, now: list(self.pr)),
                  mock.patch.object(feed, "build_observations", build_fn),
                  mock.patch.object(feed, "wi_observations", lambda ado, who, now: list(self.wi))):
            p.start()
            self.addCleanup(p.stop)

    def write_settings(self, s):
        with open(os.path.join(self.home, "addons.json"), "w") as f:
            json.dump(s, f)

    def run_cmd(self, *args):
        return feed.run(["--home", self.home, *args])


class TestSync(CliBase):
    def test_sync_prints_marker_and_counts(self):
        self.pr = [obs("pr:r:1")]
        out = self.run_cmd("sync")
        self.assertEqual(out["open"], 1)
        self.assertTrue(out["first"])
        self.assertEqual((out["project"], out["team"]), ("Proj", "Core"))
        self.assertEqual(out["errors"], {})
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            feed.main(["--home", self.home, "sync"])
        head, _, body = buf.getvalue().partition("\n")
        self.assertEqual(head, feed.MARKER)
        self.assertIn("open", json.loads(body))

    def test_first_sync_has_no_summary(self):
        self.pr = [obs("pr:r:1")]
        out = self.run_cmd("sync")
        self.assertIsNone(out["summary"])
        self.assertEqual(out["new"], [])
        self.pr.append(obs("pr:r:2"))
        out = self.run_cmd("sync")
        self.assertEqual(out["summary"]["title"], "1 new in ADO")

    def test_sync_kind_error_reported_and_rows_kept(self):
        self.build = [obs("build:1:main", "build")]
        self.run_cmd("sync")
        self.build_exc = RuntimeError("timeout")
        self.build = []
        out = self.run_cmd("sync")
        self.assertIn("timeout", out["errors"]["build"])
        self.assertEqual(out["open"], 1)

    def test_group_lookup_failure_fails_pr_kind_and_keeps_rows(self):
        self.pr = [obs("pr:repo-1:5")]
        self.run_cmd("sync")
        grp = {"id": "g-1", "displayName": "[Proj]\\Platform-Devs", "isContainer": True, "vote": 0}

        class GroupAdo:
            org, project = "acme", "Proj"

            def get(self, url):
                if "vssps" in url:
                    raise RuntimeError("HTTP 500: identities")
                if "/git/pullrequests?" in url:
                    return {"value": [{"pullRequestId": 5, "title": "PR 5", "creationDate": "2026-11-16T10:00:00Z",
                                       "createdBy": {"id": "au-1"}, "reviewers": [grp],
                                       "repository": {"id": "repo-1", "name": "svc-a"}}]}
                return {"value": []}

        self.ado = GroupAdo()
        with mock.patch.object(feed, "pr_observations", REAL_PR):
            out = self.run_cmd("sync")
        self.assertIn("identities", out["errors"]["pr"])
        self.assertEqual(out["open"], 1)

    def test_concurrent_syncs_notify_once(self):
        self.run_cmd("sync")  # baseline
        self.pr = [obs("pr:r:9")]
        results = []
        barrier = threading.Barrier(2)

        def go():
            barrier.wait()
            results.append(self.run_cmd("sync", "--notify"))

        ts = [threading.Thread(target=go) for _ in range(2)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        keys = [r["key"] for res in results for r in res["new"]]
        self.assertEqual(keys, ["pr:r:9"])

    def test_missing_settings_is_fatal(self):
        self.write_settings({"ado": {"standup": {"team": "Core"}}})
        self.assertIn("Set ado.standup.project", self.run_cmd("sync")["fatal"])
        self.write_settings({})
        self.assertIn("fatal", self.run_cmd("list", "--window", "1w"))

    def test_list_no_network(self):
        self.pr = [obs("pr:r:1")]
        self.run_cmd("sync")
        self.ado = None  # any make_ado use would now break
        out = self.run_cmd("list", "--window", "1w")
        self.assertEqual(out["open"], 1)
        self.assertEqual(len(out["rows"]), 1)
        self.assertIsNotNone(out["last_sync"])


class TestResolve(CliBase):
    def seed(self, o):
        self.pr = [o] if o["kind"] == "pr" else []
        self.wi = [o] if o["kind"] == "wi" else []
        self.run_cmd("sync")

    def pr_obs(self):
        return obs("pr:repo1:7", "pr", "approve", {"project": "Proj", "repoId": "repo1", "id": 7})

    def wi_obs(self):
        return obs("wi:5", "wi", "close", {"project": "Proj", "id": 5, "state": "Pending QA", "type": "Bug"})

    def test_resolve_approve_puts_vote_when_unapproved(self):
        self.seed(self.pr_obs())
        out = self.run_cmd("resolve", "pr:repo1:7")
        self.assertEqual(self.ado.puts, [("/Proj/_apis/git/repositories/repo1/pullRequests/7/reviewers/me-1?api-version=7.1",
                                          {"vote": 10, "isRequired": False})])
        self.assertEqual(out["row"]["note"], "approved")
        self.assertEqual(out["row"]["resolved_by"], "me")
        self.assertIsNotNone(out["row"]["resolved_at"])

    def test_resolve_approve_keeps_required_flag(self):
        self.ado.required = True
        self.seed(self.pr_obs())
        self.run_cmd("resolve", "pr:repo1:7")
        self.assertEqual(self.ado.puts[0][1], {"vote": 10, "isRequired": True})

    def test_resolve_approve_404_means_vote_zero(self):
        self.ado.vote = None
        self.seed(self.pr_obs())
        self.run_cmd("resolve", "pr:repo1:7")
        self.assertEqual(len(self.ado.puts), 1)

    def test_resolve_approve_skips_when_already_approved(self):
        self.ado.vote = 5
        self.seed(self.pr_obs())
        out = self.run_cmd("resolve", "pr:repo1:7")
        self.assertEqual(self.ado.puts, [])
        self.assertEqual(out["row"]["note"], "already approved")

    def test_resolve_close_pending_qa(self):
        self.seed(self.wi_obs())
        out = self.run_cmd("resolve", "wi:5")
        self.assertEqual(self.ado.patches, [("/_apis/wit/workitems/5?api-version=7.1",
                                             [{"op": "add", "path": "/fields/System.State", "value": "Closed"}])])
        self.assertEqual(out["row"]["note"], "closed")

    def test_resolve_close_skipped_when_state_moved(self):
        self.ado.state = "Active"
        self.seed(self.wi_obs())
        out = self.run_cmd("resolve", "wi:5")
        self.assertEqual(self.ado.patches, [])
        self.assertEqual(out["row"]["note"], "already Active")

    def test_resolve_none_makes_no_call(self):
        self.seed(obs("pr:repo1:8", "pr", "none", {"project": "Proj", "repoId": "repo1", "id": 8}))
        out = self.run_cmd("resolve", "pr:repo1:8")
        self.assertEqual((self.ado.gets, self.ado.puts), ([], []))
        self.assertEqual(out["row"]["resolved_by"], "me")

    def test_resolve_failure_leaves_row_open(self):
        self.seed(self.pr_obs())
        self.ado.fail_put = True
        out = self.run_cmd("resolve", "pr:repo1:7")
        self.assertIn("403", out["error"])
        self.assertEqual(self.run_cmd("list", "--window", "1w")["open"], 1)

    def test_resolve_approve_without_my_id_sends_nothing(self):
        self.seed(self.pr_obs())
        with mock.patch.object(feed, "me", lambda ado: {"id": None, "name": None, "mail": ""}):
            out = self.run_cmd("resolve", "pr:repo1:7")
        self.assertIn("Could not identify", out["error"])
        self.assertEqual((self.ado.gets, self.ado.puts), ([], []))
        self.assertEqual(self.run_cmd("list", "--window", "1w")["open"], 1)

    def test_run_failure_in_connect_still_prints_marker(self):
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            feed.main(["--home", os.path.join(self.home, "missing", "dir"), "list"])
        head, _, body = buf.getvalue().partition("\n")
        self.assertEqual(head, feed.MARKER)
        self.assertIn("fatal", json.loads(body))

    def test_resolve_unknown_key(self):
        self.assertEqual(self.run_cmd("resolve", "nope"), {"error": "No such item"})

    def test_unresolve(self):
        self.seed(obs("pr:repo1:8", "pr", "none", {"project": "Proj", "repoId": "repo1", "id": 8}))
        self.run_cmd("resolve", "pr:repo1:8")
        out = self.run_cmd("unresolve", "pr:repo1:8")
        self.assertIsNone(out["row"]["resolved_at"])


class TestFeedAdo(unittest.TestCase):
    def test_patch_uses_json_patch_content_type_without_mutating_headers(self):
        a = feed.FeedAdo("acme", "Proj", "tok")
        seen = []

        class R:
            def read(self):
                return b"{}"

            def __enter__(self):
                return self

            def __exit__(self, *e):
                return False

        def fake_open(req, timeout=None):
            seen.append((req.get_method(), req.get_header("Content-type")))
            return R()

        with mock.patch("urllib.request.urlopen", fake_open):
            a.patch("/x", [{"op": "add"}])
            a.put("/x", {"vote": 10})
        self.assertEqual(seen, [("PATCH", "application/json-patch+json"), ("PUT", "application/json")])
        self.assertEqual(a.headers["Content-Type"], "application/json")


if __name__ == "__main__":
    unittest.main()
