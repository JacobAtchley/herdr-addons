// Azure DevOps over `az rest` (the az login), shared by the list and the
// details view.
import { exec } from "herdr";

export const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
// States treated as finished.
export const DONE_STATES = ["Closed", "Done", "Removed", "Completed", "Cut"];
export const FIELDS = [
  "System.Id", "System.Title", "System.TeamProject", "System.WorkItemType", "System.State",
  "System.ChangedDate", "System.CreatedDate", "System.IterationPath", "Microsoft.VSTS.Common.Priority", "System.Tags",
  "System.AssignedTo", "System.AreaPath",
];

const AZ = ["az", "/opt/homebrew/bin/az", "/usr/local/bin/az"];
export async function az(args) {
  let last;
  for (const bin of AZ) {
    let r;
    try {
      r = await exec(bin, args);
    } catch (e) {
      // Couldn't start this az: try the next path.
      last = e;
      continue;
    }
    if (r.code !== 0 && r.code != null) {
      const msg = (r.stderr || "az failed").trim().split("\n").filter((l) => !/^WARNING/.test(l)).pop() || "az failed";
      // ADO errors arrive as `ERROR: Not Found({..."message":"..."})`.
      const m = msg.match(/"message":"((?:[^"\\]|\\.)*)"/);
      throw new Error(m ? JSON.parse(`"${m[1]}"`) : msg);
    }
    return r.stdout;
  }
  throw last;
}

const rest = (method, url, { body, query, contentType = "application/json" } = {}) =>
  az(["rest", "--resource", ADO_RESOURCE, "--method", method, "-u", url,
    ...(body !== undefined ? ["--headers", `Content-Type=${contentType}`, "--body", JSON.stringify(body)] : []),
    ...(query ? ["--query", query] : []), "-o", "json"]).then((out) => (out.trim() ? JSON.parse(out) : null));

export const get = (url, query) => rest("get", url, { query });
export const post = (url, body, query) => rest("post", url, { body, query });
export const patch = (url, ops) => rest("patch", url, { body: ops, contentType: "application/json-patch+json" });

export async function defaultOrg() {
  const cfg = await az(["devops", "configure", "-l"]);
  const m = cfg.match(/organization\s*=\s*(\S+)/);
  if (!m) throw new Error("no org: set ado.org in addons.json or run az devops configure -d organization=…");
  return m[1].replace(/\/+$/, "").split("/").pop();
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const lastSegment = (path) => (path ?? "").split("\\").pop();
export const isDone = (state) => DONE_STATES.some((s) => s.toLowerCase() === (state ?? "").toLowerCase());

export function toItem(f) {
  return {
    id: f["System.Id"], title: f["System.Title"], project: f["System.TeamProject"], type: f["System.WorkItemType"],
    state: f["System.State"], changed: f["System.ChangedDate"], created: f["System.CreatedDate"],
    iteration: f["System.IterationPath"], area: f["System.AreaPath"], priority: f["Microsoft.VSTS.Common.Priority"],
    assignee: f["System.AssignedTo"]?.displayName ?? null,
    tags: (f["System.Tags"] ?? "").split(";").map((x) => x.trim()).filter(Boolean),
  };
}

// Work item type → theme color (unknown types: dim).
export function typeColor(t, type) {
  const k = (type ?? "").toLowerCase();
  if (k.includes("bug") || k.includes("defect")) return t.ansi1;
  if (k.includes("feature") || k.includes("epic")) return t.ansi5;
  if (k.includes("story")) return k.includes("technical") ? t.ansi6 : t.ansi4;
  if (k.includes("task")) return t.ansi3;
  if (k.includes("enhancement")) return t.ansi2;
  return t.dim;
}
// State → color by what it usually means.
export function stateColor(t, state) {
  const k = (state ?? "").toLowerCase();
  if (isDone(state)) return t.ansi2;
  if (k.includes("fail") || k.includes("block")) return t.ansi1;
  if (k.includes("qa") || k.includes("test") || k.includes("review") || k.includes("resolved")) return t.ansi3;
  if (k.includes("hold")) return t.dim;
  if (k === "new" || k.includes("proposed") || k === "to do") return t.muted;
  return t.ansi4; // active / in progress
}
