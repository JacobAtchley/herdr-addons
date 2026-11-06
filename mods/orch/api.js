// The orchestrator daemon's local API (default http://127.0.0.1:8490), through curl:
// the daemon refuses POSTs from non-allowlisted Origins and curl sends none.
// Mirrors the endpoints the web dashboard uses (dashboard/src/api/client.ts).
import { exec, appHome } from "herdr";
import { readFile } from "fs/promises";

// orchestrator.url / orchestrator.dashboard in addons.json (herdr-addons
// README) override these. Re-read before every call; dashUrl() uses the last read.
let BASE = "http://127.0.0.1:8490";
let DASHBOARD = "http://localhost:8490";
async function loadUrls() {
  try {
    const o = JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8"))?.orchestrator ?? {};
    BASE = String(o.url || "http://127.0.0.1:8490").replace(/\/+$/, "");
    DASHBOARD = String(o.dashboard || o.url || "http://localhost:8490").replace(/\/+$/, "");
  } catch { /* no settings file: defaults */ }
}
export const baseUrl = () => BASE;
const TIMEOUT_S = 12;

const seg = (s) => encodeURIComponent(String(s));

async function call(method, path, body) {
  await loadUrls();
  // -q first (skips ~/.curlrc); --noproxy keeps loopback off any proxy.
  const args = ["-q", "--noproxy", "*", "-sS", "-m", String(TIMEOUT_S), "-X", method, "-H", "content-type: application/json",
    ...(body !== undefined ? ["--data-binary", JSON.stringify(body)] : []), "-w", "\n%{http_code}", BASE + path];
  const r = await exec("curl", args);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || `curl exited ${r.code}`);
  const out = r.stdout ?? "";
  const i = out.lastIndexOf("\n");
  const status = Number(out.slice(i + 1)) || 0;
  let data = null;
  try { data = JSON.parse(i < 0 ? "" : out.slice(0, i)); } catch { /* not JSON */ }
  if (status < 200 || status >= 300) {
    const msg = (data && (data.error || data.message || data.detail)) || `HTTP ${status}`;
    throw new Error(String(msg));
  }
  return data;
}

export const get = (path) => call("GET", path);
export const post = (path, body) => call("POST", path, body ?? {});

export const api = {
  status: () => get("/v1/status"),
  sessions: () => get("/v1/sessions"),
  workflows: () => get("/v1/workflows"),
  approvals: () => get("/v1/approvals"),
  history: (limit = 80) => get(`/v1/history?limit=${limit}`),
  prInbox: () => get("/v1/pr-inbox"),
  refreshInbox: () => post("/v1/pr-inbox/refresh"),
  // An immediate poll tick (new work items, PR feedback); accepted, not finished.
  poll: () => post("/v1/poll"),
  reviewPr: (prId) => post(`/v1/pr-inbox/${seg(prId)}/review`),
  artifacts: (itemId) => get(`/v1/workflows/${seg(itemId)}/artifacts`),
  approvePlan: (itemId, note = "") => post(`/v1/approvals/${seg(itemId)}/approve`, { note }),
  rejectPlan: (itemId, note = "") => post(`/v1/approvals/${seg(itemId)}/reject`, { note }),
  permission: (sid) => get(`/v1/sessions/${seg(sid)}/permission`),
  sessionHistory: (sid, tail = 400) => get(`/v1/sessions/${seg(sid)}/history?tail=${tail}`),
  steer: (sid, message) => post(`/v1/sessions/${seg(sid)}/prompt`, { message }),
  // The answer POST is keyed by session only: check the pending ask is still
  // the one on screen first (a small race remains, as in the repo's panel).
  async answerPermission(sid, toolCallId, approved) {
    const cur = await get(`/v1/sessions/${seg(sid)}/permission`);
    if (!cur?.pending || cur.permission?.tool_call_id !== toolCallId) throw new Error("This ask changed; review it again");
    return post(`/v1/sessions/${seg(sid)}/permission`, { approved, option_id: "" });
  },
};

// The dashboard's own page for a thing, for "open in browser".
export const dashUrl = (path = "/") => DASHBOARD + path;
