#!/usr/bin/env python3
"""Feed of ADO items needing a team lead's attention, for the ado-feed herdr mod.

This section is the state engine: a SQLite store of observations (PRs to
review, failed builds, newly assigned work items) and the rules that turn
repeated syncs into "new", "resolved" and "reopened":
  baseline   per kind (meta baseline:<kind>): a kind's first successful sync
             records everything as already notified (no popup)
  new        an unseen key is open with notified = 0 until mark_notified; an
             observation with appear False is never inserted, only kept/updated
  resolve    a row missing from a sync is auto-resolved, but only for kinds whose
             fetch succeeded (absence of data is not resolution), and never by a
             sync older than the last one recorded
  reopen     a manually resolved row comes back when a later event appears; an
             auto-resolved row comes back whenever it is observed again (with a
             popup only when its event is newer than the resolution)
  purge      resolved rows older than 30 days are deleted on each sync
All times are stored as ISO-8601 UTC strings and compared only after parsing.
Later tasks add the ADO fetchers and the CLI, which prints one JSON object
after MARKER.
"""
import argparse
import copy
import json
import re
import sys
import sqlite3
from datetime import datetime, timedelta, timezone

MARKER = "@@ADO-FEED@@"
PURGE_DAYS = 30
WINDOWS = {"24h": timedelta(hours=24), "48h": timedelta(hours=48), "1w": timedelta(days=7)}
KINDS = ("pr", "mine", "build", "wi")
LABELS = {"pr": ("PR to review", "PRs to review"),
          "mine": ("PR with feedback", "PRs with feedback"),
          "build": ("failed build", "failed builds"),
          "wi": ("item assigned to you", "items assigned to you")}

SCHEMA = """
CREATE TABLE IF NOT EXISTS items(
  key TEXT PRIMARY KEY, kind TEXT, title TEXT, sub TEXT, url TEXT, ref TEXT,
  event_at TEXT, event_text TEXT, action TEXT, first_seen TEXT,
  resolved_at TEXT, resolved_by TEXT, note TEXT, notified INTEGER);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


def parse_time(s):
    """Parse ISO-8601 (Z or offset, 0-7 fraction digits) to an aware UTC datetime."""
    s = s.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    m = re.match(r"^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$", s)
    if m:
        frac = (m.group(2) or "")[:6].ljust(6, "0")
        s = f"{m.group(1)}.{frac}{m.group(3)}"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def connect(path):
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


class _Tx:
    """BEGIN IMMEDIATE ... COMMIT (ROLLBACK on error)."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, et, ev, tb):
        self.conn.execute("ROLLBACK" if et else "COMMIT")
        return False


def _meta(conn, k):
    r = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r["v"] if r else None


def _set_meta(conn, k, v):
    conn.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))


def _display(o):
    return (o["kind"], o["title"], o.get("sub"), o.get("url"), json.dumps(o.get("ref") or {}),
            o.get("event_at"), o.get("event_text"), o.get("action"))


def _new_rows(conn):
    rows = conn.execute("SELECT * FROM items WHERE resolved_at IS NULL AND notified=0 ORDER BY event_at DESC").fetchall()
    return [_out(r) for r in rows]


def _out(r):
    d = dict(r)
    d["ref"] = json.loads(d["ref"]) if d.get("ref") else {}
    return d


def apply_sync(conn, observations, ok_kinds, now, notify=False):
    """Fold one sync's observations into the store. Returns {"new": [rows], "first": bool}.

    notify=True marks the returned new rows notified inside the same transaction,
    so two concurrent notifying syncs can't both report a key."""
    now_s = iso(now)
    with _Tx(conn):
        old = _meta(conn, "baseline")  # pre-per-kind databases: one key covered every kind
        if old is not None:
            for k in KINDS:
                if _meta(conn, "baseline:" + k) is None:
                    _set_meta(conn, "baseline:" + k, old)
            conn.execute("DELETE FROM meta WHERE k='baseline'")
        based = {k for k in KINDS if _meta(conn, "baseline:" + k) is not None}
        first = any(k not in based for k in ok_kinds)
        last = _meta(conn, "last_sync")
        stale = last is not None and parse_time(last) > now
        seen = set()
        for o in observations:
            seen.add(o["key"])
            cur = conn.execute("SELECT * FROM items WHERE key=?", (o["key"],)).fetchone()
            if cur is None:
                if o.get("appear", True) is False:
                    continue
                conn.execute("INSERT INTO items(key,kind,title,sub,url,ref,event_at,event_text,action,"
                             "first_seen,notified) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                             (o["key"], *_display(o), now_s, 0 if o["kind"] in based else 1))
                continue
            newer = bool(cur["resolved_at"] and o.get("event_at")
                         and parse_time(o["event_at"]) > parse_time(cur["resolved_at"]))
            sql = ("UPDATE items SET kind=?,title=?,sub=?,url=?,ref=?,event_at=?,event_text=?,action=?")
            if cur["resolved_at"] is not None and (newer or cur["resolved_by"] == "auto"):
                sql += f",resolved_at=NULL,resolved_by=NULL,note=NULL,notified={0 if newer else 1}"
            conn.execute(sql + " WHERE key=?", (*_display(o), o["key"]))
        if not stale:  # a newer sync already ran: its view of what's gone wins
            for r in conn.execute("SELECT key,kind FROM items WHERE resolved_at IS NULL").fetchall():
                if r["key"] not in seen and r["kind"] in ok_kinds:
                    conn.execute("UPDATE items SET resolved_at=?, resolved_by='auto' WHERE key=?", (now_s, r["key"]))
        cutoff = now - timedelta(days=PURGE_DAYS)
        for r in conn.execute("SELECT key,resolved_at FROM items WHERE resolved_at IS NOT NULL").fetchall():
            if parse_time(r["resolved_at"]) < cutoff:
                conn.execute("DELETE FROM items WHERE key=?", (r["key"],))
        for k in ok_kinds:
            if k not in based:
                _set_meta(conn, "baseline:" + k, now_s)
        if not stale:
            _set_meta(conn, "last_sync", now_s)
        new = [] if first else _new_rows(conn)
        if notify and new:
            conn.executemany("UPDATE items SET notified=1 WHERE key=?", [(r["key"],) for r in new])
    return {"new": new, "first": first}


def mark_notified(conn, keys):
    with _Tx(conn):
        conn.executemany("UPDATE items SET notified=1 WHERE key=?", [(k,) for k in keys])


def open_count(conn):
    return conn.execute("SELECT COUNT(*) FROM items WHERE resolved_at IS NULL").fetchone()[0]


def list_rows(conn, window, resolved, now):
    span = WINDOWS[window]
    out = []
    for r in conn.execute("SELECT * FROM items").fetchall():
        ev = parse_time(r["event_at"]) if r["event_at"] else None
        inside = lambda t: t is not None and now - t <= span
        if r["resolved_at"] is None:
            # an open row is "in" the window from when it happened or when the feed
            # first saw it (e.g. added as a reviewer on an old PR), whichever is later
            seen_at = parse_time(r["first_seen"]) if r["first_seen"] else None
            show = window == "1w" or inside(max((t for t in (ev, seen_at) if t), default=None))
        else:
            show = resolved and (inside(ev) or inside(parse_time(r["resolved_at"])))
        if show:
            out.append((ev or datetime.min.replace(tzinfo=timezone.utc), _out(r)))
    out.sort(key=lambda p: p[0], reverse=True)
    return [d for _, d in out]


def set_resolved(conn, key, by, note, now):
    with _Tx(conn):
        conn.execute("UPDATE items SET resolved_at=?, resolved_by=?, note=? WHERE key=?", (iso(now), by, note, key))


def set_unresolved(conn, key):
    with _Tx(conn):
        conn.execute("UPDATE items SET resolved_at=NULL, resolved_by=NULL, note=NULL, notified=1 WHERE key=?", (key,))


def summary(new):
    if not new:
        return None
    parts = []
    for kind in KINDS:
        n = sum(1 for r in new if r["kind"] == kind)
        if n:
            parts.append(f"{n} {LABELS[kind][0 if n == 1 else 1]}")
    return {"title": f"{len(new)} new in ADO", "body": " · ".join(parts)}


# ---- fetchers (ADO REST -> observations). Read-only: nothing here writes to ADO.
# Assumptions about response shapes (documented, not verified against every org):
#  - connectionData.authenticatedUser carries id, providerDisplayName and
#    properties.Account.$value (the sign-in address).
#  - Thread comments carry author.id and publishedDate; VoteUpdate threads carry
#    properties.CodeReviewThreadType / CodeReviewVotedByIdentity as {"$value": ...}.
#  - Work item updates carry revisedDate, revisedBy and fields["System.AssignedTo"]
#    with identity-valued newValue / oldValue (id and uniqueName).
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "ado_standup", Path(__file__).resolve().parent.parent / "ado-standup" / "standup.py")
standup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(standup)
q = standup.q

BUILD_DAYS = 14
WI_ASSIGNED_DAYS = 14
# items already handed on to review or QA; never shown (an open row auto-resolves)
WI_HIDDEN_STATES = {"code review", "pending qa"}


def me(ado):
    u = (ado.get("/_apis/connectionData?api-version=7.1-preview.1") or {}).get("authenticatedUser") or {}
    mail = ((u.get("properties") or {}).get("Account") or {}).get("$value") or ""
    return {"id": u.get("id"), "name": u.get("providerDisplayName"), "mail": mail.lower()}


def _is_me(ident, who):
    ident = ident or {}
    if ident.get("id") and ident.get("id") == who["id"]:
        return True
    mail = (ident.get("uniqueName") or "").lower()
    return bool(mail) and mail == who["mail"]


def _latest(times):
    times = [t for t in times if t]
    return max(times, key=parse_time) if times else None


OPEN_THREAD = ("active", "pending")


def thread_counts(threads, author):
    """Feedback threads on a PR: comment threads (not system or vote threads) with a
    comment by someone other than the PR's author. {"open": active or pending,
    "resolved": every other status (fixed, closed, won't fix, by design)}."""
    out = {"open": 0, "resolved": 0}
    for t in threads:
        if t.get("isDeleted") or (t.get("properties") or {}).get("CodeReviewThreadType"):
            continue
        if any(c.get("commentType") != "system" and not c.get("isDeleted")
               and not _same(c.get("author"), author) for c in t.get("comments") or []):
            out["open" if t.get("status") in OPEN_THREAD else "resolved"] += 1
    return out


def _same(a, b):
    a, b = a or {}, b or {}
    if a.get("id") and b.get("id"):
        return a["id"] == b["id"]
    return bool(a.get("uniqueName")) and (a.get("uniqueName") or "").lower() == (b.get("uniqueName") or "").lower()


def _pr_detail(ado, who, p):
    """(newest push, newest non-system comment by anyone but him, his newest vote time,
    whether someone other than him or the author has voted or left a comment)."""
    author = p.get("createdBy") or {}

    def other(ident):
        ident = ident or {}
        return not _is_me(ident, who) and not (ident.get("id") and ident.get("id") == author.get("id"))
    base = f"/{q(ado.project)}/_apis/git/repositories/{p['repository']['id']}/pullRequests/{p['pullRequestId']}"
    its = ado.get(f"{base}/iterations?api-version=7.1").get("value", [])
    threads = ado.get(f"{base}/threads?api-version=7.1").get("value", [])
    push = max(its, key=lambda i: parse_time(i["createdDate"])) if its else None
    comment, vote_at, others = None, [], False
    for t in threads:
        props = t.get("properties") or {}
        if (props.get("CodeReviewThreadType") or {}).get("$value") == "VoteUpdate":
            v = (props.get("CodeReviewVotedByIdentity") or {}).get("$value")
            # live shape: $value is an index into the thread's identities map; a direct id is also accepted
            voter = (t.get("identities") or {}).get(v) or {}
            if v == who["id"] or _is_me(voter, who):
                vote_at += [c.get("publishedDate") for c in t.get("comments") or []] or [t.get("publishedDate")]
            elif v != who["id"] and other(voter or {"id": v}):
                others = True
            continue
        for c in t.get("comments") or []:
            a = c.get("author") or {}
            if c.get("commentType") == "system" or a.get("id") == who["id"] or not c.get("publishedDate"):
                continue
            if other(a):
                others = True
            if comment is None or parse_time(c["publishedDate"]) > parse_time(comment["publishedDate"]):
                comment = c
    return push, comment, _latest(vote_at), others, thread_counts(threads, author)


def group_matcher(ado, who, groups):
    """is_mine_group(reviewer): he is a direct member of the group (identities lookup,
    cached per group id for this matcher's life), or its lowercased last `\\` segment is
    in `groups` (an additional positive only). A failed lookup raises, failing the
    whole pr kind: name matching never decides that he is absent."""
    import threading
    cache, lock = {}, threading.Lock()

    def by_name(r):
        return (r.get("displayName") or "").split("\\")[-1].lower() in groups

    def direct(gid):
        with lock:
            if gid in cache:
                return cache[gid]
        r = ado.get(f"https://vssps.dev.azure.com/{ado.org}/_apis/identities?identityIds={gid}"
                    "&queryMembership=Direct&api-version=7.1")
        val = who["id"] in ((r.get("value") or [{}])[0].get("memberIds") or [])
        with lock:
            cache[gid] = val
        return val

    def is_mine_group(r):
        if r.get("id") and who.get("id"):
            return direct(r["id"]) or by_name(r)
        return by_name(r)
    return is_mine_group


def pr_observations(ado, who, is_mine_group, now):
    """is_mine_group(reviewer) -> bool for a container reviewer (see group_matcher)."""
    r = ado.get(f"/{q(ado.project)}/_apis/git/pullrequests?searchCriteria.status=active&$top=1000&api-version=7.1")
    cands = []
    for p in r.get("value", []):
        if p.get("isDraft") or _is_me(p.get("createdBy"), who):
            continue
        revs = p.get("reviewers") or []
        personal = next((x for x in revs if not x.get("isContainer") and _is_me(x, who)), None)
        mine = [x for x in revs if x.get("isContainer") and is_mine_group(x)]
        if personal or mine:
            cands.append((p, personal, mine))

    def one(c):
        p, personal, mine = c
        # someone else already reviewed or commented: it is in hand, not his to chase
        if any(not x.get("isContainer") and x.get("vote", 0) != 0 and not _is_me(x, who)
               and x.get("id") != (p.get("createdBy") or {}).get("id") for x in p.get("reviewers") or []):
            return None
        push, comment, vote_at, others, counts = _pr_detail(ado, who, p)
        if others:
            return None
        vote = (personal or {}).get("vote", 0)
        push_at = push["createdDate"] if push else None
        comment_at = comment["publishedDate"] if comment else None
        if personal:
            needs = vote == 0
        else:  # on it only through a group: a group approval clears it
            needs = not any(x.get("vote", 0) >= 5 for x in mine)
        if not needs and vote != 0:
            act = _latest([push_at, comment_at])
            needs = bool(act) and (vote_at is None or parse_time(act) > parse_time(vote_at))
        if not needs:
            return None
        author = (p.get("createdBy") or {}).get("displayName")
        # on a tie the later-listed source wins: comment > push > opened
        events = [(p["creationDate"], f"opened by {author}"),
                  (push_at, f"{(push or {}).get('author', {}).get('displayName')} pushed"),
                  (comment_at, f"{((comment or {}).get('author') or {}).get('displayName')} commented")]
        best = max((e for e in events if e[0]), key=lambda e: parse_time(e[0]))
        for e in events:
            if e[0] and parse_time(e[0]) == parse_time(best[0]):
                best = e
        repo = p["repository"]
        return {"key": f"pr:{repo['id']}:{p['pullRequestId']}", "kind": "pr", "title": p.get("title"),
                "sub": f"!{p['pullRequestId']} · {repo.get('name')} · {author}",
                "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_git/{q(repo.get('name') or '')}/pullrequest/{p['pullRequestId']}",
                "ref": {"project": ado.project, "repoId": repo["id"], "id": p["pullRequestId"], "vote": vote,
                        "threads": counts},
                "event_at": iso(parse_time(best[0])), "event_text": best[1],
                "action": "approve" if vote < 5 else "none"}

    with ThreadPoolExecutor(8) as pool:
        return [o for o in pool.map(one, cands) if o]


VOTE_TEXT = {-5: "wait for author", -10: "reject"}


def mine_observations(ado, who, now):
    """His own active PRs with feedback still to address: comment threads in which
    someone else has commented that are still active or pending, or a wait/reject
    vote from someone else. Once every such thread is resolved (fixed, closed, won't
    fix, by design), the votes change, or the PR completes, it is no longer observed
    and the row auto-resolves."""
    r = ado.get(f"/{q(ado.project)}/_apis/git/pullrequests?searchCriteria.status=active"
                f"&searchCriteria.creatorId={who['id']}&$top=1000&api-version=7.1")
    prs = [p for p in r.get("value", []) if p.get("status", "active") == "active" and _is_me(p.get("createdBy"), who)]

    def one(p):
        repo = p["repository"]
        base = f"/{q(ado.project)}/_apis/git/repositories/{repo['id']}/pullRequests/{p['pullRequestId']}"
        threads = ado.get(f"{base}/threads?api-version=7.1").get("value", [])
        open_threads, events, vote_at = 0, [], {}
        for t in threads:
            if t.get("isDeleted"):
                continue
            props = t.get("properties") or {}
            typ = (props.get("CodeReviewThreadType") or {}).get("$value")
            if typ == "VoteUpdate":
                v = (props.get("CodeReviewVotedByIdentity") or {}).get("$value")
                voter = (t.get("identities") or {}).get(v) or {"id": v}
                times = [c.get("publishedDate") for c in t.get("comments") or []] + [t.get("publishedDate")]
                at = _latest(times + [vote_at.get(voter.get("id"))])
                if voter.get("id") and at:
                    vote_at[voter["id"]] = at
                continue
            if typ or t.get("status") not in OPEN_THREAD:
                continue
            theirs = [c for c in t.get("comments") or [] if c.get("commentType") != "system" and not c.get("isDeleted")
                      and c.get("publishedDate") and not _is_me(c.get("author"), who)]
            if theirs:
                open_threads += 1
                c = max(theirs, key=lambda c: parse_time(c["publishedDate"]))
                events.append((c["publishedDate"], (c.get("author") or {}).get("displayName")))
        votes = [x for x in p.get("reviewers") or []
                 if not x.get("isContainer") and x.get("vote", 0) < 0 and not _is_me(x, who)]
        if not open_threads and not votes:
            return None
        parts, times = [], []
        if events:
            at, name = max(events, key=lambda e: parse_time(e[0]))
            parts.append(f"{name} commented · {open_threads} open thread{'' if open_threads == 1 else 's'}")
            times.append(at)
        for x in votes:
            parts.append(f"{x.get('displayName')} voted {VOTE_TEXT.get(x['vote'], 'wait for author')}")
            times.append(vote_at.get(x.get("id")))
        at = _latest(times) or p.get("creationDate")
        return {"key": f"mine:{repo['id']}:{p['pullRequestId']}", "kind": "mine", "title": p.get("title"),
                "sub": f"!{p['pullRequestId']} · {repo.get('name')} · your PR",
                "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_git/{q(repo.get('name') or '')}/pullrequest/{p['pullRequestId']}",
                "ref": {"project": ado.project, "repoId": repo["id"], "id": p["pullRequestId"],
                        "threads": thread_counts(threads, p.get("createdBy"))},
                "event_at": iso(parse_time(at)), "event_text": " · ".join(parts), "action": "none"}

    with ThreadPoolExecutor(8) as pool:
        return [o for o in pool.map(one, prs) if o]


def build_observations(ado, now):
    since = (now - timedelta(days=BUILD_DAYS)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    runs = ado.get(f"/{q(ado.project)}/_apis/build/builds?minTime={since}&statusFilter=completed"
                   "&queryOrder=finishTimeDescending&$top=5000&api-version=7.1").get("value", [])
    groups = {}
    for b in runs:
        if not b.get("finishTime"):
            continue
        k = ((b.get("definition") or {}).get("id"), (b.get("sourceBranch") or "").replace("refs/heads/", ""))
        groups.setdefault(k, []).append(b)
    out = []
    for (defid, branch), g in groups.items():
        g.sort(key=lambda b: parse_time(b["finishTime"]), reverse=True)
        if g[0].get("result") == "succeeded":
            continue
        fails = []
        for b in g:
            if b.get("result") == "succeeded":
                break
            if b.get("result") in ("failed", "partiallySucceeded"):
                fails.append(b)
        if not fails:
            continue
        n = fails[0]
        sub = f"#{n.get('buildNumber')} · {(n.get('requestedFor') or {}).get('displayName')}"
        if n.get("reason") == "pullRequest":
            sub += " · PR build"
        out.append({"key": f"build:{defid}:{branch}", "kind": "build",
                    "title": f"{(n.get('definition') or {}).get('name')} on {branch}",
                    "sub": sub, "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_build/results?buildId={n['id']}",
                    "ref": {"project": ado.project, "build": n["id"]},
                    "event_at": iso(parse_time(n["finishTime"])),
                    "event_text": f"failed {len(fails)}×" if len(fails) > 1 else "failed", "action": "none"})
    return out


def _assigned_at(u):
    at = ((u.get("fields") or {}).get("System.ChangedDate") or {}).get("newValue") or u["revisedDate"]
    return parse_time(at)


def wi_observations(ado, who, now):
    """Every live item assigned to him. One assigned more than WI_ASSIGNED_DAYS ago is
    observed with appear False (kept while assigned, never newly added); one he
    assigned to himself is skipped."""
    # the state-name filter only trims volume (closed history); state categories decide
    ids = standup.wiql(ado, "[System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed','Done','Removed')"
                            " ORDER BY [System.ChangedDate] DESC")
    items = []
    for i in range(0, len(ids), 200):
        items += ado.post("/_apis/wit/workitemsbatch?api-version=7.1", {"ids": ids[i:i + 200], "fields": [
            "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo",
            "System.CreatedDate", "System.CreatedBy"]}).get("value", [])
    cats = standup.state_categories(ado, sorted({(w["fields"].get("System.WorkItemType")) for w in items} - {None}))
    live = [w for w in items if cats.get(w["fields"].get("System.WorkItemType"), {}).get(w["fields"].get("System.State"))
            not in ("Completed", "Removed")
            and (w["fields"].get("System.State") or "").lower() not in WI_HIDDEN_STATES]
    cutoff = now - timedelta(days=WI_ASSIGNED_DAYS)

    def one(w):
        f = w["fields"]
        ups = ado.get(f"/_apis/wit/workItems/{w['id']}/updates?api-version=7.1").get("value", [])
        mine = [u for u in ups if _is_me(((u.get("fields") or {}).get("System.AssignedTo") or {}).get("newValue"), who)]
        if mine:
            u = max(mine, key=_assigned_at)
            if _is_me(u.get("revisedBy"), who):
                return None
            # revisedDate is when the revision was superseded (9999-01-01 on the newest);
            # the real change time is fields["System.ChangedDate"].newValue
            at = ((u.get("fields") or {}).get("System.ChangedDate") or {}).get("newValue")
            if not at and parse_time(u["revisedDate"]).year < 9999:
                at = u["revisedDate"]
            text = f"assigned by {(u.get('revisedBy') or {}).get('displayName')}"
            old = (u["fields"]["System.AssignedTo"].get("oldValue") or {}).get("displayName")
            if old:
                text += f", was {old}"
        else:
            at = f.get("System.CreatedDate")
            text = f"created by {(f.get('System.CreatedBy') or {}).get('displayName')}"
        if not at:
            return None
        typ, state = f.get("System.WorkItemType"), f.get("System.State")
        o = {"key": f"wi:{w['id']}", "kind": "wi", "title": f.get("System.Title"),
             "sub": f"#{w['id']} · {typ} · {state}",
             "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_workitems/edit/{w['id']}",
             "ref": {"project": ado.project, "id": w["id"], "state": state, "type": typ},
             "event_at": iso(parse_time(at)), "event_text": text, "action": "none"}
        if parse_time(at) < cutoff:
            o["appear"] = False
        return o

    with ThreadPoolExecutor(8) as pool:
        return [o for o in pool.map(one, live) if o]


# ---- ADO writes and the CLI

class FeedAdo(standup.Ado):
    def put(self, url, body):
        return self.call("PUT", url, body)

    def patch(self, url, body):
        c = copy.copy(self)  # own headers dict: the shared one stays application/json
        c.headers = {**self.headers, "Content-Type": "application/json-patch+json"}
        return c.call("PATCH", url, body)


FATAL = "Set ado.standup.project and ado.feed.team or ado.standup.team in addons.json"


def load_settings(home):
    try:
        with open(Path(home) / "addons.json") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    ado = d.get("ado") if isinstance(d.get("ado"), dict) else {}
    sd = ado.get("standup") if isinstance(ado.get("standup"), dict) else {}
    fd = ado.get("feed") if isinstance(ado.get("feed"), dict) else {}
    return {"project": sd.get("project"), "team": fd.get("team") or sd.get("team"), "org": ado.get("org")}


def make_ado(settings):
    az = standup.az_bin()
    org = settings.get("org") or standup.default_org(az)
    return FeedAdo(org, settings["project"], standup.token(az))


def _err(e):
    return str(e)[:400]


def _fetch_all(ado, settings, now):
    """Returns (observations, ok_kinds, errors)."""
    errors, obs_, ok = {}, [], []
    with ThreadPoolExecutor(4) as pool:
        f_me = pool.submit(me, ado)
        f_team = pool.submit(standup.team_info, ado, settings["team"])
        f_build = pool.submit(build_observations, ado, now)
        who = groups = None
        try:
            who = f_me.result()
        except Exception as e:
            errors["pr"] = errors["wi"] = errors["mine"] = _err(e)
        try:
            info = f_team.result()
            groups = {(g or "").split("\\")[-1].lower() for g in info.get("groups") or []}
            groups.add(settings["team"].lower())
        except Exception as e:
            errors["pr"] = _err(e)
        jobs = {"build": f_build}
        if who is not None and groups is not None:
            jobs["pr"] = pool.submit(pr_observations, ado, who, group_matcher(ado, who, groups), now)
        if who is not None:
            jobs["wi"] = pool.submit(wi_observations, ado, who, now)
            jobs["mine"] = pool.submit(mine_observations, ado, who, now)
        for kind, fut in jobs.items():
            try:
                obs_ += fut.result()
                ok.append(kind)
            except Exception as e:
                errors[kind] = _err(e)
    return obs_, ok, errors


def cmd_sync(conn, settings, args):
    now = datetime.now(timezone.utc)
    ado = make_ado(settings)
    observations, ok, errors = _fetch_all(ado, settings, now)
    r = apply_sync(conn, observations, ok, now, notify=args.notify)
    return {"new": r["new"], "open": open_count(conn), "first": r["first"],
            "summary": None if r["first"] else summary(r["new"]), "errors": errors,
            "project": settings["project"], "team": settings["team"], "generated": iso(now)}


def cmd_list(conn, settings, args):
    now = datetime.now(timezone.utc)
    return {"rows": list_rows(conn, args.window, args.resolved, now), "open": open_count(conn),
            "last_sync": _meta(conn, "last_sync"), "project": settings["project"], "team": settings["team"]}


def _get_row(conn, key):
    r = conn.execute("SELECT * FROM items WHERE key=?", (key,)).fetchone()
    return _out(r) if r else None


def _act(ado, row):
    ref, action = row["ref"], row["action"]
    if action == "approve":
        my_id = me(ado).get("id")
        if not my_id:
            raise RuntimeError("Could not identify you in ADO")
        url = (f"/{q(ref['project'])}/_apis/git/repositories/{ref['repoId']}/pullRequests/{ref['id']}"
               f"/reviewers/{my_id}?api-version=7.1")
        try:
            cur = ado.get(url) or {}
        except RuntimeError as e:
            if not str(e).startswith("HTTP 404"):
                raise
            cur = {}
        if cur.get("vote", 0) >= 5:
            return "already approved"
        # send isRequired back: a PUT without it would make a required reviewer optional
        ado.put(url, {"vote": 10, "isRequired": bool(cur.get("isRequired", False))})
        return "approved"
    if action == "close":
        base = f"/_apis/wit/workitems/{ref['id']}"
        f = ado.get(f"{base}?fields=System.State,System.WorkItemType&api-version=7.1").get("fields") or {}
        state = f.get("System.State")
        if state != "Pending QA":
            return f"already {state}"
        typ = f.get("System.WorkItemType") or ref.get("type")
        cats = standup.state_categories(ado, [typ]).get(typ, {})
        done = next((n for n, c in cats.items() if c == "Completed"), None)
        if not done:
            raise RuntimeError(f"No Completed state for {typ}")
        ado.patch(f"{base}?api-version=7.1", [{"op": "add", "path": "/fields/System.State", "value": done}])
        return "closed"
    return None


def cmd_resolve(conn, settings, args):
    row = _get_row(conn, args.key)
    if row is None:
        return {"error": "No such item"}
    try:
        note = _act(make_ado(settings), row) if row["action"] in ("approve", "close") else None
        set_resolved(conn, args.key, "me", note, datetime.now(timezone.utc))
    except Exception as e:
        return {"error": _err(e)}
    return {"row": _get_row(conn, args.key)}


def cmd_unresolve(conn, settings, args):
    if _get_row(conn, args.key) is None:
        return {"error": "No such item"}
    set_unresolved(conn, args.key)
    return {"row": _get_row(conn, args.key)}


def run(argv):
    ap = argparse.ArgumentParser(prog="feed.py")
    ap.add_argument("--home", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sync")
    s.add_argument("--notify", action="store_true")
    ls = sub.add_parser("list")
    ls.add_argument("--window", choices=sorted(WINDOWS), default="24h")
    ls.add_argument("--resolved", action="store_true")
    for name in ("resolve", "unresolve"):
        sub.add_parser(name).add_argument("key")
    args = ap.parse_args(argv)
    try:
        settings = load_settings(args.home)
        if not settings["project"] or not settings["team"]:
            return {"fatal": FATAL}
        conn = connect(str(Path(args.home) / "ado-feed.db"))
    except Exception as e:
        return {"fatal": _err(e)}
    try:
        return {"sync": cmd_sync, "list": cmd_list, "resolve": cmd_resolve, "unresolve": cmd_unresolve}[args.cmd](conn, settings, args)
    except Exception as e:
        return {"error": _err(e)}
    finally:
        conn.close()


def main(argv=None):
    out = run(sys.argv[1:] if argv is None else argv)
    print(MARKER)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
