import test from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../../mods/ado-prs/review/diff.js";
import { placeDrafts } from "../../mods/ado-prs/review/anchor.js";
import {
  tooLarge, sinceLastLook, displayItems, numWidth, gutterWidth, lineAt, actionAt, selectLines, lineLengths, draftFits,
  ACTION_W, ACTION_GAP, MAX_LINES, wordChunks,
} from "../../mods/ado-prs/review/rows.js";

const L = (n, p = "l") => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

test("tooLarge: lines and size limits, trailing newline not counted", () => {
  assert.equal(tooLarge(null), false);
  assert.equal(tooLarge("a\nb\n"), false);
  assert.equal(tooLarge(L(MAX_LINES).join("\n") + "\n"), false);
  assert.equal(tooLarge(L(MAX_LINES + 1).join("\n")), true);
  assert.equal(tooLarge("x".repeat(1000001)), true);
});

test("sinceLastLook: available only for an older, existing version", () => {
  const v = { latest: 4, all: [1, 2, 3, 4] };
  assert.deepEqual(sinceLastLook(2, v).available, true);
  assert.equal(sinceLastLook(2, v).from, 2);
  assert.equal(sinceLastLook(null, v).available, false);
  assert.match(sinceLastLook(null, v).reason, /No earlier visit/);
  assert.equal(sinceLastLook(4, v).available, false);
  assert.match(sinceLastLook(4, v).reason, /No new pushes/);
  assert.equal(sinceLastLook(9, { latest: 12, all: [10, 12] }).available, false);
  assert.equal(sinceLastLook(NaN, v).available, false);
});

// 20 lines, line 10 changed.
const oldL = L(20), newL = L(20);
newL[9] = "changed";
const rows = diffLines(oldL, newL); // 9 ctx, del(old10), add(new10), 10 ctx

test("displayItems unified: hunk with 3 context lines and gaps around it", () => {
  const items = displayItems(rows, { mode: "unified" });
  assert.deepEqual(items.map((x) => x.type), ["gap", "row", "row", "row", "row", "row", "row", "row", "row", "gap"]);
  assert.deepEqual(items[0], { type: "gap", start: 0, end: 6, count: 6, oldNo: 1, newNo: 1 });
  assert.equal(items[1].idx, 6);
  assert.equal(items[4].row.kind, "del");
  assert.equal(items.at(-1).count, 7);
});

test("displayItems: pinned rows show with context and get an attach item; shown rows expand a gap", () => {
  const items = displayItems(rows, { mode: "unified", pinned: new Set([0, 4]) });
  assert.deepEqual(items.slice(0, 3).map((x) => x.type), ["row", "attach", "row"]);
  assert.deepEqual(items[1], { type: "attach", idx: 0 });
  assert.ok(items.some((x) => x.type === "attach" && x.idx === 4));
  const all = displayItems(rows, { shown: new Set(rows.map((_, i) => i)) });
  assert.equal(all.filter((x) => x.type === "gap").length, 0);
  assert.equal(all.length, rows.length);
});

test("displayItems split: del/add paired with their indices; attach dedupes ctx rows", () => {
  const items = displayItems(rows, { mode: "split", pinned: new Set([9, 10, 7]) });
  const pair = items.find((x) => x.type === "pair" && x.left?.row.kind === "del");
  assert.equal(pair.left.idx, 9);
  assert.equal(pair.right.idx, 10);
  const after = items[items.indexOf(pair) + 1];
  const after2 = items[items.indexOf(pair) + 2];
  assert.deepEqual([after, after2], [{ type: "attach", idx: 9 }, { type: "attach", idx: 10 }]);
  assert.equal(items.filter((x) => x.type === "attach" && x.idx === 7).length, 1);
});

const numW = numWidth(20);
test("geometry", () => {
  assert.ok(numW >= 20);
  assert.equal(gutterWidth("unified", numW), 2 * numW + 16);
  assert.equal(gutterWidth("split", numW), numW + 16);
});

test("lineAt unified: del rows map to the old side, add/ctx to the new side; code area is not a hit", () => {
  const del = { type: "row", idx: 9, row: rows[9] };
  const add = { type: "row", idx: 10, row: rows[10] };
  const ctx = { type: "row", idx: 2, row: rows[2] };
  const geo = { mode: "unified", width: 800, numW };
  assert.deepEqual(lineAt(del, 3, geo), { side: "left", line: 10, idx: 9 });
  assert.deepEqual(lineAt(add, numW + 2, geo), { side: "right", line: 10, idx: 10 });
  assert.deepEqual(lineAt(ctx, 3, geo), { side: "right", line: 3, idx: 2 });
  assert.equal(lineAt(del, 2 * numW + 16 + 5, geo), null);
  assert.equal(lineAt({ type: "gap" }, 1, geo), null);
});

test("lineAt split: left column → left side by old number, right column → right side", () => {
  const geo = { mode: "split", width: 1000, numW };
  const pair = { type: "pair", left: { idx: 9, row: rows[9] }, right: { idx: 10, row: rows[10] } };
  const ctx = { type: "pair", left: { idx: 2, row: rows[2] }, right: { idx: 2, row: rows[2] } };
  const addOnly = { type: "pair", left: null, right: { idx: 10, row: rows[10] } };
  assert.deepEqual(lineAt(pair, 4, geo), { side: "left", line: 10, idx: 9 });
  assert.deepEqual(lineAt(pair, 504, geo), { side: "right", line: 10, idx: 10 });
  assert.deepEqual(lineAt(ctx, 4, geo), { side: "left", line: 3, idx: 2 });
  assert.equal(lineAt(addOnly, 4, geo), null);
  assert.equal(lineAt(pair, 300, geo), null);
});

test("actionAt: fixed-width buttons from an origin", () => {
  const acts = ["reply", "resolve"];
  assert.equal(actionAt(5, 20, acts), null); // left of the origin
  assert.equal(actionAt(25, 20, acts), "reply");
  assert.equal(actionAt(20 + ACTION_W + 1, 20, acts), null); // in the gap
  assert.equal(actionAt(20 + ACTION_W + ACTION_GAP + 1, 20, acts), "resolve");
  assert.equal(actionAt(20 + 3 * (ACTION_W + ACTION_GAP), 20, acts), null);
});

test("selectLines: shift-click on the same side makes an ordered range", () => {
  assert.deepEqual(selectLines(null, { side: "right", line: 5 }, true), { side: "right", line: 5 });
  assert.deepEqual(selectLines({ side: "right", line: 9 }, { side: "right", line: 5 }, true), { side: "right", line: 5, endLine: 9 });
  assert.deepEqual(selectLines({ side: "left", line: 9 }, { side: "right", line: 5 }, true), { side: "right", line: 5 });
  assert.deepEqual(selectLines({ side: "right", line: 9 }, { side: "right", line: 5 }, false), { side: "right", line: 5 });
  assert.deepEqual(selectLines({ side: "right", line: 5 }, { side: "right", line: 5 }, true), { side: "right", line: 5 });
});

test("lineLengths uses the side's own text (old text for left)", () => {
  const r = diffLines(["abc", "hello"], ["abc", "hi"]);
  assert.deepEqual(lineLengths(r, "left", 2), { lineLength: 5, endLineLength: 5 });
  assert.deepEqual(lineLengths(r, "right", 1, 2), { lineLength: 3, endLineLength: 2 });
  assert.deepEqual(lineLengths(r, "right", 99), { lineLength: 0, endLineLength: 0 });
});

test("wordChunks: words keep trailing spaces and their span's color; indentation and tabs kept", () => {
  const out = wordChunks([{ text: "\tpublic ", color: "#c", bold: false }, { text: "int x;", color: null, bold: true }]);
  assert.deepEqual(out.map((c) => c.text), ["    ", "public ", "int ", "x;"]);
  assert.deepEqual(out.map((c) => c.color), ["#c", "#c", null, null]);
  assert.equal(out[3].bold, true);
  assert.equal(out.map((c) => c.text).join(""), "    public int x;");
  assert.deepEqual(wordChunks([{ text: "" }]), []);
});

test("draftFits: left drafts need the same base, right drafts the same latest push; legacy drafts fit", () => {
  assert.equal(draftFits({ side: "left", range: { from: 2, to: 4 } }, { from: 2, to: 5 }), true);
  assert.equal(draftFits({ side: "left", range: { from: null, to: 4 } }, { from: 2, to: 4 }), false);
  // Right side: fresh (same `to`, base irrelevant) vs stale (a newer push moved the lines).
  assert.equal(draftFits({ side: "right", range: { from: null, to: 4 } }, { from: 2, to: 4 }), true);
  assert.equal(draftFits({ side: "right", range: { from: null, to: 3 } }, { from: null, to: 4 }), false);
  assert.equal(draftFits({ side: "left" }, { from: 2, to: 4 }), true);
  assert.equal(draftFits({ side: "right" }, { from: 2, to: 4 }), true);
});

test("a stale right-side draft goes to unplaced instead of re-anchoring on the same line number", () => {
  // Draft on right line 3 written at iteration 3; iteration 4 inserted lines above it.
  const rows = diffLines(["a", "b"], ["x", "y", "a", "b"]);
  const draft = { key: "k", target: { file: "f", side: "right", line: 3, range: { from: null, to: 3 } }, body: "on b" };
  const range = { from: null, to: 4 };
  const fits = [draft].filter((d) => draftFits(d.target, range));
  assert.equal(fits.length, 0);
  assert.equal(placeDrafts(rows, fits, "f").byRow.size, 0);
});
