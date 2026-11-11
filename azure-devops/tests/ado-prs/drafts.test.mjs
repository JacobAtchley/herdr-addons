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

test("open of another PR keeps the previous PR's pending edits", async () => {
  const m = mem(null);
  const d = new Drafts({ ...m, now: () => 1 });
  await d.open("o/r/A");
  d.set("g", { general: true }, "draft A");
  await d.open("o/r/B");
  assert.equal(m.peek()["o/r/A"].g.body, "draft A");
  assert.equal(d.get("g"), null);
  await d.open("o/r/A");
  assert.equal(d.get("g").body, "draft A");
  await d.flush();
  assert.equal(m.peek()["o/r/A"].g.body, "draft A");
});

test("set racing with open's load is not lost", async () => {
  const m = mem({ "o/r/B": { t: { body: "old", target: { thread: 1 }, updated: 1 } } });
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = new Drafts({ load: async () => { await gate; return m.peek(); }, save: m.save, now: () => 2 });
  const opening = d.open("o/r/B");
  d.set("g", { general: true }, "raced");
  release();
  await opening;
  assert.equal(d.get("g").body, "raced");
  assert.equal(d.get("t").body, "old");
  await d.flush();
  assert.equal(m.peek()["o/r/B"].g.body, "raced");
});

test("never saves partial data while load is pending", async () => {
  const other = { body: "keep", target: { general: true }, updated: 5 };
  const m = mem({ "o/r/9": { g: other } });
  const saved = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = new Drafts({
    load: async () => { await gate; return m.peek(); },
    save: async (o) => { saved.push(structuredClone(o)); await m.save(o); },
    now: () => 10,
  });
  const opening = d.open("o/r/1");
  d.set("g", { general: true }, "raced");
  const fl = d.flush(); // must wait, not write partial data
  await new Promise((r) => setTimeout(r, 350)); // past the debounce
  assert.equal(saved.length, 0);
  release();
  await opening;
  await fl;
  await d.flush();
  assert.ok(saved.length >= 1);
  for (const s of saved) assert.equal(s["o/r/9"].g.body, "keep");
  const last = saved.at(-1);
  assert.equal(last["o/r/1"].g.body, "raced");
});

test("overlapping open() calls are serialized; stale open cannot clobber", async () => {
  const m = mem({ "o/r/B": { b: { body: "B", target: { thread: 1 }, updated: 5 } },
                  "o/r/C": { c: { body: "C", target: { thread: 2 }, updated: 5 } } });
  let releaseB;
  const gateB = new Promise((r) => { releaseB = r; });
  let calls = 0;
  const d = new Drafts({ load: async () => { if (calls++ === 0) await gateB; return m.peek(); }, save: m.save, now: () => 10 });
  const ob = d.open("o/r/B");
  const oc = d.open("o/r/C");
  releaseB();
  await Promise.all([ob, oc]);
  assert.equal(d.get("c").body, "C");
  assert.equal(d.get("b"), null);
  await d.flush();
  assert.equal(m.peek()["o/r/B"].b.body, "B");
  assert.equal(m.peek()["o/r/C"].c.body, "C");
});

test("onError is called when a debounced save rejects; flush rejects", async () => {
  const errs = [];
  const boom = new Error("disk");
  const d = new Drafts({ load: async () => null, save: async () => { throw boom; }, now: () => 1, onError: (e) => errs.push(e) });
  await d.open("o/r/1");
  d.set("g", { general: true }, "a");
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(errs, [boom]);
  d.set("g", { general: true }, "b");
  await assert.rejects(d.flush(), /disk/);
});
