// Azure DevOps REST over `az rest` (the az login). Copied from
// ado-workitems/ado.js (mods don't share modules). Callers put api-version in
// the URL.
import { exec } from "herdr";

export const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

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

/** rest(method, url, body?) → parsed JSON (null for an empty response). */
export const rest = (method, url, body) =>
  az(["rest", "--resource", ADO_RESOURCE, "--method", method, "-u", url,
    ...(body !== undefined ? ["--headers", "Content-Type=application/json", "--body", JSON.stringify(body)] : []),
    "-o", "json"]).then((out) => (out.trim() ? JSON.parse(out) : null));
