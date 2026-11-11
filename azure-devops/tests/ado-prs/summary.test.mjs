import test from "node:test";
import assert from "node:assert/strict";
import {
  myVote, voteLook, gateLook, gateAction, anyRunning, changeLook, threadSummary, fileDrafts, targetLabel, ago, displayName,
} from "../../mods/ado-prs/review/summary.js";

const R = (id, vote) => ({ id, name: id, vote, required: false, isGroup: false });

test("myVote: my reviewer entry's vote key; null when not a reviewer", () => {
  const rs = [R("a", 10), R("me", -5)];
  assert.equal(myVote(rs, "me"), "waitForAuthor");
  assert.equal(myVote([R("me", 0)], "me"), "reset");
  assert.equal(myVote([R("me", 5)], "me"), "approveWithSuggestions");
  assert.equal(myVote(rs, "nobody"), null);
  assert.equal(myVote(undefined, "me"), null);
});

test("voteLook maps votes to glyphs and colors", () => {
  assert.equal(voteLook(10).color, "ansi2");
  assert.equal(voteLook(-10).glyph, "✗");
  assert.equal(voteLook(-5).color, "working");
  assert.equal(voteLook(undefined).glyph, "○");
  assert.equal(voteLook(3).glyph, "○");
});

test("gateLook: glyph/color per state; optional and n/a dimmed", () => {
  assert.deepEqual(gateLook({ state: "pass", optional: false }), { glyph: "✓", color: "ansi2", dim: false });
  assert.deepEqual(gateLook({ state: "fail", optional: true }), { glyph: "✗", color: "blocked", dim: true });
  assert.equal(gateLook({ state: "running" }).color, "working");
  assert.equal(gateLook({ state: "pending" }).glyph, "!");
  assert.equal(gateLook({ state: "pending" }).color, "muted");
  assert.deepEqual(gateLook({ state: "notApplicable" }), { glyph: "–", color: "dim", dim: true });
  assert.equal(gateLook({ state: "weird" }).glyph, "!");
});

test("gateAction: build → split, url → browser, else info", () => {
  assert.deepEqual(gateAction({ kind: "build", link: { project: "P", build: 7 } }), { kind: "build", project: "P", build: 7 });
  assert.deepEqual(gateAction({ kind: "check", link: { url: "https://x" } }), { kind: "url", url: "https://x" });
  assert.deepEqual(gateAction({ kind: "build" }), { kind: "info" });
  assert.deepEqual(gateAction({ kind: "policy" }), { kind: "info" });
});

test("anyRunning", () => {
  assert.equal(anyRunning([{ state: "pass" }, { state: "running" }]), true);
  assert.equal(anyRunning([{ state: "pass" }]), false);
  assert.equal(anyRunning(undefined), false);
});

test("changeLook falls back to edit", () => {
  assert.equal(changeLook("add").letter, "A");
  assert.equal(changeLook("delete").color, "blocked");
  assert.equal(changeLook("nope").letter, "M");
});

test("threadSummary counts open/total, general vs per file", () => {
  const s = threadSummary([
    { id: 1, status: "active" },
    { id: 2, status: "resolved" },
    { id: 3, status: "pending", file: { path: "/a.cs" } },
    { id: 4, status: "resolved", file: { path: "/a.cs" } },
    { id: 5, status: "active", file: { path: "/b.cs" } },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.open, 3);
  assert.equal(s.general, 2);
  assert.equal(s.generalOpen, 1);
  assert.deepEqual(s.byFile.get("/a.cs"), { total: 2, open: 1 });
  assert.deepEqual(s.byFile.get("/b.cs"), { total: 1, open: 1 });
  assert.equal(threadSummary(null).total, 0);
});

test("fileDrafts keeps file drafts only, sorted, flags files that left the PR", () => {
  const drafts = [
    { key: "g", target: { general: true }, body: "x" },
    { key: "t:4", target: { thread: 4 }, body: "y" },
    { key: "b", target: { file: "/b.cs", side: "right", line: 3 }, body: "b" },
    { key: "a2", target: { file: "/a.cs", side: "right", line: 9 }, body: "a2" },
    { key: "a1", target: { file: "/a.cs", side: "left", line: 2 }, body: "a1" },
  ];
  const out = fileDrafts(drafts, [{ path: "/a.cs" }]);
  assert.deepEqual(out.map((d) => d.key), ["a1", "a2", "b"]);
  assert.deepEqual(out.map((d) => d.gone), [false, false, true]);
  assert.equal(fileDrafts(drafts, null).some((d) => d.gone), false);
});

test("targetLabel", () => {
  assert.equal(targetLabel({ file: "/a.cs", side: "right", line: 4 }), "/a.cs:4");
  assert.equal(targetLabel({ file: "/a.cs", side: "left", line: 4, endLine: 6 }), "/a.cs:4-6 (old)");
});

test("ago and displayName", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(ago("2026-11-11T11:59:50Z", now), "1m");
  assert.equal(ago("2026-11-11T09:00:00Z", now), "3h");
  assert.equal(ago("2026-11-09T12:00:00Z", now), "2d");
  assert.equal(ago(undefined, now), "");
  assert.equal(displayName("[Billing]\\Core team"), "Core team");
  assert.equal(displayName("Dana Ortiz"), "Dana Ortiz");
});
