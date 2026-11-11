import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VOTES, voteName } from "../../mods/ado-prs/review/model.js";
import {
  createAdoProvider, mapPullRequest, mapGate, mapStatus, mapThreads, mapChange, buildThreadContext,
} from "../../mods/ado-prs/review/providers/ado.js";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const pr = fx("pr");
const iterations = fx("iterations").value;
const evals = fx("evaluations").value;
const statuses = fx("statuses").value;
const threads = fx("threads").value;
const ME = "a1b2c3d4-0000-4000-8000-000000000002";
const commonRefSha = iterations[1].commonRefCommit.commitId;
const sourceSha = iterations[1].sourceRefCommit.commitId;
const ref = { org: "contoso-demo", project: "Billing", repoId: pr.repository.id, id: 482 };
const PR_BASE = `https://dev.azure.com/contoso-demo/Billing/_apis/git/repositories/${pr.repository.id}/pullRequests/482`;

// Routes a request to a fixture by URL; `over` maps a matcher to a handler that wins.
function fakeRest(over = []) {
  const calls = [];
  const rest = async (method, url, body) => {
    calls.push({ method, url, body });
    for (const [match, h] of over) if (match(method, url)) return h(method, url, body);
    if (url.includes("/_apis/connectionData")) return fx("connection");
    if (url.includes("/_apis/policy/evaluations")) return fx("evaluations");
    if (url.includes("/_apis/wit/workitems?ids=")) return fx("workitem-titles");
    if (url.includes("/workitems")) return fx("workitems");
    if (url.includes("/statuses")) return fx("statuses");
    if (url.includes("/changes")) return url.includes("$skip=100") ? fx("changes-page2") : fx("changes-page1");
    if (url.includes("/iterations")) return fx("iterations");
    if (url.includes("/threads")) return fx("threads");
    if (url.includes("/items?")) {
      const path = decodeURIComponent(url.match(/[?&]path=([^&]*)/)[1]);
      return { objectId: "f".repeat(40), gitObjectType: "blob", path, content: `content of ${path}\n`,
        contentMetadata: { encoding: 65001, contentType: "text/plain", fileName: path.split("/").pop() } };
    }
    if (url.startsWith(PR_BASE) && url.includes("?")) return pr;
    throw new Error(`unrouted ${method} ${url}`);
  };
  return { rest, calls };
}

test("votes and voteName", () => {
  assert.deepEqual(VOTES, { approve: 10, approveWithSuggestions: 5, reset: 0, waitForAuthor: -5, reject: -10 });
  assert.equal(voteName(-5), "waitForAuthor");
  assert.equal(voteName(10), "approve");
});

test("gates", () => {
  const g = mapGate(evals[0], "Billing");
  assert.deepEqual([g.state, g.kind, g.link], ["fail", "build", { project: "Billing", build: 9001 }]);
  assert.equal(g.name, "billing-api CI");
  assert.equal(g.reason, "Build: rejected");
  assert.equal(g.optional, false);
  const r = mapGate(evals[1]);
  assert.deepEqual([r.state, r.kind, r.name, r.link], ["running", "policy", "Minimum number of reviewers", undefined]);
  assert.equal(mapGate(evals[2]).optional, true);
  assert.equal(mapGate(evals[2]).state, "notApplicable");
  // Without a project name the link falls back to the project GUID from artifactId.
  assert.deepEqual(mapGate(evals[0]).link, { project: pr.repository.project.id, build: 9001 });
  assert.deepEqual(mapPullRequest(pr, iterations, evals, [], []).gates[0].link, { project: "Billing", build: 9001 });
});

test("gate state mapping", () => {
  const st = (status) => mapGate({ ...evals[1], status }).state;
  assert.deepEqual(["approved", "broken", "queued", "somethingElse"].map(st), ["pass", "fail", "running", "pending"]);
  const noBuild = mapGate({ ...evals[0], context: {} });
  assert.equal(noBuild.kind, "build");
  assert.equal(noBuild.link, undefined);
});

test("statuses keep the latest per context", () => {
  const m = mapPullRequest(pr, iterations, evals, statuses, []);
  const checks = m.gates.filter((g) => g.kind === "check");
  assert.equal(checks.length, 1);
  assert.equal(checks[0].state, "pass");
  assert.deepEqual(checks[0].link, { url: "https://ci.example.com/billing-api/runs/2" });
  assert.equal(m.gates.length, 4);
  assert.equal(mapStatus({ ...statuses[0], state: "error" }).state, "fail");
  assert.equal(mapStatus(statuses[0]).state, "running");
  assert.equal(mapStatus({ ...statuses[0], targetUrl: undefined }).link, undefined);
});

test("mapPullRequest basics", () => {
  const m = mapPullRequest(pr, iterations, evals, statuses, [{ id: 1204, title: "T", url: "u" }]);
  assert.equal(m.id, 482);
  assert.equal(m.title, "Invoice export: support CSV with BOM");
  assert.equal(m.repo, "billing-api");
  assert.equal(m.project, "Billing");
  assert.equal(m.projectId, pr.repository.project.id);
  assert.equal(m.source, "feature/csv-bom");
  assert.equal(m.target, "main");
  assert.deepEqual(m.author, { name: "Dana Ortiz", id: "a1b2c3d4-0000-4000-8000-000000000001" });
  assert.equal(m.isDraft, false);
  assert.equal(m.status, "active");
  assert.equal(m.url, "https://dev.azure.com/contoso-demo/Billing/_git/billing-api/pullrequest/482");
  assert.deepEqual(m.reviewers[0], { id: ME, name: "Sam Lee", vote: 10, required: true, isGroup: false });
  assert.equal(m.reviewers[1].isGroup, true);
  assert.deepEqual(m.versions, { latest: 2, all: [1, 2] });
  assert.deepEqual(m.workItems, [{ id: 1204, title: "T", url: "u" }]);
});

test("threads: system/deleted dropped, sides mapped", () => {
  const t = mapThreads(threads, ME);
  assert.equal(t.length, 3);
  assert.deepEqual(t.map((x) => x.file?.side ?? "general").sort(), ["general", "left", "right"]);
  const right = t.find((x) => x.id === 503);
  assert.deepEqual(right.file, { path: "/src/Billing.Api/Export/CsvExporter.cs", side: "right", startLine: 43, endLine: 45 });
  assert.equal(right.comments.length, 2, "deleted comment dropped");
  assert.deepEqual(right.comments.map((c) => c.isMine), [true, false]);
  assert.deepEqual(right.comments[0], {
    id: 1, author: "Sam Lee", body: "Should the BOM be **opt-in**?", created: "2026-11-10T10:00:00.000Z", isMine: true,
  });
  const left = t.find((x) => x.id === 504);
  assert.deepEqual(left.file, { path: "/src/Billing.Api/Export/CsvExporter.cs", side: "left", startLine: 12, endLine: 12 });
  assert.equal(left.status, "resolved");
  assert.equal(right.status, "active");
});

test("mapChange", () => {
  assert.deepEqual(mapChange({ changeTrackingId: 4, item: { path: "/a.cs" }, changeType: "edit" }),
    { path: "/a.cs", change: "edit", changeTrackingId: 4 });
  assert.equal(mapChange({ item: { path: "/b" }, changeType: "edit, rename", originalPath: "/a" }).change, "rename");
  assert.equal(mapChange({ item: { path: "/b" }, changeType: "edit, rename", originalPath: "/a" }).oldPath, "/a");
  assert.equal(mapChange({ item: { path: "/b" }, changeType: "add, edit" }).change, "add");
  assert.equal(mapChange({ item: { path: "/b" }, changeType: "delete" }).change, "delete");
  assert.equal(mapChange({ item: { path: "/src", isFolder: true }, changeType: "add" }), null);
});

test("listFiles follows paging", async () => {
  const { rest, calls } = fakeRest();
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const files = await p.listFiles(ref, { from: null, to: 2 });
  assert.equal(files.length, 103);
  const urls = calls.map((c) => c.url);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith(`${PR_BASE}/iterations/2/changes?`));
  assert.ok(urls[0].includes("$compareTo=0") && urls[0].includes("$top=2000") && urls[0].includes("$skip=0"));
  assert.ok(urls[1].includes("$skip=100"));
  assert.ok(urls.every((u) => u.includes("api-version=7.1")));
});

test("listFiles skips folders and compares to range.from", async () => {
  const { rest, calls } = fakeRest([[(m, u) => u.includes("/changes"), () => ({
    changeEntries: [
      { changeTrackingId: 1, item: { path: "/src", isFolder: true }, changeType: "add" },
      { changeTrackingId: 2, item: { path: "/src/A.cs" }, changeType: "add" },
    ],
  })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const files = await p.listFiles(ref, { from: 1, to: 2 });
  assert.deepEqual(files.map((f) => f.path), ["/src/A.cs"]);
  assert.ok(calls[0].url.includes("$compareTo=1"));
});

test("rename fetches old side from original path", async () => {
  const { rest, calls } = fakeRest();
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const files = await p.listFiles(ref, { from: null, to: 2 });
  const f = files.find((x) => x.change === "rename");
  calls.length = 0;
  const c = await p.getFileContents(ref, f, { from: null, to: 2 });
  assert.ok(calls.some((c) => c.url.includes(`path=${encodeURIComponent(f.oldPath)}`) && c.url.includes(commonRefSha)));
  assert.ok(calls.some((c) => c.url.includes(`path=${encodeURIComponent(f.path)}`) && c.url.includes(sourceSha)));
  assert.equal(c.old, `content of ${f.oldPath}\n`);
  assert.equal(c.new, `content of ${f.path}\n`);
  assert.equal(c.binary, false);
  const item = calls.find((c) => c.url.includes("/items?")).url;
  assert.ok(item.startsWith(`https://dev.azure.com/contoso-demo/Billing/_apis/git/repositories/${ref.repoId}/items?`));
  for (const q of ["versionDescriptor.versionType=commit", "includeContent=true", "includeContentMetadata=true", "api-version=7.1"]) {
    assert.ok(item.includes(q), q);
  }
});

test("getFileContents: since-last-look uses from's source commit; add/delete skip a side; binary", async () => {
  const { rest, calls } = fakeRest([[(m, u) => u.includes("BomLogo.png"), () => ({
    content: "iVBORw0KGgo=", contentMetadata: { isBinary: true, contentType: "image/png" } })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  await p.getFileContents(ref, { path: "/a.cs", change: "edit" }, { from: 1, to: 2 });
  const items = calls.filter((c) => c.url.includes("/items?")).map((c) => c.url);
  assert.ok(items.some((u) => u.includes(iterations[0].sourceRefCommit.commitId)));
  assert.ok(items.some((u) => u.includes(sourceSha)));
  assert.ok(!items.some((u) => u.includes(commonRefSha)));

  const add = await p.getFileContents(ref, { path: "/new.cs", change: "add" }, { from: null, to: 2 });
  assert.equal(add.old, null);
  assert.equal(add.new, "content of /new.cs\n");
  const del = await p.getFileContents(ref, { path: "/gone.cs", change: "delete" }, { from: null, to: 2 });
  assert.equal(del.new, null);
  assert.equal(del.old, "content of /gone.cs\n");
  const bin = await p.getFileContents(ref, { path: "/img/BomLogo.png", change: "add" }, { from: null, to: 2 });
  assert.equal(bin.binary, true);
});

test("left-side comment context", () => {
  const c = buildThreadContext({ file: "src/A.cs", side: "left", line: 43, lineLength: 30, range: { from: null, to: 2 }, changeTrackingId: 7 });
  assert.deepEqual(c.threadContext.leftFileStart, { line: 43, offset: 1 });
  assert.deepEqual(c.threadContext.leftFileEnd, { line: 43, offset: 31 });
  assert.equal(c.threadContext.filePath, "src/A.cs");
  assert.equal(c.threadContext.rightFileStart, undefined);
  assert.equal(c.threadContext.rightFileEnd, undefined);
  assert.equal(c.pullRequestThreadContext.iterationContext.firstComparingIteration, 1);
  assert.equal(c.pullRequestThreadContext.iterationContext.secondComparingIteration, 2);
  assert.equal(c.pullRequestThreadContext.changeTrackingId, 7);
});

test("right-side range comment context", () => {
  const c = buildThreadContext({ file: "/src/A.cs", side: "right", line: 10, endLine: 12, lineLength: 5, endLineLength: 20, range: { from: 1, to: 2 }, changeTrackingId: 3 });
  assert.deepEqual(c.threadContext.rightFileStart, { line: 10, offset: 1 });
  assert.deepEqual(c.threadContext.rightFileEnd, { line: 12, offset: 21 });
  assert.equal(c.threadContext.leftFileStart, undefined);
  assert.equal(c.pullRequestThreadContext.iterationContext.firstComparingIteration, 1);
});

test("me() is cached", async () => {
  const { rest, calls } = fakeRest();
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  assert.deepEqual(await p.me(), { id: ME, name: "Sam Lee" });
  await p.me();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://dev.azure.com/contoso-demo/_apis/connectionData"));
});

test("getPullRequest combines PR, iterations, gates, statuses, work items", async () => {
  const { rest, calls } = fakeRest();
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const m = await p.getPullRequest(ref);
  assert.equal(m.title, pr.title);
  assert.equal(m.gates.length, 4);
  assert.deepEqual(m.versions, { latest: 2, all: [1, 2] });
  assert.deepEqual(m.workItems, [
    { id: 1204, title: "CSV export should include a BOM for Excel", url: "https://dev.azure.com/contoso-demo/Billing/_workitems/edit/1204" },
    { id: 1207, title: "Document export options", url: "https://dev.azure.com/contoso-demo/Billing/_workitems/edit/1207" },
  ]);
  const ev = calls.find((c) => c.url.includes("/policy/evaluations")).url;
  assert.ok(ev.startsWith("https://dev.azure.com/contoso-demo/Billing/_apis/policy/evaluations?"));
  assert.ok(ev.includes(`artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${pr.repository.project.id}/482`)}`));
  const titles = calls.find((c) => c.url.includes("/_apis/wit/workitems?")).url;
  assert.ok(titles.includes("ids=1204%2C1207") || titles.includes("ids=1204,1207"));
  assert.ok(calls.every((c) => c.method === "get" && c.url.includes("api-version=7.1")));
});

test("getPullRequest survives a failing work item title lookup", async () => {
  const { rest } = fakeRest([[(m, u) => u.includes("/_apis/wit/workitems?"), () => { throw new Error("TF401232"); }]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const m = await p.getPullRequest(ref);
  assert.deepEqual(m.workItems.map((w) => [w.id, w.title]), [[1204, null], [1207, null]]);
});

test("listThreads asks for positions tracked to the shown iteration", async () => {
  const { rest, calls } = fakeRest();
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const t = await p.listThreads(ref, { from: null, to: 2 });
  assert.equal(t.length, 3);
  assert.equal(t.find((x) => x.id === 503).comments[0].isMine, true);
  const u = calls.find((c) => c.url.includes("/threads")).url;
  assert.ok(u.startsWith(`${PR_BASE}/threads?`));
  assert.ok(u.includes("$iteration=2") && u.includes("$baseIteration=0"));
});

test("addThread posts a file thread with context", async () => {
  const { rest, calls } = fakeRest([[(m) => m === "post", (m, u, body) => ({ id: 600, status: "active", ...body,
    comments: [{ id: 1, parentCommentId: 0, author: { id: ME, displayName: "Sam Lee" }, content: body.comments[0].content, publishedDate: "2026-11-11T08:00:00.000Z", commentType: "text" }] })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const file = { path: "/src/A.cs", change: "edit", changeTrackingId: 9 };
  const t = await p.addThread(ref, {
    target: { file: "/src/A.cs", side: "left", line: 5, lineLength: 10 }, body: "why?", range: { from: null, to: 2 }, file,
  });
  const post = calls.find((c) => c.method === "post");
  assert.equal(post.url.split("?")[0], `${PR_BASE}/threads`);
  assert.deepEqual(post.body.comments, [{ parentCommentId: 0, content: "why?", commentType: 1 }]);
  assert.equal(post.body.status, "active");
  assert.deepEqual(post.body.threadContext.leftFileStart, { line: 5, offset: 1 });
  assert.equal(post.body.pullRequestThreadContext.changeTrackingId, 9);
  assert.deepEqual(t.file, { path: "/src/A.cs", side: "left", startLine: 5, endLine: 5 });
  assert.equal(t.comments[0].isMine, true);
});

test("addThread general comment has no context", async () => {
  const { rest, calls } = fakeRest([[(m) => m === "post", (m, u, body) => ({ id: 601, status: "active",
    comments: [{ id: 1, author: { id: ME, displayName: "Sam Lee" }, content: "lgtm", publishedDate: "x", commentType: "text" }] })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const t = await p.addThread(ref, { target: { general: true }, body: "lgtm", range: { from: null, to: 2 } });
  const post = calls.find((c) => c.method === "post");
  assert.equal("threadContext" in post.body, false);
  assert.equal("pullRequestThreadContext" in post.body, false);
  assert.equal(t.file, undefined);
});

test("reply posts to the thread's first comment", async () => {
  const { rest, calls } = fakeRest([[(m) => m === "post", (m, u, body) => ({ id: 4, ...body,
    author: { id: ME, displayName: "Sam Lee" }, publishedDate: "2026-11-11T08:00:00.000Z", commentType: "text" })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const c = await p.reply(ref, 503, "thanks");
  const post = calls.find((c) => c.method === "post");
  assert.equal(post.url.split("?")[0], `${PR_BASE}/threads/503/comments`);
  assert.deepEqual(post.body, { parentCommentId: 1, content: "thanks", commentType: 1 });
  assert.deepEqual(c, { id: 4, author: "Sam Lee", body: "thanks", created: "2026-11-11T08:00:00.000Z", isMine: true });
});

test("setThreadStatus patches the thread", async () => {
  const { rest, calls } = fakeRest([[(m) => m === "patch", (m, u, body) => ({ ...threads[2], status: body.status })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  const t = await p.setThreadStatus(ref, 503, "resolved");
  const c = calls.find((c) => c.method === "patch");
  assert.equal(c.url.split("?")[0], `${PR_BASE}/threads/503`);
  assert.deepEqual(c.body, { status: "fixed" });
  assert.equal(t.status, "resolved");
  await p.setThreadStatus(ref, 503, "active");
  assert.deepEqual(calls.filter((c) => c.method === "patch")[1].body, { status: "active" });
});

test("vote puts my reviewer vote and returns the server's", async () => {
  const { rest, calls } = fakeRest([[(m) => m === "put", (m, u, body) => ({ id: ME, displayName: "Sam Lee", vote: body.vote })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  assert.equal(await p.vote(ref, "waitForAuthor"), -5);
  const c = calls.find((c) => c.method === "put");
  assert.equal(c.url.split("?")[0], `${PR_BASE}/reviewers/${ME}`);
  assert.deepEqual(c.body, { vote: -5 });
  await assert.rejects(p.vote(ref, "bogus"), /unknown vote/);
});

test("setDraft returns server state", async () => {
  const { rest, calls } = fakeRest([[(m) => m === "patch", () => ({ ...pr, isDraft: true })]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  assert.equal(await p.setDraft(ref, false), true);
  const c = calls.find((c) => c.method === "patch");
  assert.equal(c.url.split("?")[0], PR_BASE);
  assert.deepEqual(c.body, { isDraft: false });
});

test("vote rejects propagate", async () => {
  const { rest } = fakeRest([[(m) => m === "put", () => { throw new Error("TF401181: The pull request cannot be edited"); }]]);
  const p = createAdoProvider({ rest, org: "contoso-demo" });
  await assert.rejects(p.vote(ref, "approve"), /TF401181/);
});

test("capabilities", () => {
  const p = createAdoProvider({ rest: async () => null, org: "o" });
  assert.deepEqual(p.capabilities, { votes: Object.keys(VOTES), draft: true });
});
