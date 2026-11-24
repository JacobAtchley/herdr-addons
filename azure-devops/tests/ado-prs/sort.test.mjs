import test from "node:test";
import assert from "node:assert/strict";
import { parseSort, formatSort, nextSort, sortPrs, DEFAULT_SORT } from "../../mods/ado-prs/sort.js";

const P = (id, o = {}) => ({ id, title: `PR ${id}`, author: "A", created: `2026-11-${String(10 + id).padStart(2, "0")}T00:00:00Z`, reviewers: [], ...o });
const ids = (list) => list.map((p) => p.id);

test("parseSort/formatSort round-trip; junk falls back to newest first", () => {
  assert.deepEqual(parseSort("votes:desc"), { key: "votes", dir: "desc" });
  assert.equal(formatSort(parseSort("title:asc")), "title:asc");
  assert.deepEqual(parseSort(null), DEFAULT_SORT);
  assert.deepEqual(parseSort("nope:asc"), DEFAULT_SORT);
  assert.deepEqual(parseSort("title:sideways"), DEFAULT_SORT);
});

test("nextSort flips the same column, starts a new one at its first direction", () => {
  assert.deepEqual(nextSort({ key: "age", dir: "asc" }, "age"), { key: "age", dir: "desc" });
  assert.deepEqual(nextSort({ key: "age", dir: "asc" }, "feedback"), { key: "feedback", dir: "desc" });
  assert.deepEqual(nextSort({ key: "age", dir: "asc" }, "title"), { key: "title", dir: "asc" });
});

test("age asc is newest first; desc oldest first", () => {
  const prs = [P(1), P(3), P(2)];
  assert.deepEqual(ids(sortPrs(prs, { key: "age", dir: "asc" })), [3, 2, 1]);
  assert.deepEqual(ids(sortPrs(prs, { key: "age", dir: "desc" })), [1, 2, 3]);
  assert.deepEqual(ids(prs), [1, 3, 2], "input untouched");
});

test("title and author sort case-insensitively, ties newest first", () => {
  const prs = [P(1, { title: "beta", author: "zed" }), P(2, { title: "Alpha", author: "amy" }), P(3, { title: "alpha", author: "Amy" })];
  assert.deepEqual(ids(sortPrs(prs, { key: "title", dir: "asc" })), [3, 2, 1]);
  assert.deepEqual(ids(sortPrs(prs, { key: "author", dir: "desc" })), [1, 3, 2]);
});

test("votes: rejects lowest, then waits, then by approvals", () => {
  const prs = [
    P(1, { reviewers: [{ vote: 10 }, { vote: 10 }] }),
    P(2, { reviewers: [{ vote: 10 }, { vote: -10 }] }),
    P(3, { reviewers: [{ vote: -5 }] }),
    P(4, { reviewers: [{ vote: 5 }] }),
    P(5, { reviewers: [{ vote: 0, group: true }] }),
  ];
  assert.deepEqual(ids(sortPrs(prs, { key: "votes", dir: "desc" })), [1, 4, 5, 3, 2]);
});

test("feedback: by unresolved then total; unloaded/errored always last", () => {
  const prs = [P(1), P(2), P(3), P(4), P(5)];
  const threads = { 1: { open: 0, resolved: 3 }, 2: { open: 2, resolved: 1 }, 3: { open: 2, resolved: 0 }, 4: { error: "x" } };
  assert.deepEqual(ids(sortPrs(prs, { key: "feedback", dir: "desc" }, { threads })), [2, 3, 1, 5, 4]);
  assert.deepEqual(ids(sortPrs(prs, { key: "feedback", dir: "asc" }, { threads })), [1, 3, 2, 5, 4]);
});

test("ready: ready first, then waiting, then blocked (fewer blockers first); unloaded last", () => {
  const prs = [P(1), P(2), P(3), P(4), P(5), P(6)];
  const ready = {
    1: { state: "blocked", blockers: ["a"] },
    2: { state: "ready", blockers: [] },
    3: { state: "waiting", blockers: ["a", "b"] },
    4: { state: "waiting", blockers: ["a"] },
    5: { error: "x" },
  };
  assert.deepEqual(ids(sortPrs(prs, { key: "ready", dir: "desc" }, { ready })), [2, 4, 3, 1, 6, 5]);
});
