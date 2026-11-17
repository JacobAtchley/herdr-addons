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
