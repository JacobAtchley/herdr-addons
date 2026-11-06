#!/usr/bin/env python3
"""Claude plan limits (what Claude Code's /usage shows): % used and reset time
for the 5-hour window and the weekly limits.

Reads Claude Code's OAuth access token from the macOS Keychain, calls
Anthropic's usage endpoint, and prints ONLY the limit figures as JSON. The
token never leaves this process: it is not printed, logged or cached.

Output: {"fetched": <epoch>, "limits": [{"key", "label", "used", "resets_at"}]}
    or  {"error": "<reason>"} (exit 0, so the pane can show the reason).
A copy of a good result is kept in ~/.cache/cc-usage-herdr/limits.json.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

URL = "https://api.anthropic.com/api/oauth/usage"
CACHE = os.path.expanduser("~/.cache/cc-usage-herdr/limits.json")
LABELS = {
    "five_hour": "5-hour window",
    "seven_day": "Weekly",
    "seven_day_opus": "Weekly · Opus",
    "seven_day_sonnet": "Weekly · Sonnet",
    "seven_day_oauth_apps": "Weekly · apps",
}
ORDER = list(LABELS)


def out(obj):
    print(json.dumps(obj))
    sys.exit(0)


def token():
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        return (json.loads(raw).get("claudeAiOauth") or {}).get("accessToken")
    except Exception:
        return None


def main():
    tok = token()
    if not tok:
        out({"error": "No Claude Code login in the Keychain"})
    req = urllib.request.Request(URL, headers={
        "Authorization": f"Bearer {tok}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "cc-usage-herdr",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        out({"error": "Login expired: run claude once to refresh it" if e.code == 401 else f"Usage endpoint HTTP {e.code}"})
    except Exception as e:
        out({"error": f"Usage endpoint unreachable ({type(e).__name__})"})

    limits = from_list(data) or from_keys(data)
    credits = spend(data)
    if credits:
        limits.append(credits)
    res = {"fetched": int(time.time()), "limits": limits}
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, "w") as f:
            json.dump(res, f)
    except OSError:
        pass
    out(res)


def from_list(data):
    """The newer `limits` list: session, weekly_all, and weekly_scoped (per model, e.g. Fable)."""
    rows = []
    for i, l in enumerate((data or {}).get("limits") or []):
        if not isinstance(l, dict) or not isinstance(l.get("percent"), (int, float)):
            continue
        kind = l.get("kind") or f"limit{i}"
        scope = l.get("scope") or {}
        named = lambda x: x.get("display_name") if isinstance(x, dict) else None
        name = named(scope.get("model")) or named(scope.get("surface"))
        if kind == "session":
            label = "5-hour window"
        elif kind == "weekly_all":
            label = "Weekly"
        elif kind == "weekly_scoped":
            label = f"Weekly · {name}" if name else "Weekly · scoped"
        else:
            label = kind.replace("_", " ").capitalize() + (f" · {name}" if name else "")
        rows.append({
            "key": f"{kind}-{name or i}".lower().replace(" ", "-"),
            "label": label,
            "used": float(l["percent"]),
            "resets_at": l.get("resets_at"),
            "severity": l.get("severity"),
        })
    return rows


def spend(data):
    """Usage credits: what covers you once a plan limit is hit."""
    s = (data or {}).get("spend")
    if not isinstance(s, dict) or not s.get("enabled"):
        return None
    try:
        used, lim = s["used"], s["limit"]
        u = used["amount_minor"] / 10 ** used.get("exponent", 2)
        cap = lim["amount_minor"] / 10 ** lim.get("exponent", 2)
    except (KeyError, TypeError):
        return None
    if cap <= 0:
        return None
    return {
        "key": "credits",
        "label": "Usage credits",
        "used": float(s.get("percent") if isinstance(s.get("percent"), (int, float)) else u / cap * 100),
        "resets_at": None,
        "left_text": f"${cap - u:,.2f} left",
        "note": f"${u:,.2f} of ${cap:,.2f} used",
        "severity": s.get("severity"),
    }


def from_keys(data):
    """Older shape: five_hour / seven_day / seven_day_<model> objects."""
    limits = []
    for key, v in (data or {}).items():
        if not isinstance(v, dict) or not isinstance(v.get("utilization"), (int, float)):
            continue
        limits.append({
            "key": key,
            "label": LABELS.get(key, key.replace("_", " ").capitalize()),
            "used": float(v["utilization"]),
            "resets_at": v.get("resets_at"),
        })
    limits.sort(key=lambda x: ORDER.index(x["key"]) if x["key"] in ORDER else 99)
    return limits


if __name__ == "__main__":
    main()
