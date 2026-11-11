// Syntax highlighting by shelling out to bat. Not unit-tested (needs herdr).
// exec has no stdin, so the source goes through a temp file in the app cache.
import { exec, appHome } from "herdr";
import { mkdir, writeFile } from "fs/promises";
import { parseAnsi } from "./ansi.js";

const BATS = ["bat", "/opt/homebrew/bin/bat", "/usr/local/bin/bat"];
const memo = new Map();
let batPath; // undefined = not probed yet, null = not found
let dirReady = false;

// Pure-JS string hash (two 32-bit FNV-1a lanes → 16 hex chars); no crypto needed.
function hash(s) {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b) + i | 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

async function findBat() {
  if (batPath !== undefined) return batPath;
  batPath = null;
  for (const p of BATS) {
    try {
      const r = await exec(p, ["--version"], { timeout: 5000 });
      if (r.code === 0) { batPath = p; break; }
    } catch { /* not at this path */ }
  }
  return batPath;
}

export async function batAvailable() {
  return (await findBat()) !== null;
}

async function ensureDir(dir) {
  if (dirReady) return;
  try { await mkdir(dir, { recursive: true }); }
  catch { await exec("mkdir", ["-p", dir]); }
  dirReady = true;
}

/** → Span[][] for `text` as the language of `path`, or null (no bat / bat failed). */
export async function highlightFile(path, text, dark) {
  const key = hash(path + "\0" + dark + "\0" + text);
  if (memo.has(key)) return memo.get(key);
  const bat = await findBat();
  if (!bat) return null;
  let result = null;
  try {
    const dir = `${appHome()}/cache/ado-prs/hl`;
    await ensureDir(dir);
    const file = `${dir}/${key}.src`;
    await writeFile(file, text);
    const r = await exec(bat, [
      "--color=always", "--style=plain", "--paging=never", "--tabs=4",
      `--file-name=${path}`, `--theme=${dark ? "Catppuccin Mocha" : "Catppuccin Latte"}`, file,
    ], { timeout: 15000 });
    if (r.code === 0) result = parseAnsi(r.stdout);
  } catch { /* leave null */ }
  memo.set(key, result);
  return result;
}
