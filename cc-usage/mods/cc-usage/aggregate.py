#!/usr/bin/env python3
"""Claude Code usage, ccusage-style, for the cc-usage herdr mod.

Reads ~/.claude/projects/**/*.jsonl (and ~/.config/claude/projects, or
$CLAUDE_CONFIG_DIR), keeps a per-file cache of parsed rows with the byte
offset reached (transcripts are append-only), and prints one JSON report:
per-day totals for every repo / folder / branch / model, sessions, 5-hour
blocks and an hour-of-week heatmap. Costs are estimates from list prices.

Usage: aggregate.py [--full]   (--full drops the cache and rescans)
"""

import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

CACHE_DIR = os.path.expanduser("~/.cache/cc-usage-herdr")
CACHE = os.path.join(CACHE_DIR, "files.json")
REPOS = os.path.join(CACHE_DIR, "repos.json")
VERSION = 3
HOME = os.path.expanduser("~")

# $/1M tokens: input, output, cache read. Cache writes are 1.25x (5m) and
# 2x (1h) of input. From the claude-api skill's model table (2026-10-06).
PRICES = {
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-fable-5": (10.0, 50.0, 1.0),
    "claude-mythos-5-1": (10.0, 50.0, 0.25),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-opus-4-8": (5.0, 25.0, 0.50),
    "claude-opus-4-7": (5.0, 25.0, 0.50),
    "claude-opus-4-6": (5.0, 25.0, 0.50),
    "claude-opus-4-5": (5.0, 25.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-sonnet-4-6": (3.0, 15.0, 0.30),
    "claude-sonnet-4-5": (3.0, 15.0, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-haiku-4-5": (1.0, 5.0, 0.10),
}
FAMILY = {"fable": "claude-fable-5-1", "mythos": "claude-mythos-5-1", "opus": "claude-opus-5-5",
          "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"}


def price_for(model):
    if model in PRICES:
        return PRICES[model]
    for k in sorted(PRICES, key=len, reverse=True):  # dated ids: claude-haiku-4-5-20251001
        if model.startswith(k):
            return PRICES[k]
    for fam, k in FAMILY.items():
        if fam in model:
            return PRICES[k]
    return None


def cost(model, i, o, c5, c1, cr, fast):
    p = price_for(model)
    if not p:
        return 0.0
    pin, pout, pcr = p
    if model.startswith("claude-haiku-5-5") and i + c5 + c1 + cr > 100_000:
        pin, pout, pcr = 0.50, 2.50, 0.05  # long-prompt tier
    m = 2.0 if fast else 1.0
    return m * (i * pin + o * pout + c5 * pin * 1.25 + c1 * pin * 2.0 + cr * pcr) / 1e6


def roots():
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    cands = [p for p in env.split(",")] if env else [os.path.join(HOME, ".config/claude"), os.path.join(HOME, ".claude")]
    out = []
    for c in cands:
        p = os.path.join(os.path.expanduser(c.strip()), "projects")
        if os.path.isdir(p) and os.path.realpath(p) not in [os.path.realpath(x) for x in out]:
            out.append(p)
    return out


def files():
    for r in roots():
        for d, _subs, names in os.walk(r):
            for n in names:
                if n.endswith(".jsonl"):
                    yield os.path.join(d, n)


# A row: [key, ts_epoch, model, cwd, session, branch, in, out, cw5m, cw1h, cr, fast, sidechain]
def parse(path, start, rows):
    with open(path, "rb") as f:
        f.seek(start)
        data = f.read()
    end = data.rfind(b"\n") + 1  # leave a half-written last line for next time
    for line in data[:end].split(b"\n"):
        if b'"usage"' not in line or b'"assistant"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        u = msg.get("usage") or {}
        model = msg.get("model") or "?"
        if model == "<synthetic>" or not u:
            continue
        ts = e.get("timestamp")
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        cc = u.get("cache_creation") or {}
        cw = u.get("cache_creation_input_tokens") or 0
        c1 = cc.get("ephemeral_1h_input_tokens") or 0
        c5 = cc.get("ephemeral_5m_input_tokens") if cc else cw
        if c5 is None:
            c5 = max(0, cw - c1)
        key = f"{msg.get('id')}:{e.get('requestId')}"
        row = [key, t, model, e.get("cwd") or "", e.get("sessionId") or "", e.get("gitBranch") or "",
               u.get("input_tokens") or 0, u.get("output_tokens") or 0, c5, c1,
               u.get("cache_read_input_tokens") or 0, 1 if u.get("speed") == "fast" else 0,
               1 if e.get("isSidechain") else 0]
        old = rows.get(key)
        if old is None or row[7] > old[7]:  # streamed chunks repeat a message: keep the fullest
            rows[key] = row
    return start + end


def load_json(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(p, obj):
    tmp = f"{p}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, p)


def git(cwd, *args):
    try:
        r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=3)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def repo_of_existing(path):
    common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        return None
    common = os.path.normpath(common)
    return os.path.dirname(common) if os.path.basename(common) == ".git" else common


def resolve_repo(cwd, by_name):
    """The repo a folder belongs to: worktrees fold into their main repo."""
    if not cwd:
        return "?"
    if os.path.isdir(cwd):
        r = repo_of_existing(cwd)
        if r:
            return r
    # .../<repo>/.claude/worktrees/<slug>  ->  <repo>
    i = cwd.find("/.claude/worktrees/")
    if i > 0:
        return resolve_repo(cwd[:i], by_name)
    # .../worktrees/<repo-name>/<slug>  ->  the known repo with that name
    parts = cwd.split("/")
    if "worktrees" in parts:
        j = len(parts) - 1 - parts[::-1].index("worktrees")
        if j + 1 < len(parts):
            name = parts[j + 1]
            return by_name.get(name, "worktree:" + name)
    if os.path.isdir(cwd):
        return cwd  # a plain folder, not a repo
    p = cwd
    while p and p != "/" and not os.path.isdir(p):
        p = os.path.dirname(p)
    if p and p not in ("/", HOME):
        r = repo_of_existing(p)
        if r:
            return r
    return cwd


def tilde(p):
    return "~" + p[len(HOME):] if p.startswith(HOME) else p


def main():
    full = "--full" in sys.argv
    os.makedirs(CACHE_DIR, exist_ok=True)
    # Several mod copies may scan at once: take turns (the later one is a no-op).
    lock = open(os.path.join(CACHE_DIR, "lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    cache = {} if full else load_json(CACHE, {})
    if cache.get("v") != VERSION:
        cache = {"v": VERSION, "files": {}}
    fc = cache["files"]
    seen = set()
    scanned = 0
    for p in files():
        seen.add(p)
        try:
            st = os.stat(p)
        except OSError:
            continue
        ent = fc.get(p)
        if ent and ent["size"] == st.st_size and ent["mtime"] == st.st_mtime:
            continue
        if not ent or st.st_size < ent["off"]:
            ent = {"off": 0, "rows": []}
        rows = {r[0]: r for r in ent["rows"]}
        off = parse(p, ent["off"], rows)
        fc[p] = {"size": st.st_size, "mtime": st.st_mtime, "off": off, "rows": list(rows.values())}
        scanned += 1
    for p in list(fc):
        if p not in seen:
            del fc[p]
    if scanned:
        save_json(CACHE, cache)

    # Global dedupe: resumed / forked sessions copy history into new files.
    all_rows = {}
    for ent in fc.values():
        for r in ent["rows"]:
            o = all_rows.get(r[0])
            if o is None or r[7] > o[7]:
                all_rows[r[0]] = r
    rows = sorted(all_rows.values(), key=lambda r: r[1])

    # Folder -> repo, cached (git calls are the slow part).
    repo_cache = {} if full else load_json(REPOS, {})
    cwds = {r[3] for r in rows}
    by_name = {}
    for c in cwds:
        if c in repo_cache:
            continue
        if os.path.isdir(c):
            r = repo_of_existing(c)
            if r:
                repo_cache[c] = r
    for r in set(repo_cache.values()):
        if not r.startswith("worktree:"):
            by_name.setdefault(os.path.basename(r), r)
    for c in cwds:
        if c not in repo_cache:
            repo_cache[c] = resolve_repo(c, by_name)
    save_json(REPOS, repo_cache)

    def repo_label(r):
        return r[len("worktree:"):] if r.startswith("worktree:") else os.path.basename(r.rstrip("/")) or r

    # Aggregate. Vector: [cost, in, out, cacheWrite, cacheRead, msgs]
    def add(d, k, day, v):
        g = d.setdefault(k, {})
        a = g.get(day)
        if a is None:
            g[day] = list(v)
        else:
            for i in range(6):
                a[i] += v[i]

    dims = {"repo": {}, "folder": {}, "branch": {}, "model": {}}
    meta = {"repo": {}, "folder": {}, "branch": {}, "model": {}}
    days = {}
    sessions = {}
    heat = [[0.0] * 24 for _ in range(7)]
    now = time.time()
    heat_from = now - 30 * 86400
    side = [0.0, 0.0]  # subagent cost, total cost (all time)

    for r in rows:
        _k, t, model, cwd, sid, branch, i, o, c5, c1, cr, fast, sc = r
        c = cost(model, i, o, c5, c1, cr, fast)
        v = (c, i, o, c5 + c1, cr, 1)
        lt = datetime.fromtimestamp(t)
        day = lt.strftime("%Y-%m-%d")
        repo = repo_cache.get(cwd, cwd)
        add(days, "all", day, v)
        add(dims["repo"], repo, day, v)
        add(dims["folder"], cwd, day, v)
        bkey = f"{repo}\t{branch or '-'}"
        add(dims["branch"], bkey, day, v)
        add(dims["model"], model, day, v)
        last = meta["repo"].setdefault(repo, {"label": repo_label(repo), "path": tilde(repo), "last": 0})
        last["last"] = max(last["last"], t)
        m = meta["folder"].setdefault(cwd, {"label": tilde(cwd), "path": tilde(cwd), "repo": repo_label(repo), "last": 0})
        m["last"] = max(m["last"], t)
        m = meta["branch"].setdefault(bkey, {"label": branch or "-", "repo": repo_label(repo), "path": tilde(repo), "last": 0})
        m["last"] = max(m["last"], t)
        m = meta["model"].setdefault(model, {"label": model.replace("claude-", ""), "last": 0})
        m["last"] = max(m["last"], t)
        s = sessions.get(sid)
        if s is None:
            s = sessions[sid] = {"id": sid, "start": t, "end": t, "cost": 0.0, "tokens": 0, "msgs": 0,
                                 "repo": repo_label(repo), "folder": tilde(cwd), "branch": branch, "models": {}}
        s["end"] = t
        s["cost"] += c
        s["tokens"] += i + o + c5 + c1 + cr
        s["msgs"] += 1
        s["models"][model] = s["models"].get(model, 0) + c
        if t >= heat_from:
            heat[lt.weekday()][lt.hour] += c
        side[1] += c
        if sc:
            side[0] += c

    # 5-hour blocks, as ccusage: a block starts at the floored hour of the
    # first message after a gap, and lasts 5h.
    blocks = []
    cur = None
    for r in rows:
        t = r[1]
        if cur is None or t >= cur["start"] + 5 * 3600 or t - cur["lastT"] >= 5 * 3600:
            st = datetime.fromtimestamp(t).replace(minute=0, second=0, microsecond=0).timestamp()
            cur = {"start": st, "firstT": t, "lastT": t, "cost": 0.0, "tokens": 0, "msgs": 0}
            blocks.append(cur)
        cur["lastT"] = t
        c = cost(r[2], r[6], r[7], r[8], r[9], r[10], r[11])
        cur["cost"] += c
        cur["tokens"] += r[6] + r[7] + r[8] + r[9] + r[10]
        cur["msgs"] += 1
    active = None
    if blocks and now < blocks[-1]["start"] + 5 * 3600 and now - blocks[-1]["lastT"] < 5 * 3600:
        b = blocks[-1]
        mins = max(1.0, (b["lastT"] - b["firstT"]) / 60)
        rate = b["cost"] / mins  # $/min
        remain = (b["start"] + 5 * 3600 - now) / 60
        active = {**b, "burnPerHour": rate * 60, "tokPerMin": b["tokens"] / mins,
                  "projected": b["cost"] + rate * max(0, remain), "remainMin": remain}

    def ser(dim):
        out = []
        for k, perday in dims[dim].items():
            out.append({"key": k, **meta[dim][k], "days": perday})
        return out

    sess = sorted(sessions.values(), key=lambda s: s["end"], reverse=True)[:400]
    for s in sess:
        s["model"] = max(s["models"], key=s["models"].get) if s["models"] else ""
        del s["models"]

    report = {
        "generated": now,
        "scanned": scanned,
        "files": len(fc),
        "messages": len(rows),
        "first": rows[0][1] if rows else None,
        "days": days.get("all", {}),
        "repo": ser("repo"), "folder": ser("folder"), "branch": ser("branch"), "model": ser("model"),
        "sessions": sess,
        "blocks": [{k: b[k] for k in ("start", "cost", "tokens", "msgs")} for b in blocks[-40:]],
        "active": active,
        "heat": heat,
        "subagentShare": side[0] / side[1] if side[1] else 0,
    }
    out = json.dumps(report, separators=(",", ":"))
    save_json(os.path.join(CACHE_DIR, "report.json"), report)
    sys.stdout.write(out)


if __name__ == "__main__":
    main()
