#!/usr/bin/env python3
"""Feed of ADO items needing a team lead's attention, for the ado-feed herdr mod.

This section is the state engine: a SQLite store of observations (PRs to
review, failed builds, newly assigned work items) and the rules that turn
repeated syncs into "new", "resolved" and "reopened":
  baseline   the first sync records everything as already notified (no popup)
  new        an unseen key is open with notified = 0 until mark_notified
  resolve    a row missing from a sync is auto-resolved, but only for kinds whose
             fetch succeeded (absence of data is not resolution)
  reopen     a resolved row comes back when a later event appears
  purge      resolved rows older than 30 days are deleted on each sync
All times are stored as ISO-8601 UTC strings and compared only after parsing.
Later tasks add the ADO fetchers and the CLI, which prints one JSON object
after MARKER.
"""
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone

MARKER = "@@ADO-FEED@@"
PURGE_DAYS = 30
WINDOWS = {"24h": timedelta(hours=24), "48h": timedelta(hours=48), "1w": timedelta(days=7)}
LABELS = {"pr": ("PR to review", "PRs to review"),
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


def apply_sync(conn, observations, ok_kinds, now):
    """Fold one sync's observations into the store. Returns {"new": [rows], "first": bool}."""
    now_s = iso(now)
    with _Tx(conn):
        first = _meta(conn, "baseline") is None
        seen = set()
        for o in observations:
            seen.add(o["key"])
            cur = conn.execute("SELECT * FROM items WHERE key=?", (o["key"],)).fetchone()
            if cur is None:
                conn.execute("INSERT INTO items(key,kind,title,sub,url,ref,event_at,event_text,action,"
                             "first_seen,notified) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                             (o["key"], *_display(o), now_s, 1 if first else 0))
                continue
            reopen = (cur["resolved_at"] is not None and o.get("event_at") and cur["resolved_at"]
                      and parse_time(o["event_at"]) > parse_time(cur["resolved_at"]))
            sql = ("UPDATE items SET kind=?,title=?,sub=?,url=?,ref=?,event_at=?,event_text=?,action=?")
            if reopen:
                sql += ",resolved_at=NULL,resolved_by=NULL,note=NULL,notified=0"
            conn.execute(sql + " WHERE key=?", (*_display(o), o["key"]))
        for r in conn.execute("SELECT key,kind FROM items WHERE resolved_at IS NULL").fetchall():
            if r["key"] not in seen and r["kind"] in ok_kinds:
                conn.execute("UPDATE items SET resolved_at=?, resolved_by='auto' WHERE key=?", (now_s, r["key"]))
        cutoff = now - timedelta(days=PURGE_DAYS)
        for r in conn.execute("SELECT key,resolved_at FROM items WHERE resolved_at IS NOT NULL").fetchall():
            if parse_time(r["resolved_at"]) < cutoff:
                conn.execute("DELETE FROM items WHERE key=?", (r["key"],))
        if first:
            _set_meta(conn, "baseline", now_s)
        _set_meta(conn, "last_sync", now_s)
        new = [] if first else _new_rows(conn)
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
            show = window == "1w" or inside(ev)
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
    for kind in ("pr", "build", "wi"):
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


def _pr_detail(ado, who, p):
    base = f"/{q(ado.project)}/_apis/git/repositories/{p['repository']['id']}/pullRequests/{p['pullRequestId']}"
    its = ado.get(f"{base}/iterations?api-version=7.1").get("value", [])
    threads = ado.get(f"{base}/threads?api-version=7.1").get("value", [])
    push = max(its, key=lambda i: parse_time(i["createdDate"])) if its else None
    comment, vote_at = None, []
    for t in threads:
        props = t.get("properties") or {}
        if (props.get("CodeReviewThreadType") or {}).get("$value") == "VoteUpdate":
            if (props.get("CodeReviewVotedByIdentity") or {}).get("$value") == who["id"]:
                vote_at += [c.get("publishedDate") for c in t.get("comments") or []] or [t.get("publishedDate")]
            continue
        for c in t.get("comments") or []:
            a = c.get("author") or {}
            if c.get("commentType") == "system" or a.get("id") == who["id"] or not c.get("publishedDate"):
                continue
            if comment is None or parse_time(c["publishedDate"]) > parse_time(comment["publishedDate"]):
                comment = c
    return push, comment, _latest(vote_at)


def pr_observations(ado, who, groups, now):
    """groups: lowercased last `\\` segments of the reviewer groups he's in."""
    r = ado.get(f"/{q(ado.project)}/_apis/git/pullrequests?searchCriteria.status=active&$top=1000&api-version=7.1")
    cands = []
    for p in r.get("value", []):
        if p.get("isDraft"):
            continue
        revs = p.get("reviewers") or []
        personal = next((x for x in revs if not x.get("isContainer") and _is_me(x, who)), None)
        mine = [x for x in revs if x.get("isContainer") and (x.get("displayName") or "").split("\\")[-1].lower() in groups]
        if personal or mine:
            cands.append((p, personal, mine))

    def one(c):
        p, personal, mine = c
        push, comment, vote_at = _pr_detail(ado, who, p)
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
                "ref": {"project": ado.project, "repoId": repo["id"], "id": p["pullRequestId"], "vote": vote},
                "event_at": iso(parse_time(best[0])), "event_text": best[1],
                "action": "approve" if vote < 5 else "none"}

    with ThreadPoolExecutor(8) as pool:
        return [o for o in pool.map(one, cands) if o]


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


def wi_observations(ado, who, now):
    ids = standup.wiql(ado, f"[System.AssignedTo] = @Me AND [System.ChangedDate] >= @Today-{WI_ASSIGNED_DAYS}")
    items = []
    for i in range(0, len(ids), 200):
        items += ado.post("/_apis/wit/workitemsbatch?api-version=7.1", {"ids": ids[i:i + 200], "fields": [
            "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo",
            "System.CreatedDate", "System.CreatedBy"]}).get("value", [])
    cats = standup.state_categories(ado, sorted({(w["fields"].get("System.WorkItemType")) for w in items} - {None}))
    live = [w for w in items if cats.get(w["fields"].get("System.WorkItemType"), {}).get(w["fields"].get("System.State"))
            not in ("Completed", "Removed")]
    cutoff = now - timedelta(days=WI_ASSIGNED_DAYS)

    def one(w):
        f = w["fields"]
        ups = ado.get(f"/_apis/wit/workItems/{w['id']}/updates?api-version=7.1").get("value", [])
        mine = [u for u in ups if _is_me(((u.get("fields") or {}).get("System.AssignedTo") or {}).get("newValue"), who)]
        if mine:
            u = max(mine, key=lambda u: parse_time(u["revisedDate"]))
            at = u["revisedDate"]
            text = f"assigned by {(u.get('revisedBy') or {}).get('displayName')}"
            old = (u["fields"]["System.AssignedTo"].get("oldValue") or {}).get("displayName")
            if old:
                text += f", was {old}"
        else:
            at = f.get("System.CreatedDate")
            text = f"created by {(f.get('System.CreatedBy') or {}).get('displayName')}"
        if not at or parse_time(at) < cutoff:
            return None
        typ, state = f.get("System.WorkItemType"), f.get("System.State")
        return {"key": f"wi:{w['id']}", "kind": "wi", "title": f.get("System.Title"),
                "sub": f"#{w['id']} · {typ} · {state}",
                "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_workitems/edit/{w['id']}",
                "ref": {"project": ado.project, "id": w["id"], "state": state, "type": typ},
                "event_at": iso(parse_time(at)), "event_text": text,
                "action": "close" if state == "Pending QA" else "none"}

    with ThreadPoolExecutor(8) as pool:
        return [o for o in pool.map(one, live) if o]
