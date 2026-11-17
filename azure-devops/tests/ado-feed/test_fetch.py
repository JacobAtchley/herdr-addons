"""ado-feed fetchers: ADO REST responses -> observations (no network; FakeAdo).

Run: python3 -m unittest discover -s azure-devops/tests/ado-feed
"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "mods", "ado-feed"))
import feed  # noqa: E402

NOW = datetime(2026, 11, 16, 12, 0, 0, tzinfo=timezone.utc)
ME = {"id": "me-1", "name": "Lee Lead", "mail": "lee.lead@example.test"}


def ts(**delta):
    return feed.iso(NOW - timedelta(**delta))


class FakeAdo:
    """get/post match the first route whose key is a substring of the URL; calls are recorded."""
    org, project = "acme", "Proj"

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def _match(self, url):
        hits = [k for k in self.routes if k in url]
        if not hits:
            raise AssertionError("unexpected URL " + url)
        return self.routes[max(hits, key=len)]

    def get(self, url):
        self.calls.append(("GET", url))
        return self._match(url)

    def post(self, url, body):
        self.calls.append(("POST", url, body))
        return self._match(url)


def reviewer(vote=0, id="me-1", mail="lee.lead@example.test", group=False, name="Lee Lead"):
    return {"id": id, "uniqueName": mail, "displayName": name, "vote": vote, "isContainer": group}


def pr(id=5, reviewers=(), draft=False, created=None):
    return {"pullRequestId": id, "title": f"PR {id}", "isDraft": draft, "creationDate": created or ts(hours=10),
            "createdBy": {"id": "au-1", "displayName": "Ann Author", "uniqueName": "ann@example.test"},
            "repository": {"id": "repo-1", "name": "svc-a"}, "reviewers": list(reviewers)}


def pr_routes(p, push=None, comments=(), vote_threads=()):
    iters = [{"id": 1, "createdDate": ts(hours=9), "author": {"displayName": "Pat Pusher"}}]
    if push:
        iters.append({"id": 2, "createdDate": push, "author": {"displayName": "Pat Pusher"}})
    threads = []
    for who, when, system in comments:
        threads.append({"comments": [{"author": {"id": who, "displayName": "Cam Commenter" if who != "me-1" else "Lee Lead"},
                                      "publishedDate": when, "commentType": "system" if system else "text"}]})
    for voter, when in vote_threads:
        threads.append({"properties": {"CodeReviewThreadType": {"$value": "VoteUpdate"},
                                       "CodeReviewVotedByIdentity": {"$value": voter}},
                        "comments": [{"author": {"id": voter}, "publishedDate": when, "commentType": "system"}]})
    return {"/git/pullrequests?": {"value": [p]},
            f"/pullRequests/{p['pullRequestId']}/iterations": {"value": iters},
            f"/pullRequests/{p['pullRequestId']}/threads": {"value": threads}}


def run_pr(p, groups=(), **kw):
    ado = FakeAdo(pr_routes(p, **kw))
    return feed.pr_observations(ado, ME, set(groups), NOW)


class FetchPrTests(unittest.TestCase):
    def test_me_from_connection_data(self):
        ado = FakeAdo({"/_apis/connectionData": {"authenticatedUser": {
            "id": "u-9", "providerDisplayName": "Sam Roe", "properties": {"Account": {"$value": "Sam@Example.TEST"}}}}})
        self.assertEqual(feed.me(ado), {"id": "u-9", "name": "Sam Roe", "mail": "sam@example.test"})

    def test_pr_personal_reviewer_no_vote_appears(self):
        p = pr(reviewers=[reviewer(0)], created=ts(hours=10))
        o = run_pr(p, push=ts(hours=5), comments=[("c-1", ts(hours=2), False)])
        self.assertEqual(len(o), 1)
        self.assertEqual(o[0]["key"], "pr:repo-1:5")
        self.assertEqual(o[0]["event_at"], ts(hours=2))
        self.assertEqual(o[0]["event_text"], "Cam Commenter commented")
        self.assertEqual(o[0]["action"], "approve")
        self.assertEqual(o[0]["sub"], "!5 · svc-a · Ann Author")
        self.assertEqual(o[0]["ref"], {"project": "Proj", "repoId": "repo-1", "id": 5, "vote": 0})
        self.assertEqual(o[0]["kind"], "pr")

    def test_pr_opened_text_when_nothing_newer(self):
        o = run_pr(pr(reviewers=[reviewer(0)], created=ts(hours=1)))
        self.assertEqual(o[0]["event_text"], "opened by Ann Author")
        self.assertEqual(o[0]["event_at"], ts(hours=1))

    def test_pr_voted_then_pushed_reappears(self):
        p = pr(reviewers=[reviewer(10)])
        o = run_pr(p, push=ts(hours=1), vote_threads=[("me-1", ts(hours=3))])
        self.assertEqual(len(o), 1)
        self.assertEqual(o[0]["action"], "none")
        self.assertEqual(o[0]["event_text"], "Pat Pusher pushed")
        self.assertEqual(o[0]["ref"]["vote"], 10)

    def test_pr_voted_after_activity_is_absent(self):
        p = pr(reviewers=[reviewer(10)])
        o = run_pr(p, push=ts(hours=3), comments=[("c-1", ts(hours=2), False)], vote_threads=[("me-1", ts(hours=1))])
        self.assertEqual(o, [])

    def test_pr_vote_without_vote_thread_reappears(self):
        # vote_at missing is treated as "never": any activity is newer
        o = run_pr(pr(reviewers=[reviewer(10)]), push=ts(hours=1))
        self.assertEqual(len(o), 1)

    def test_pr_group_only_appears_until_group_approves(self):
        grp = lambda v: reviewer(v, id="g-1", mail="", group=True, name="[Proj]\\Platform-Devs")
        # me not listed personally; group vote 0 -> present
        o = run_pr(pr(reviewers=[grp(0)]), groups={"platform-devs"})
        self.assertEqual(len(o), 1)
        self.assertEqual(o[0]["action"], "approve")
        # group approved -> absent
        self.assertEqual(run_pr(pr(reviewers=[grp(10)]), groups={"platform-devs"}), [])

    def test_pr_personal_entry_ignores_group_approval(self):
        grp = reviewer(10, id="g-1", mail="", group=True, name="[Proj]\\Platform-Devs")
        o = run_pr(pr(reviewers=[reviewer(0), grp]), groups={"platform-devs"})
        self.assertEqual(len(o), 1)

    def test_pr_not_a_reviewer_is_absent(self):
        other = reviewer(0, id="x-1", mail="x@example.test", name="Xi Other")
        grp = reviewer(0, id="g-2", mail="", group=True, name="[Proj]\\Other-Team")
        self.assertEqual(run_pr(pr(reviewers=[other, grp]), groups={"platform-devs"}), [])

    def test_pr_draft_is_absent(self):
        self.assertEqual(run_pr(pr(reviewers=[reviewer(0)], draft=True)), [])

    def test_own_comments_do_not_count(self):
        p = pr(reviewers=[reviewer(10)])
        o = run_pr(p, comments=[("me-1", ts(hours=1), False), ("c-1", ts(hours=1), True)],
                   vote_threads=[("me-1", ts(hours=2))])
        self.assertEqual(o, [])


def build(id, num, result, finish, defid=7, branch="refs/heads/main", reason="batchCI", name="Pipe A"):
    return {"id": id, "buildNumber": num, "result": result, "finishTime": finish, "reason": reason,
            "definition": {"id": defid, "name": name}, "sourceBranch": branch,
            "requestedFor": {"displayName": "Ann Author"}}


def run_builds(runs):
    ado = FakeAdo({"/build/builds?": {"value": runs}})
    return feed.build_observations(ado, NOW), ado


class FetchBuildTests(unittest.TestCase):
    def test_builds_grouped_by_pipeline_and_branch(self):
        runs = [build(103, "20261116.3", "failed", ts(hours=1)), build(102, "20261116.2", "failed", ts(hours=2)),
                build(101, "20261116.1", "partiallySucceeded", ts(hours=3)),
                build(200, "9", "failed", ts(hours=1), defid=8, branch="refs/heads/dev", name="Pipe B")]
        o, ado = run_builds(runs)
        by = {x["key"]: x for x in o}
        self.assertEqual(set(by), {"build:7:main", "build:8:dev"})
        a = by["build:7:main"]
        self.assertEqual(a["event_text"], "failed 3×")
        self.assertEqual(a["ref"], {"project": "Proj", "build": 103})
        self.assertEqual(a["title"], "Pipe A on main")
        self.assertEqual(a["event_at"], ts(hours=1))
        self.assertEqual(a["sub"], "#20261116.3 · Ann Author")
        self.assertEqual(a["action"], "none")
        self.assertEqual(by["build:8:dev"]["event_text"], "failed")
        url = ado.calls[0][1]
        self.assertIn("statusFilter=completed", url)
        self.assertIn("minTime=2026-11-02T12:00:00Z", url)

    def test_build_pr_build_suffix(self):
        o, _ = run_builds([build(1, "5", "failed", ts(hours=1), reason="pullRequest")])
        self.assertEqual(o[0]["sub"], "#5 · Ann Author · PR build")

    def test_build_group_cleared_by_newer_success(self):
        o, _ = run_builds([build(2, "2", "succeeded", ts(hours=1)), build(1, "1", "failed", ts(hours=2))])
        self.assertEqual(o, [])

    def test_build_failures_counted_after_last_success(self):
        runs = [build(1, "1", "failed", ts(hours=5)), build(2, "2", "succeeded", ts(hours=4)),
                build(3, "3", "failed", ts(hours=3)), build(4, "4", "failed", ts(hours=2))]
        o, _ = run_builds(runs)
        self.assertEqual(o[0]["event_text"], "failed 2×")
        self.assertEqual(o[0]["ref"]["build"], 4)


def wi_routes(items, updates, cats=None):
    r = {"/wit/wiql": {"workItems": [{"id": i["id"]} for i in items]},
         "/wit/workitemsbatch": {"value": items},
         "/workitemtypes/": {"value": [{"name": n, "category": c} for n, c in (cats or {"Active": "InProgress", "Pending QA": "InProgress", "Closed": "Completed"}).items()]}}
    for i in items:
        r[f"/wit/workItems/{i['id']}/updates"] = {"value": updates.get(i["id"], [])}
    return r


def wi(id, state="Active", typ="Bug"):
    return {"id": id, "fields": {"System.Title": f"Item {id}", "System.WorkItemType": typ, "System.State": state,
                                 "System.AssignedTo": {"id": "me-1", "uniqueName": "lee.lead@example.test"},
                                 "System.CreatedDate": ts(days=30), "System.CreatedBy": {"displayName": "Cy Creator"}}}


def upd(when, new_id="me-1", by="Alex Doe", old=None):
    f = {"newValue": {"id": new_id, "uniqueName": "lee.lead@example.test" if new_id == "me-1" else "o@example.test"}}
    if old:
        f["oldValue"] = {"displayName": old}
    return {"revisedDate": when, "revisedBy": {"displayName": by}, "fields": {"System.AssignedTo": f}}


def run_wi(items, updates, **kw):
    return feed.wi_observations(FakeAdo(wi_routes(items, updates, **kw)), ME, NOW)


class FetchWorkItemTests(unittest.TestCase):
    def test_wi_assigned_by_someone(self):
        o = run_wi([wi(11)], {11: [upd(ts(days=1), old="Sam Roe")]})
        self.assertEqual(len(o), 1)
        self.assertEqual(o[0]["event_at"], ts(days=1))
        self.assertEqual(o[0]["event_text"], "assigned by Alex Doe, was Sam Roe")
        self.assertEqual(o[0]["key"], "wi:11")
        self.assertEqual(o[0]["sub"], "#11 · Bug · Active")
        self.assertEqual(o[0]["action"], "none")
        self.assertEqual(o[0]["ref"], {"project": "Proj", "id": 11, "state": "Active", "type": "Bug"})

    def test_wi_latest_assignment_to_me_wins(self):
        o = run_wi([wi(11)], {11: [upd(ts(days=5)), upd(ts(days=2), new_id="o-1"), upd(ts(days=3), by="Bo Late")]})
        self.assertEqual(o[0]["event_at"], ts(days=3))
        self.assertEqual(o[0]["event_text"], "assigned by Bo Late")

    def test_wi_pending_qa_action_close(self):
        o = run_wi([wi(12, state="Pending QA")], {12: [upd(ts(days=1))]})
        self.assertEqual(o[0]["action"], "close")

    def test_wi_completed_dropped(self):
        self.assertEqual(run_wi([wi(13, state="Closed")], {13: [upd(ts(days=1))]}), [])

    def test_wi_old_assignment_dropped(self):
        self.assertEqual(run_wi([wi(14)], {14: [upd(ts(days=20))]}), [])

    def test_wi_without_update_uses_created(self):
        it = wi(15)
        it["fields"]["System.CreatedDate"] = ts(days=2)
        o = run_wi([it], {15: []})
        self.assertEqual(o[0]["event_at"], ts(days=2))
        self.assertEqual(o[0]["event_text"], "created by Cy Creator")


if __name__ == "__main__":
    unittest.main()
