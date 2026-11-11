import test from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../../mods/ado-prs/review/diff.js";
import { placeThreads, placeDrafts } from "../../mods/ado-prs/review/anchor.js";

const rows = diffLines(["a", "b", "c"], ["a", "B", "c"]); // ctx a, del b(old2), add B(new2), ctx c
const T = (id, path, side, startLine, endLine) => ({ id, file: { path, side, startLine, endLine } });

test("right side attaches to new line", () => {
  const { byRow } = placeThreads(rows, [T(1, "x", "right", 2)], "x");
  assert.deepEqual([...byRow.keys()], [2]);
});
test("left side attaches to old line", () => {
  const { byRow } = placeThreads(rows, [T(1, "x", "left", 2)], "x");
  assert.deepEqual([...byRow.keys()], [1]);
});
test("left side on unchanged line attaches to ctx row by oldNo", () => {
  const { byRow } = placeThreads(rows, [T(1, "x", "left", 3)], "x");
  assert.deepEqual([...byRow.keys()], [3]);
});
test("right side on unchanged line attaches to ctx row by newNo", () => {
  const { byRow } = placeThreads(rows, [T(1, "x", "right", 1)], "x");
  assert.deepEqual([...byRow.keys()], [0]);
});
test("endLine preferred over startLine", () => {
  const { byRow } = placeThreads(rows, [T(1, "x", "right", 1, 3)], "x");
  assert.deepEqual([...byRow.keys()], [3]);
});
test("missing line is outdated; other files and null file ignored", () => {
  const r = placeThreads(rows, [T(1, "x", "right", 99), T(2, "y", "right", 1), { id: 3, file: null }], "x");
  assert.deepEqual(r.outdated.map((t) => t.id), [1]);
  assert.equal(r.byRow.size, 0);
});
test("multiple threads on one row keep input order", () => {
  const { byRow } = placeThreads(rows, [T(5, "x", "right", 2), T(3, "x", "right", 2)], "x");
  assert.deepEqual(byRow.get(2).map((t) => t.id), [5, 3]);
});
test("placeDrafts places only file drafts for this path", () => {
  const d = (key, target) => ({ key, target, body: "b", updated: 0 });
  const r = placeDrafts(rows, [
    d("a", { file: "x", side: "right", line: 2 }),
    d("b", { file: "x", side: "left", line: 1, endLine: 9 }),
    d("c", { file: "y", side: "right", line: 1 }),
    d("d", { thread: 7 }),
    d("e", { general: true }),
  ], "x");
  assert.deepEqual(r.byRow.get(2).map((x) => x.key), ["a"]);
  assert.deepEqual(r.outdated.map((x) => x.key), ["b"]);
  assert.equal(r.byRow.size, 1);
});
test("a null/undefined line is outdated, never matched to an add/del row's null number", () => {
  const t = placeThreads(rows, [T(1, "x", "left", null), T(2, "x", "right", undefined)], "x");
  assert.deepEqual(t.outdated.map((x) => x.id), [1, 2]);
  assert.equal(t.byRow.size, 0);
  const d = placeDrafts(rows, [{ key: "a", target: { file: "x", side: "right", line: null } }], "x");
  assert.deepEqual(d.outdated.map((x) => x.key), ["a"]);
  assert.equal(d.byRow.size, 0);
});
