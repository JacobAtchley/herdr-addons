#!/usr/bin/env python3
"""Standup data for the ado-standup herdr mod: one ADO team's recent work.

Gets an ADO token from the az login once, then asks in parallel:
  members    the team's members (people; groups kept for PR reviewer matching)
  workitems  items in the team's area changed in the last 90 days, plus open
             items carrying a blocking tag, with each type's state categories
  prs        active PRs authored by, or waiting on, the team, with comment threads
  builds     failed runs in the last MAX_DAYS, and the latest main/master run of
             every pipeline
  deploys    production environment deployments in the last MAX_DAYS, with the
             work items each shipped
The mod filters by time window and person itself, so changing those is free.
Prints one JSON object after MARKER.

usage: standup.py --team "My Team" --project MyProject [--org my-org]
(--org defaults to `az devops configure` organization)
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MARKER = "@@ADO-STANDUP@@"
RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
MAX_DAYS = 14  # builds and deploys fetched; the widest window the mod offers
WI_DAYS = 90  # work item history (stale detection, 14-day throughput)
BLOCK_TAGS = ["Blocked", "Impediment", "external-dependency"]  # --block-tags overrides
PROD_ENV = re.compile(r"(^|[-_ ])(prod|production)($|[-_ ])", re.I)
TIMEOUT = 30


def az_bin():
    for b in ("az", "/opt/homebrew/bin/az", "/usr/local/bin/az"):
        try:
            subprocess.run([b, "version"], capture_output=True, timeout=20)
            return b
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    raise RuntimeError("az CLI not found")


def token(az):
    r = subprocess.run([az, "account", "get-access-token", "--resource", RESOURCE, "--query", "accessToken", "-o", "tsv"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "az account get-access-token failed").strip().splitlines()[-1])
    return r.stdout.strip()


def default_org(az):
    r = subprocess.run([az, "devops", "configure", "-l"], capture_output=True, text=True, timeout=30)
    m = re.search(r"organization\s*=\s*(\S+)", r.stdout or "")
    if not m:
        raise RuntimeError("no org: set ado.org in addons.json or run az devops configure -d organization=…")
    return m.group(1).rstrip("/").split("/")[-1]


class Ado:
    def __init__(self, org, project, tok):
        self.org, self.project = org, project
        self.base = f"https://dev.azure.com/{org}"
        self.headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "Accept": "application/json"}

    def call(self, method, url, body=None):
        if not url.startswith("http"):
            url = self.base + url
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            try:
                detail = json.loads(detail).get("message", detail)
            except Exception:
                pass
            raise RuntimeError(f"HTTP {e.code}: {detail}") from None

    def get(self, url):
        return self.call("GET", url)

    def post(self, url, body):
        return self.call("POST", url, body)


q = urllib.parse.quote
person = lambda i: {"name": (i or {}).get("displayName"), "mail": ((i or {}).get("uniqueName") or "").lower()} if i else None


# ---- team

def teams(ado):
    r = ado.get(f"/_apis/projects/{q(ado.project)}/teams?api-version=7.1&$top=200")
    return sorted(t["name"] for t in r.get("value", []))


def team_info(ado, team):
    members = ado.get(f"/_apis/projects/{q(ado.project)}/teams/{q(team)}/members?api-version=7.1&$top=500").get("value", [])
    people, groups = [], []
    for m in members:
        i = m.get("identity") or {}
        if i.get("isContainer"):
            groups.append(i.get("displayName"))
        else:
            people.append({"name": i.get("displayName"), "mail": (i.get("uniqueName") or "").lower()})
    fv = ado.get(f"/{q(ado.project)}/{q(team)}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1")
    areas = [{"path": v["value"], "children": v.get("includeChildren", False)} for v in fv.get("values", [])]
    return {"people": sorted(people, key=lambda p: p["name"] or ""), "groups": groups, "areas": areas}


# ---- work items

FIELDS = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.CreatedBy",
          "System.CreatedDate", "System.ChangedDate", "Microsoft.VSTS.Common.StateChangeDate", "Microsoft.VSTS.Common.ClosedDate",
          "Microsoft.VSTS.Common.ResolvedDate", "System.Tags", "Microsoft.VSTS.Common.Priority", "System.BoardColumn", "System.AreaPath", "System.IterationPath"]


def area_clause(areas):
    parts = []
    for a in areas:
        p = a["path"].replace("'", "''")
        parts.append(f"[System.AreaPath] {'UNDER' if a['children'] else '='} '{p}'")
    return "(" + " OR ".join(parts) + ")" if parts else "1=1"


def wiql(ado, where):
    r = ado.post(f"/{q(ado.project)}/_apis/wit/wiql?api-version=7.1&$top=2000",
                 {"query": f"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND {where}"})
    return [w["id"] for w in r.get("workItems", [])]


def state_categories(ado, types):
    out = {}
    for t in types:
        try:
            r = ado.get(f"/{q(ado.project)}/_apis/wit/workitemtypes/{q(t)}/states?api-version=7.1")
            out[t] = {s["name"]: s.get("category") for s in r.get("value", [])}
        except Exception:
            out[t] = {}
    return out


def workitems(ado, areas):
    area = area_clause(areas)
    tags = " OR ".join("[System.Tags] CONTAINS '" + t.replace("'", "''") + "'" for t in BLOCK_TAGS)
    ids = set(wiql(ado, f"{area} AND [System.ChangedDate] >= @Today-{WI_DAYS} AND [System.State] <> 'Removed'"))
    ids |= set(wiql(ado, f"{area} AND ({tags}) AND [System.State] NOT IN ('Closed','Done','Removed','Resolved','Completed')"))
    ids = sorted(ids)
    items = []
    for i in range(0, len(ids), 200):
        r = ado.post("/_apis/wit/workitemsbatch?api-version=7.1", {"ids": ids[i:i + 200], "fields": FIELDS})
        items += r.get("value", [])
    out = []
    for w in items:
        f = w.get("fields", {})
        out.append({
            "id": w["id"], "title": f.get("System.Title"), "type": f.get("System.WorkItemType"), "state": f.get("System.State"),
            "assigned": person(f.get("System.AssignedTo")), "createdBy": person(f.get("System.CreatedBy")),
            "created": f.get("System.CreatedDate"), "changed": f.get("System.ChangedDate"),
            "stateChanged": f.get("Microsoft.VSTS.Common.StateChangeDate"), "closed": f.get("Microsoft.VSTS.Common.ClosedDate"), "resolved": f.get("Microsoft.VSTS.Common.ResolvedDate"),
            "tags": [t.strip() for t in (f.get("System.Tags") or "").split(";") if t.strip()],
            "priority": f.get("Microsoft.VSTS.Common.Priority"), "column": f.get("System.BoardColumn"),
            "iteration": f.get("System.IterationPath"),
            "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_workitems/edit/{w['id']}",
        })
    cats = state_categories(ado, sorted({w["type"] for w in out if w["type"]}))
    for w in out:
        w["category"] = cats.get(w["type"], {}).get(w["state"])
    return {"items": out, "categories": cats}


# ---- pull requests

def prs(ado, info):
    mails = {p["mail"] for p in info["people"]}
    groups = {g.split("\\")[-1].lower() for g in info["groups"]}  # "[TEAM FOUNDATION]\\platform-devs" -> "platform-devs"
    r = ado.get(f"/{q(ado.project)}/_apis/git/pullrequests?searchCriteria.status=active&$top=1000&api-version=7.1")
    out = []
    for p in r.get("value", []):
        author = person(p.get("createdBy"))
        revs = [{"name": x.get("displayName"), "mail": (x.get("uniqueName") or "").lower(), "vote": x.get("vote", 0),
                 "required": bool(x.get("isRequired")), "group": bool(x.get("isContainer"))} for x in p.get("reviewers") or []]
        mine = author["mail"] in mails
        waits = any(r_["mail"] in mails or (r_["group"] and (r_["name"] or "").split("\\")[-1].lower() in groups) for r_ in revs)
        if not (mine or waits):
            continue
        repo = p.get("repository") or {}
        out.append({
            "id": p["pullRequestId"], "title": p.get("title"), "draft": p.get("isDraft"), "created": p.get("creationDate"),
            "author": author, "reviewers": revs, "repo": repo.get("name"), "repoId": repo.get("id"),
            "source": (p.get("sourceRefName") or "").replace("refs/heads/", ""), "target": (p.get("targetRefName") or "").replace("refs/heads/", ""),
            "merge": p.get("mergeStatus"),
            "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_git/{q(repo.get('name') or '')}/pullrequest/{p['pullRequestId']}",
        })

    def threads(pr):
        try:
            r = ado.get(f"/{q(ado.project)}/_apis/git/repositories/{pr['repoId']}/pullRequests/{pr['id']}/threads?api-version=7.1")
            st = [t.get("status") for t in r.get("value", []) if not t.get("isDeleted") and t.get("status")
                  and ((t.get("comments") or [{}])[0].get("commentType") != "system")]
            pr["resolved"] = sum(1 for s in st if s in ("fixed", "wontFix", "closed", "byDesign"))
            pr["open"] = len(st) - pr["resolved"]
        except Exception:
            pr["resolved"] = pr["open"] = None
        return pr

    with ThreadPoolExecutor(8) as pool:
        return list(pool.map(threads, out))


# ---- builds

def build_row(ado, b):
    return {
        "id": b["id"], "number": b.get("buildNumber"), "pipeline": (b.get("definition") or {}).get("name"),
        "definition": (b.get("definition") or {}).get("id"), "result": b.get("result"), "status": b.get("status"),
        "branch": (b.get("sourceBranch") or "").replace("refs/heads/", ""), "reason": b.get("reason"),
        "by": person(b.get("requestedFor")), "queued": b.get("queueTime"), "finished": b.get("finishTime"),
        "repo": (b.get("repository") or {}).get("name"),
        "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_build/results?buildId={b['id']}",
    }


def builds(ado):
    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - MAX_DAYS * 86400))
    p = f"/{q(ado.project)}/_apis/build/builds?api-version=7.1"
    failed = ado.get(f"{p}&minTime={since}&resultFilter=failed,partiallySucceeded&statusFilter=completed&$top=500").get("value", [])
    latest = []
    for br in ("main", "master"):
        latest += ado.get(f"{p}&branchName=refs/heads/{br}&maxBuildsPerDefinition=1&queryOrder=finishTimeDescending&statusFilter=completed&$top=500").get("value", [])
    # one latest run per pipeline: main wins when both exist (newest finish)
    best = {}
    for b in latest:
        d = (b.get("definition") or {}).get("id")
        if d not in best or (b.get("finishTime") or "") > (best[d].get("finishTime") or ""):
            best[d] = b
    return {"failed": [build_row(ado, b) for b in failed], "latestMain": [build_row(ado, b) for b in best.values()]}


# ---- production deploys

def deploys(ado):
    envs = ado.get(f"/{q(ado.project)}/_apis/pipelines/environments?api-version=7.1-preview.1&$top=500").get("value", [])
    prod = [e for e in envs if PROD_ENV.search(e.get("name") or "")]
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - MAX_DAYS * 86400))

    def records(e):
        try:
            r = ado.get(f"/{q(ado.project)}/_apis/distributedtask/environments/{e['id']}/environmentdeploymentrecords?api-version=7.1-preview.1&top=60")
        except Exception:
            return []
        return [(e["name"], x) for x in r.get("value", []) if (x.get("finishTime") or x.get("startTime") or "") >= cutoff]

    with ThreadPoolExecutor(8) as pool:
        recs = [x for rs in pool.map(records, prod) for x in rs]
    # One row per (environment, run): a run deploys several jobs/stages to one environment.
    runs = {}
    for env, x in recs:
        bid = (x.get("owner") or {}).get("id")
        k = (env, bid)
        cur = runs.get(k)
        res = x.get("result")
        if not cur:
            runs[k] = cur = {"env": env, "build": bid, "pipeline": (x.get("definition") or {}).get("name"), "number": (x.get("owner") or {}).get("name"),
                             "finished": x.get("finishTime"), "result": res, "stages": []}
        cur["stages"].append(x.get("stageName"))
        if (x.get("finishTime") or "") > (cur["finished"] or ""):
            cur["finished"] = x.get("finishTime")
        if res != "succeeded":
            cur["result"] = res or cur["result"]
    rows = sorted(runs.values(), key=lambda r: r["finished"] or "", reverse=True)
    ids = sorted({r["build"] for r in rows if r["build"]})
    info = {}
    for i in range(0, len(ids), 100):
        r = ado.get(f"/{q(ado.project)}/_apis/build/builds?api-version=7.1&buildIds={','.join(map(str, ids[i:i + 100]))}")
        for b in r.get("value", []):
            info[b["id"]] = b

    def shipped(bid):
        try:
            refs = ado.get(f"/{q(ado.project)}/_apis/build/builds/{bid}/workitems?api-version=7.1&$top=25").get("value", [])
        except Exception:
            return bid, []
        wids = [int(x["id"]) for x in refs][:25]
        if not wids:
            return bid, []
        r = ado.post("/_apis/wit/workitemsbatch?api-version=7.1", {"ids": wids, "fields": ["System.Id", "System.Title", "System.WorkItemType", "System.AssignedTo"]})
        return bid, [{"id": w["id"], "title": w["fields"].get("System.Title"), "type": w["fields"].get("System.WorkItemType"),
                      "assigned": person(w["fields"].get("System.AssignedTo")),
                      "url": f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_workitems/edit/{w['id']}"} for w in r.get("value", [])]

    with ThreadPoolExecutor(8) as pool:
        wi = dict(pool.map(shipped, ids[:40]))
    for r in rows:
        b = info.get(r["build"]) or {}
        r["by"] = person(b.get("requestedFor"))
        r["branch"] = (b.get("sourceBranch") or "").replace("refs/heads/", "")
        r["repo"] = (b.get("repository") or {}).get("name")
        r["workitems"] = wi.get(r["build"], [])
        r["url"] = f"https://dev.azure.com/{ado.org}/{q(ado.project)}/_build/results?buildId={r['build']}"
    return {"rows": rows, "environments": [e["name"] for e in prod]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--org")
    ap.add_argument("--block-tags", help="JSON list of tags that mark an impediment")
    a = ap.parse_args()
    if a.block_tags:
        global BLOCK_TAGS
        BLOCK_TAGS = [str(t) for t in json.loads(a.block_tags) if str(t).strip()] or BLOCK_TAGS
    if not a.org:
        try:
            a.org = default_org(az_bin())
        except Exception as e:
            sys.stdout.write(MARKER + "\n" + json.dumps({"fatal": str(e)}) + "\n")
            return
    result = {"generated": time.time(), "team": a.team, "project": a.project, "org": a.org, "maxDays": MAX_DAYS, "errors": {}}
    try:
        ado = Ado(a.org, a.project, token(az_bin()))
        info = team_info(ado, a.team)
        result["members"] = info["people"]
        result["groups"] = info["groups"]
        result["areas"] = info["areas"]
        jobs = {"teams": lambda: teams(ado), "workitems": lambda: workitems(ado, info["areas"]), "prs": lambda: prs(ado, info),
                "builds": lambda: builds(ado), "deploys": lambda: deploys(ado)}
        with ThreadPoolExecutor(len(jobs)) as pool:
            futs = {k: pool.submit(fn) for k, fn in jobs.items()}
            for k, f in futs.items():
                try:
                    result[k] = f.result()
                except Exception as e:
                    result["errors"][k] = str(e)[:400]
    except Exception as e:
        result["fatal"] = str(e)[:400]
    sys.stdout.write(MARKER + "\n" + json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
