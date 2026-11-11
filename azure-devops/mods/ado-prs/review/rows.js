// Pure display model for the file page: which diff rows show (hunks, expanded
// gaps), unified vs split items, what a click at x on a row means, line
// lengths for new threads, "since last look" availability, size limits.
// No herdr/gpui imports (unit-tested in Node).
import { toSplit } from "./diff.js";

export const MAX_LINES = 20000;
export const MAX_CHARS = 1000000; // ~1 MB of text

/** True when a file version is too large to diff/show (more than 20 000 lines or ~1 MB). */
export function tooLarge(text) {
  if (text == null) return false;
  if (text.length > MAX_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    if (++lines > MAX_LINES + 1) return true;
  }
  return lines - (text.endsWith("\n") ? 1 : 0) > MAX_LINES;
}

/**
 * "Since last look" availability. `lastLook` is the latest version seen on the
 * previous visit (read before this visit overwrote it).
 * → {available, from, reason}
 */
export function sinceLastLook(lastLook, versions) {
  const latest = versions?.latest;
  if (lastLook == null || !Number.isFinite(lastLook)) return { available: false, from: null, reason: "No earlier visit recorded for this pull request" };
  if (latest == null || lastLook >= latest) return { available: false, from: null, reason: "No new pushes since your last look" };
  if (!(versions.all ?? []).includes(lastLook)) return { available: false, from: null, reason: "Your last look's version no longer exists" };
  return { available: true, from: lastLook, reason: `Changes pushed after version ${lastLook}` };
}

/**
 * Display items for a file's diff rows.
 * @param rows diffLines() output
 * @param opts.mode 'unified'|'split'
 * @param opts.context unchanged lines kept around changes
 * @param opts.pinned Set of row indices with threads/drafts/composers: always shown, followed by an 'attach' item
 * @param opts.shown Set of row indices the user expanded out of gaps
 * Items: {type:'row', idx, row} | {type:'pair', left:{idx,row}|null, right:{idx,row}|null}
 *      | {type:'gap', start, end, count, oldNo, newNo} | {type:'attach', idx}
 */
export function displayItems(rows, { mode = "unified", context = 3, pinned = new Set(), shown = new Set() } = {}) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (shown.has(i)) keep[i] = true;
    if (r.kind === "ctx" && !pinned.has(i)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const index = new Map(rows.map((r, i) => [r, i]));
  const items = [];
  let i = 0;
  while (i < rows.length) {
    const start = i;
    const visible = keep[i];
    while (i < rows.length && keep[i] === visible) i++;
    if (!visible) {
      items.push({ type: "gap", start, end: i, count: i - start, oldNo: rows[start].oldNo, newNo: rows[start].newNo });
      continue;
    }
    const run = rows.slice(start, i);
    if (mode === "split") {
      for (const p of toSplit(run)) {
        const l = p.left ? { idx: index.get(p.left), row: p.left } : null;
        const r = p.right ? { idx: index.get(p.right), row: p.right } : null;
        items.push({ type: "pair", left: l, right: r });
        const at = [...new Set([l?.idx, r?.idx].filter((x) => x != null && pinned.has(x)))];
        for (const idx of at) items.push({ type: "attach", idx });
      }
    } else {
      run.forEach((row, k) => {
        items.push({ type: "row", idx: start + k, row });
        if (pinned.has(start + k)) items.push({ type: "attach", idx: start + k });
      });
    }
  }
  return items;
}

/**
 * Split colored spans into word-sized pieces (a word keeps its trailing
 * spaces; leading indentation is its own piece) so a wrapping row breaks
 * between words rather than between whole spans. Tabs become 4 spaces.
 */
export function wordChunks(spans) {
  const out = [];
  for (const s of spans) {
    const text = String(s.text ?? "").replace(/\t/g, "    ");
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) out.push({ ...s, text: piece });
  }
  return out;
}

// ---- geometry (shared by the renderer and the click mapping) -------------

export const CHAR_W = 7.3; // monospace advance at 12 px, rounded up
export const MARK_W = 16; // the +/- column
export const ACTION_W = 84; // fixed width of a hit-tested action button
export const ACTION_GAP = 6;

/** Width of one line-number column for a file whose longest number is `maxLine`. */
export function numWidth(maxLine) {
  return Math.ceil(String(Math.max(1, maxLine ?? 1)).length * CHAR_W) + 14;
}

/** The clickable gutter width: unified = old no + new no + marker; split = one column's no + marker. */
export function gutterWidth(mode, numW) {
  return mode === "split" ? numW + MARK_W : 2 * numW + MARK_W;
}

/**
 * What a click at `x` (pixels from the list's left edge, list `width` wide)
 * on a display item means: {side, line, idx} when it hit a line number, else null.
 * Unified: del rows → left (old number); add/ctx rows → right (new number).
 * Split: the left column → left, the right column → right.
 */
export function lineAt(item, x, { mode, width, numW }) {
  const g = gutterWidth(mode, numW);
  if (item?.type === "row") {
    if (x < 0 || x >= g) return null;
    const r = item.row;
    return r.kind === "del" ? { side: "left", line: r.oldNo, idx: item.idx } : { side: "right", line: r.newNo, idx: item.idx };
  }
  if (item?.type === "pair") {
    const half = width / 2;
    if (x >= 0 && x < g && item.left) return { side: "left", line: item.left.row.oldNo, idx: item.left.idx };
    if (x >= half && x < half + g && item.right) return { side: "right", line: item.right.row.newNo, idx: item.right.idx };
  }
  return null;
}

/** Which of `actions` (laid out left to right from `origin`, ACTION_W each, ACTION_GAP apart) is at x. */
export function actionAt(x, origin, actions) {
  const dx = x - origin;
  if (dx < 0) return null;
  const i = Math.floor(dx / (ACTION_W + ACTION_GAP));
  if (i >= actions.length || dx - i * (ACTION_W + ACTION_GAP) >= ACTION_W) return null;
  return actions[i];
}

/**
 * The comment target after clicking a line. A shift-click on the same side as
 * the previous anchor makes a range (line..endLine, ordered); anything else
 * starts a single-line target at the clicked line.
 */
export function selectLines(anchor, hit, shift) {
  if (shift && anchor && anchor.side === hit.side && anchor.line !== hit.line) {
    return { side: hit.side, line: Math.min(anchor.line, hit.line), endLine: Math.max(anchor.line, hit.line) };
  }
  return { side: hit.side, line: hit.line };
}

/** Line text lengths for a new thread's offsets: {lineLength, endLineLength}. */
export function lineLengths(rows, side, line, endLine) {
  const key = side === "left" ? "oldNo" : "newNo";
  const len = (n) => rows.find((r) => r[key] === n)?.text.length ?? 0;
  return { lineLength: len(line), endLineLength: len(endLine ?? line) };
}

/**
 * Whether a file draft can be placed in the diff for `range`. Its line numbers
 * belong to one version: left = the base (range.from; in All changes, from is
 * null and the base is the merge base of range.to, which moves with the
 * target branch), right = the latest push (range.to). A draft written against
 * another version is not placed (it is listed as unplaced) so it can never
 * post on a shifted line. Drafts saved without a range (older format) are
 * placed by line.
 */
export function draftFits(target, range) {
  if (!target?.range) return true;
  if (target.side === "left") {
    const from = target.range.from ?? null;
    if (from !== (range?.from ?? null)) return false;
    return from != null || target.range.to === range?.to;
  }
  return target.range.to === range?.to;
}
