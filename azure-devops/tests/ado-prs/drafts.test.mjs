import { test } from "node:test";
import assert from "node:assert/strict";
import { Drafts, draftKey, prKey } from "../../mods/ado-prs/review/drafts.js";

const DAY = 864e5;
function mem(initial) {
  let s = initial;
  return { load: async () => s, save: async (o) => { s = structuredClone(o); }, peek: () => s };
}

test("keys", () => {
  assert.equal(draftKey({ thread: 12 }), "t:12");
  assert.equal(draftKey({ file: "src/A.cs", side: "right", line: 43, endLine: 45 }), "f:right:src/A.cs:43-45");
  assert.equal(draftKey({ file: "src/A.cs", side: "left", line: 7 }), "f:left:src/A.cs:7-7");
  assert.equal(draftKey({ general: true }), "g");
  assert.equal(prKey({ org: "o", project: "p", repoId: "r", id: 5 }), "o/r/5");
});

test("prunes drafts older than 7 days across PRs", async () => {
  const now = 100 * DAY;
  const m = mem({
    "o/r/1": { g: { body: "old", target: { general: true }, updated: now - 8 * DAY } },
    "o/r/2": { g: { body: "new", target: { general: true }, updated: now - 6 * DAY } },
  });
  const d = new Drafts({ ...m, now: () => now });
  await d.open("o/r/2");
  assert.equal(d.get("g").body, "new");
  assert.equal(m.peek()["o/r/1"], undefined);
  assert.equal(m.peek()["o/r/2"].g.body, "new");
});

test("empty body deletes", async () => {
  const m = mem(null);
  const d = new Drafts({ ...m, now: () => 1 });
  await d.open("o/r/1");
  d.set("g", { general: true }, "hi");
  d.set("g", { general: true }, "");
  assert.equal(d.get("g"), null);
  await d.flush();
  assert.deepEqual(m.peek() ?? {}, {});
});

test("set persists on flush, list scoped to open PR, empty PR maps removed", async () => {
  const m = mem({ "o/r/9": { g: { body: "x", target: { general: true }, updated: 5 } } });
  const d = new Drafts({ ...m, now: () => 10 });
  await d.open("o/r/1");
  d.set("t:1", { thread: 1 }, "reply");
  assert.deepEqual(d.list(), [{ key: "t:1", target: { thread: 1 }, body: "reply", updated: 10 }]);
  await d.flush();
  assert.equal(m.peek()["o/r/1"]["t:1"].body, "reply");
  assert.equal(m.peek()["o/r/9"].g.body, "x");
  d.delete("t:1");
  await d.flush();
  assert.equal(m.peek()["o/r/1"], undefined);
});

test("saves are debounced", async () => {
  let saves = 0;
  const d = new Drafts({ load: async () => null, save: async () => { saves++; }, now: () => 1 });
  await d.open("o/r/1");
  d.set("g", { general: true }, "a");
  d.set("g", { general: true }, "ab");
  assert.equal(saves, 0);
  await d.flush();
  assert.equal(saves, 1);
  await d.flush();
  assert.equal(saves, 1);
});
