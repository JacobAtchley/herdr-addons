#!/usr/bin/env python3
"""Datadog "needs attention" for the dd-attention herdr mod.

Reads DD_API_KEY and DD_APP_KEY (or DD_APPLICATION_KEY) from the environment,
optional DD_SITE (default datadoghq.com). Asks four things in parallel:
triggered monitors, Error Tracking issues, error logs, APM error spans.
Prints one JSON object after a MARKER line, so shell start-up noise before it
is ignored. Keys are never printed.

usage: dd.py --env prod --hours 24
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MARKER = "@@DD-ATTENTION@@"
TIMEOUT = 25


def keys():
    api = os.environ.get("DD_API_KEY") or os.environ.get("DATADOG_API_KEY")
    app = os.environ.get("DD_APP_KEY") or os.environ.get("DD_APPLICATION_KEY") or os.environ.get("DATADOG_APP_KEY")
    return api, app


class DD:
    def __init__(self, api, app, site):
        self.base = f"https://api.{site}"
        self.headers = {"DD-API-KEY": api, "DD-APPLICATION-KEY": app, "Content-Type": "application/json", "Accept": "application/json"}

    def call(self, method, path, body=None, params=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            try:
                detail = "; ".join(json.loads(detail).get("errors", [])) or detail
            except Exception:
                pass
            raise RuntimeError(f"HTTP {e.code} {path}: {detail}") from None


# ---- monitors

def env_ok(text, env):
    """Keep a monitor unless it names an env and that env isn't ours."""
    envs = set(re.findall(r"env:([\w.-]+)", text or ""))
    return not envs or env in envs


def monitors(dd, env, _hours):
    out = []
    page = 0
    while page < 10:
        batch = dd.call("GET", "/api/v1/monitor", params={"group_states": "alert,warn,no data", "page": page, "page_size": 500, "with_downtimes": "true"})
        if not batch:
            break
        for m in batch:
            state = m.get("overall_state")
            if state not in ("Alert", "Warn", "No Data"):
                continue
            if not env_ok(" ".join(m.get("tags") or []) + " " + (m.get("query") or ""), env):
                continue
            muted = bool(m.get("matching_downtimes")) or bool((m.get("options") or {}).get("silenced"))
            groups = []
            for name, g in ((m.get("state") or {}).get("groups") or {}).items():
                if g.get("status") in ("Alert", "Warn", "No Data") and env_ok(name, env):
                    groups.append({"name": name, "status": g.get("status"), "since": g.get("last_triggered_ts")})
            groups.sort(key=lambda g: -(g["since"] or 0))
            out.append({
                "id": m.get("id"), "name": m.get("name"), "state": state, "type": m.get("type"),
                "priority": m.get("priority"), "tags": m.get("tags") or [], "muted": muted,
                "since": m.get("overall_state_modified"), "groups": groups[:20], "group_count": len(groups),
            })
        if len(batch) < 500:
            break
        page += 1
    rank = {"Alert": 0, "Warn": 1, "No Data": 2}
    out.sort(key=lambda m: (m["muted"], rank.get(m["state"], 3), m["priority"] or 9, m["name"] or ""))
    return out


# ---- error tracking

def issues(dd, env, hours):
    now = int(time.time() * 1000)
    body = {"data": {"type": "search_request", "attributes": {
        "query": f"env:{env}", "from": now - hours * 3600 * 1000, "to": now,
        "persona": "ALL", "order_by": "TOTAL_COUNT"}}}
    r = dd.call("POST", "/api/v2/error-tracking/issues/search", body, params={"include": "issue"})
    by_id = {i["id"]: i.get("attributes", {}) for i in (r.get("included") or []) if i.get("type") == "issue"}
    out = []
    for res in r.get("data") or []:
        a = res.get("attributes", {})
        iid = (((res.get("relationships") or {}).get("issue") or {}).get("data") or {}).get("id") or res.get("id")
        i = by_id.get(iid, {})
        out.append({
            "id": iid, "type": i.get("error_type"), "message": i.get("error_message"), "service": i.get("service"),
            "file": i.get("file_path"), "function": i.get("function_name"), "state": i.get("state"),
            "first_seen": i.get("first_seen"), "last_seen": i.get("last_seen"), "languages": i.get("languages"),
            "count": a.get("total_count"), "users": a.get("impacted_users"), "sessions": a.get("impacted_sessions"),
        })
    return out[:100]


# ---- error logs: newest error logs, clustered by service + message shape

NORM = [(re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I), "<uuid>"),
        (re.compile(r"\b[0-9a-f]{16,}\b", re.I), "<hex>"),
        (re.compile(r"\d+"), "#")]


def shape(msg):
    s = (msg or "").strip().split("\n", 1)[0][:240]
    for rx, rep in NORM:
        s = rx.sub(rep, s)
    return s


def logs(dd, env, hours):
    query = f"status:(error OR critical OR emergency OR alert) env:{env}"
    frm = f"now-{hours}h"
    events = []
    cursor = None
    for _ in range(3):  # up to 1000 newest
        body = {"filter": {"query": query, "from": frm, "to": "now"}, "sort": "-timestamp", "page": {"limit": 1000 if not events else 1000}}
        if cursor:
            body["page"]["cursor"] = cursor
        r = dd.call("POST", "/api/v2/logs/events/search", body)
        events += r.get("data") or []
        cursor = ((r.get("meta") or {}).get("page") or {}).get("after")
        if not cursor or len(events) >= 1000:
            break
    total = dd.call("POST", "/api/v2/logs/analytics/aggregate", {
        "compute": [{"aggregation": "count", "type": "total"}],
        "filter": {"query": query, "from": frm, "to": "now"},
        "group_by": [{"facet": "service", "limit": 25, "sort": {"aggregation": "count", "order": "desc", "type": "measure"}}],
    })
    per_service = {}
    for b in ((total.get("data") or {}).get("buckets") or []):
        per_service[(b.get("by") or {}).get("service") or "?"] = (b.get("computes") or {}).get("c0")
    clusters = {}
    for e in events:
        a = e.get("attributes", {})
        svc = a.get("service") or "?"
        msg = a.get("message") or (a.get("attributes") or {}).get("error", {}).get("message") or ""
        key = (svc, shape(msg))
        c = clusters.get(key)
        if not c:
            err = (a.get("attributes") or {}).get("error") or {}
            c = clusters[key] = {"service": svc, "message": msg.strip().split("\n", 1)[0][:400], "shape": key[1], "count": 0,
                                 "last": a.get("timestamp"), "first": a.get("timestamp"), "status": a.get("status"),
                                 "kind": err.get("kind"), "host": a.get("host"), "id": e.get("id")}
        c["count"] += 1
        c["first"] = a.get("timestamp")
    out = sorted(clusters.values(), key=lambda c: -c["count"])
    return {"clusters": out[:150], "sampled": len(events), "per_service": per_service}


# ---- APM error spans

def apm(dd, env, hours):
    frm = f"now-{hours}h"

    def agg(query, group):
        r = dd.call("POST", "/api/v2/spans/analytics/aggregate", {"data": {"type": "aggregate_request", "attributes": {
            "compute": [{"aggregation": "count", "type": "total"}],
            "filter": {"query": query, "from": frm, "to": "now"},
            "group_by": group}}})
        rows = []
        for b in (r.get("data") or []):
            a = b.get("attributes", b)
            rows.append((a.get("by") or {}, (a.get("compute") or a.get("computes") or {}).get("c0") or 0))
        return rows

    base = f"env:{env}"
    errs = agg(f"{base} status:error", [{"facet": "service", "limit": 20}, {"facet": "resource_name", "limit": 5}])
    totals = {by.get("service"): n for by, n in agg(base, [{"facet": "service", "limit": 50}])}
    samples = dd.call("POST", "/api/v2/spans/events/search", {"data": {"type": "search_request", "attributes": {
        "filter": {"query": f"{base} status:error", "from": frm, "to": "now"}, "sort": "-timestamp", "page": {"limit": 200}}}})
    sample = {}
    for s in samples.get("data") or []:
        a = s.get("attributes", {})
        key = (a.get("service"), a.get("resource_name"))
        if key in sample:
            continue
        err = ((a.get("custom") or {}).get("error") or {})
        sample[key] = {"trace": a.get("trace_id"), "span": a.get("span_id"), "type": err.get("type"),
                       "message": (err.get("message") or "")[:400], "stack": (err.get("stack") or "")[:4000], "at": a.get("start_timestamp")}
    out = []
    for by, n in errs:
        svc, res = by.get("service"), by.get("resource_name")
        tot = totals.get(svc) or 0
        out.append({"service": svc, "resource": res, "errors": n, "service_total": tot, "sample": sample.get((svc, res))})
    out.sort(key=lambda r: -r["errors"])
    return out[:100]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", default="prod")
    ap.add_argument("--hours", type=int, default=24)
    args = ap.parse_args()
    api, app = keys()
    site = os.environ.get("DD_SITE") or "datadoghq.com"
    result = {"generated": time.time(), "site": site, "env": args.env, "hours": args.hours}
    if not api or not app:
        result["fatal"] = "missing_keys"
        result["missing"] = [n for n, v in (("DD_API_KEY", api), ("DD_APP_KEY", app)) if not v]
    else:
        dd = DD(api, app, site)
        jobs = {"monitors": monitors, "issues": issues, "logs": logs, "apm": apm}
        with ThreadPoolExecutor(len(jobs)) as pool:
            futs = {k: pool.submit(fn, dd, args.env, args.hours) for k, fn in jobs.items()}
            for k, f in futs.items():
                try:
                    result[k] = {"ok": True, "data": f.result()}
                except Exception as e:
                    result[k] = {"ok": False, "error": str(e)[:500]}
        errs = [result[k]["error"] for k in jobs if not result[k]["ok"]]
        if errs and all("HTTP 403" in e or "HTTP 401" in e for e in errs) and len(errs) == len(jobs):
            result["fatal"] = "auth"
    sys.stdout.write(MARKER + "\n" + json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
