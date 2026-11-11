import test from "node:test"; import assert from "node:assert/strict";
import { diffLines } from "../../mods/ado-prs/review/diff.js";

const sides = rows => [
  rows.filter(r => r.kind !== "add").map(r => r.text),
  rows.filter(r => r.kind !== "del").map(r => r.text),
];
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test("fully different 5000-line inputs finish fast and reconstruct both sides", () => {
  const a = lines("a", 5000), b = lines("b", 5000);
  const t0 = Date.now();
  const rows = diffLines(a, b);
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(sides(rows), [a, b]);
});
test("edit distance over the cost cap falls back to del-all/add-all", () => {
  const a = lines("a", 2500), b = lines("b", 2500);
  const rows = diffLines(a, b);
  assert.deepEqual(rows.map(r => r.kind), [...Array(2500).fill("del"), ...Array(2500).fill("add")]);
  assert.deepEqual(sides(rows), [a, b]);
});
test("edit distance just under the cap still diffs", () => {
  const a = [...lines("a", 1500), "same"], b = ["same", ...lines("b", 1500)];
  const rows = diffLines(a, b);
  assert.deepEqual(sides(rows), [a, b]);
  assert.ok(rows.some(r => r.kind === "ctx"));
});
test("seeded fuzz: every diff reconstructs both sides", () => {
  let seed = 12345;
  const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let t = 0; t < 500; t++) {
    const g = () => Array.from({ length: rnd(14) }, () => "abc"[rnd(3)]);
    const a = g(), b = g();
    assert.deepEqual(sides(diffLines(a, b)), [a, b], `a=${a} b=${b}`);
  }
});
