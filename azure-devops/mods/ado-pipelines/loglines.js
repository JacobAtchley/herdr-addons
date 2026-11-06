// Azure Pipelines log highlighting. A log becomes lines of colored segments:
// ANSI colors when a tool printed them, otherwise colors from what the line is
// (##[error], ##[section], a command, a "Key : value" header) plus links.
// Colors are theme names ("ansi1", "dim", ...) or hex; main.js resolves them.

const SGR = /\x1b\[([\d;]*)m/g;
const OTHER = /\x1b\[[\d;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1a\x1c-\x1f]/g;
const URL = /https?:\/\/[^\s'"<>)\]]+/g;

// Kind → [color, bold] for text the tool didn't color.
const KIND = {
  error: ["ansi1", false],
  warning: ["ansi3", false],
  section: ["accent", true],
  finish: ["dim", false],
  command: ["ansi4", false],
  group: ["foreground", true],
  endgroup: ["dim", false],
  debug: ["dim", false],
  sep: ["dim", false],
  errword: ["ansi1", false],
  warnword: ["ansi3", false],
  ok: ["ansi2", false],
  shell: ["ansi6", false],
  plain: [null, false],
};

function xterm256(n) {
  if (n < 16) return `ansi${n}`;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return "#" + [v, v, v].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
  return "#" + [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((x) => steps[x].toString(16).padStart(2, "0")).join("");
}

// One raw line → segments by ANSI SGR state.
function ansiSegments(raw) {
  const line = raw.replace(OTHER, "");
  const segs = [];
  let color = null, bold = false, dim = false, last = 0, m;
  const push = (text) => text && segs.push({ text, color: dim && !color ? "dim" : color, bold });
  SGR.lastIndex = 0;
  while ((m = SGR.exec(line))) {
    push(line.slice(last, m.index));
    last = SGR.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { color = null; bold = false; dim = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c >= 30 && c <= 37) color = `ansi${c - 30}`;
      else if (c >= 90 && c <= 97) color = `ansi${c - 82}`;
      else if (c === 39) color = null;
      else if (c === 38 && codes[i + 1] === 5) { color = xterm256(codes[i + 2] ?? 7); i += 2; }
      else if (c === 38 && codes[i + 1] === 2) {
        color = "#" + codes.slice(i + 2, i + 5).map((x) => (x ?? 0).toString(16).padStart(2, "0")).join("");
        i += 4;
      } else if (c === 48 && (codes[i + 1] === 5 || codes[i + 1] === 2)) i += codes[i + 1] === 5 ? 2 : 4; // backgrounds: ignored
    }
  }
  push(line.slice(last));
  return segs;
}

// Drop the first n characters across segments (a ##[tag] prefix).
function dropPrefix(segs, n) {
  while (n > 0 && segs.length) {
    const s = segs[0];
    if (s.text.length <= n) { n -= s.text.length; segs.shift(); }
    else { s.text = s.text.slice(n); n = 0; }
  }
  return segs;
}

function classify(tag, plain) {
  switch (tag) {
    case "error": return "error";
    case "warning": return "warning";
    case "section": return /^Finishing:/.test(plain) ? "finish" : "section";
    case "command": return "command";
    case "group": return "group";
    case "endgroup": return "endgroup";
    case "debug": return "debug";
  }
  if (/^\s*[=─━-]{8,}/.test(plain) || /^\s*={3,}.*={3,}\s*$/.test(plain)) return "sep";
  if (/\b(error|ERR!|FAIL(ED)?|failed|fatal|exception|Unhandled)\b|✗|✘|❌/i.test(plain) && !/\b0 (errors?|failed)\b/i.test(plain)) return "errword";
  if (/\bwarn(ing)?s?\b|⚠/i.test(plain) && !/\b0 warn(ing)?s?\b/i.test(plain)) return "warnword";
  if (/\b(succeeded|success(fully)?|passed|PASS|Done)\b|✓|✔/.test(plain)) return "ok";
  if (/^\s*(\$|>|\+) \S/.test(plain) || /^\[command\]/.test(plain)) return "shell";
  return "plain";
}

// Color text the tool left uncolored: kind's color, "Key : value" headers, links.
function decorate(segs, kind, plain) {
  const [kc, kb] = KIND[kind];
  const out = [];
  const header = kind === "plain" ? plain.match(/^(\S[\w .()/-]{0,30}?\s+): (.+)$/) : null;
  for (const s of segs) {
    if (s.color) { out.push(s); continue; }
    let text = s.text;
    if (header && out.length === 0 && text.startsWith(header[1] + ": ")) {
      out.push({ text: header[1] + ": ", color: "dim", bold: false });
      text = text.slice(header[1].length + 2);
    }
    let last = 0, m;
    URL.lastIndex = 0;
    while ((m = URL.exec(text))) {
      if (m.index > last) out.push({ text: text.slice(last, m.index), color: kc, bold: s.bold || kb });
      out.push({ text: m[0], color: "accent", bold: false, url: true });
      last = URL.lastIndex;
    }
    if (last < text.length) out.push({ text: text.slice(last), color: kc, bold: s.bold || kb });
  }
  return out;
}

/** text → [{ n, kind, segs: [{text, color, bold, url?}], plain }] */
export function parseLog(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let segs = ansiSegments(lines[i]);
    let plain = segs.map((s) => s.text).join("");
    const tag = plain.match(/^##\[(\w+)\]/);
    if (tag) {
      segs = dropPrefix(segs, tag[0].length);
      plain = plain.slice(tag[0].length);
    } else if (/^\[command\]/.test(plain)) {
      segs = dropPrefix(segs, 9);
      plain = plain.slice(9);
      out.push({ n: i + 1, kind: "command", segs: decorate([{ text: "$ " + plain, color: null, bold: false }], "command", plain), plain });
      continue;
    }
    const kind = classify(tag?.[1]?.toLowerCase(), plain);
    out.push({ n: i + 1, kind, segs: decorate(segs, kind, plain), plain });
  }
  // A trailing newline leaves one empty line; drop it.
  if (out.length && !out[out.length - 1].plain) out.pop();
  return out;
}

export const isProblem = (l) => l.kind === "error" || l.kind === "warning" || l.kind === "errword" || l.kind === "warnword";
export const plainText = (lines) => lines.map((l) => l.plain).join("\n");
