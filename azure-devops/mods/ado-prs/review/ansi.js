// ANSI SGR text → lines of colored spans. Pure (no herdr imports). SGR handling
// is copied from ado-pipelines/loglines.js. Colors are "#rrggbb" or theme names
// ("ansi0".."ansi15"); null means the default foreground. Colour state carries
// across lines until reset (multi-line comments).

const SGR = /\x1b\[([\d;]*)m/g;
const OTHER = /\x1b\[[\d;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1a\x1c-\x1f]/g;

const hex = (x) => (x ?? 0).toString(16).padStart(2, "0");

function xterm256(n) {
  if (n < 16) return `ansi${n}`;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return "#" + hex(v).repeat(3);
  }
  const i = n - 16, steps = [0, 95, 135, 175, 215, 255];
  return "#" + [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((x) => hex(steps[x])).join("");
}

/** text → Span[][] (one array per line); Span = {text, color, bold}. */
export function parseAnsi(text) {
  let color = null, bold = false;
  return text.split("\n").map((raw) => {
    const line = raw.replace(OTHER, "");
    const spans = [];
    const push = (t) => t && spans.push({ text: t, color, bold });
    let last = 0, m;
    SGR.lastIndex = 0;
    while ((m = SGR.exec(line))) {
      push(line.slice(last, m.index));
      last = SGR.lastIndex;
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) { color = null; bold = false; }
        else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c >= 30 && c <= 37) color = `ansi${c - 30}`;
        else if (c >= 90 && c <= 97) color = `ansi${c - 82}`;
        else if (c === 39) color = null;
        else if (c === 38 && codes[i + 1] === 5) { color = xterm256(codes[i + 2] ?? 7); i += 2; }
        else if (c === 38 && codes[i + 1] === 2) { color = "#" + codes.slice(i + 2, i + 5).map(hex).join(""); i += 4; }
        else if (c === 48 && (codes[i + 1] === 5 || codes[i + 1] === 2)) i += codes[i + 1] === 5 ? 2 : 4; // backgrounds: ignored
      }
    }
    push(line.slice(last));
    return spans;
  });
}

/** Theme colors → true when the background is dark (relative luminance < 0.5). */
export function isDarkTheme(colors) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(colors?.background ?? "");
  if (!m) return true;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** Trim (or pad with empty lines) to exactly `count` lines, e.g. bat's trailing newline. */
export function fitLines(lines, count) {
  const out = lines.slice(0, count);
  while (out.length < count) out.push([]);
  return out;
}
