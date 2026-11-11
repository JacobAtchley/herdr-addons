import test from "node:test"; import assert from "node:assert/strict";
import { splitLines, diffLines, toHunks, toSplit } from "../../mods/ado-prs/review/diff.js";

test("crlf and trailing newline are not changes", () => {
  const rows = diffLines(splitLines("a\r\nb\r\n"), splitLines("a\nb"));
  assert.deepEqual(rows.map(r => r.kind), ["ctx", "ctx"]);
});
test("splitLines handles empty and null", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines(null), []);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
});
test("edit in the middle", () => {
  const rows = diffLines(["a", "b", "c"], ["a", "B", "c"]);
  assert.deepEqual(rows.map(r => [r.kind, r.oldNo, r.newNo, r.text]),
    [["ctx",1,1,"a"],["del",2,null,"b"],["add",null,2,"B"],["ctx",3,3,"c"]]);
});
test("added and deleted files", () => {
  assert.deepEqual(diffLines([], ["x","y"]).map(r => r.kind), ["add","add"]);
  assert.deepEqual(diffLines(["x"], []).map(r => r.kind), ["del"]);
});
test("hunks collapse long unchanged runs", () => {
  const old = Array.from({length: 20}, (_, i) => `l${i}`); const neu = [...old]; neu[10] = "X";
  const segs = toHunks(diffLines(old, neu), 3);
  assert.deepEqual(segs.map(s => s.type), ["gap","rows","gap"]);
  assert.equal(segs[0].count, 7); assert.equal(segs[2].count, 6);
  assert.equal(segs[0].oldNo, 1); assert.equal(segs[2].oldNo, 15);
});
test("split zips del/add runs", () => {
  const pairs = toSplit(diffLines(["a","b","c"], ["a","B","B2","c"]));
  assert.deepEqual(pairs.map(p => [p.left?.text ?? null, p.right?.text ?? null]),
    [["a","a"],["b","B"],[null,"B2"],["c","c"]]);
});
test("larger diff reconstructs both sides", () => {
  const old = "the quick brown fox jumps over the lazy dog again and again".split(" ");
  const neu = "a quick red fox leaps over the lazy cat and again then".split(" ");
  const rows = diffLines(old, neu);
  assert.deepEqual(rows.filter(r => r.kind !== "add").map(r => r.text), old);
  assert.deepEqual(rows.filter(r => r.kind !== "del").map(r => r.text), neu);
});
test("oversized input falls back to del-all/add-all", () => {
  const big = Array.from({length: 20001}, (_, i) => `l${i}`);
  const rows = diffLines(big, ["x"]);
  assert.equal(rows.length, 20002);
  assert.equal(rows.filter(r => r.kind === "del").length, 20001);
  assert.equal(rows.at(-1).kind, "add");
});
