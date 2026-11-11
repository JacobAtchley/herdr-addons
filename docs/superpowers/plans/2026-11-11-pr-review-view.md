# PR Review View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a PR in `ado-prs` opens an in-Herdr review screen: status, gates, changed files with syntax-highlighted diffs, inline threads, commenting, voting, and draft toggle — behind a provider seam so GitHub can be added later.

**Architecture:** Pure logic (diff, ANSI parsing, thread placement, draft store, ADO→neutral mapping) lives in small `review/*.js` modules with no `herdr` import, unit-tested with `node --test`. The ADO provider takes an injected `rest()` so it is tested against JSON fixtures. A `Review` class (same pattern as `ado-workitems/detail.js` `Detail`) renders the screen and is swapped in for the list by `main.js`.

**Tech Stack:** Herdr mod runtime (gpui-kit / gpui-base / herdr), `az rest` (ADO REST api-version 7.1), `bat` for highlighting, Node 22 `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-11-11-pr-review-view-design.md`

## Global Constraints

- Work in the repo copy `azure-devops/mods/ado-prs/`; push to the live copy with `./install.sh --update ado-prs`; run `./install.sh --pull ado-prs` once before Task 1 so the repo starts from the live copy.
- Modules under `review/` except `view.js`, `highlight.js`, `azrest.js` must not import `herdr`, `gpui-kit`, or `gpui-base` (they are unit-tested in Node).
- Tests: `azure-devops/tests/ado-prs/*.test.mjs`, run with `node --test azure-devops/tests/ado-prs/`.
- ADO calls: `az rest --resource 499b84ac-1321-427f-aa17-267ca6975798`, `api-version=7.1`.
- Mods don't share modules: copy helpers (az wrapper, ANSI parser) into `ado-prs`, don't import across mods.
- `mod.json` stays as is (dialog 0.8×0.8). New files in an existing mod folder are fine (the "write mod.json first" gotcha applies only to new mod folders).
- gpui gotchas: use `flex_shrink_1()`; `h_flex` centers children vertically, so columns need `h_full()`; `list()` comes from `gpui-kit`, `Scrollbar` from `gpui-base`.
- Public repo: fixtures and screenshots use fictional data only (e.g. repo `billing-api`, author `Dana Ortiz`); commits use the repo's noreply email (already configured).
- Votes: approve 10, approve with suggestions 5, reset 0, wait for author −5, reject −10.
- Drafts older than 7 days are deleted on load.
- bat themes: `Catppuccin Mocha` (dark), `Catppuccin Latte` (light).
- Other mods open in a split pane: `run("pane.split", { direction: "right", mod, props })`.

## Review Focus

1. **Comment on a deleted (old-side) line** — must post with `leftFileStart/leftFileEnd`, not right. Pinned in Task 4 (`buildThreadContext`) and Task 5 (`placeThreads` side).
2. **CRLF files / missing trailing newline** — must not show every line as changed. Pinned in Task 1 (`splitLines`).
3. **PR with more than 100 changed files** — ADO pages `changes`; all files must appear. Pinned in Task 4 (`listFiles` follows `nextSkip`).
4. **Renamed file** — the old side must be fetched from the original path. Pinned in Task 4 (`getFileContents` uses `oldPath`).
5. **Write refused by ADO** (setDraft by a non-author, vote on a closed PR) — UI keeps the server's state and shows the error. Pinned in Task 4 (`setDraft` returns the response's `isDraft`; errors propagate) and Task 6 (view reverts on throw).

---

### Task 1: Line diff

**Files:**
- Create: `azure-devops/mods/ado-prs/review/diff.js`
- Test: `azure-devops/tests/ado-prs/diff.test.mjs`

**Interfaces:**
- Produces:
  - `splitLines(text: string|null) → string[]` — `""`/`null` → `[]`; splits on `\r?\n`; drops one trailing empty element.
  - `diffLines(oldLines: string[], newLines: string[]) → Row[]` where `Row = {kind:'ctx'|'add'|'del', oldNo:number|null, newNo:number|null, text:string}` (1-based line numbers).
  - `toHunks(rows: Row[], context=3) → Segment[]` where `Segment = {type:'rows', rows:Row[]} | {type:'gap', count:number, oldNo:number, newNo:number}` (gap = collapsed unchanged run; click expands).
  - `toSplit(rows: Row[]) → Pair[]` where `Pair = {left: Row|null, right: Row|null}`; consecutive del-run and add-run are zipped side by side; ctx rows appear on both.

- [ ] **Step 1: Sync and write failing tests**

Run `./install.sh --pull ado-prs` first. Then tests:

```js
import test from "node:test"; import assert from "node:assert/strict";
import { splitLines, diffLines, toHunks, toSplit } from "../../mods/ado-prs/review/diff.js";

test("crlf and trailing newline are not changes", () => {
  const rows = diffLines(splitLines("a\r\nb\r\n"), splitLines("a\nb"));
  assert.deepEqual(rows.map(r => r.kind), ["ctx", "ctx"]);
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
});
test("split zips del/add runs", () => {
  const pairs = toSplit(diffLines(["a","b","c"], ["a","B","B2","c"]));
  assert.deepEqual(pairs.map(p => [p.left?.text ?? null, p.right?.text ?? null]),
    [["a","a"],["b","B"],[null,"B2"],["c","c"]]);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test azure-devops/tests/ado-prs/` → "Cannot find module …/diff.js".
- [ ] **Step 3: Implement `review/diff.js`** — Myers O(ND) on line strings (no dependencies). Above 20 000 lines on either side, return a plain del-all/add-all result (the view shows a "too large" note).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git add azure-devops && git commit -m "ado-prs: line diff for the review view"`

---

### Task 2: Syntax highlighting

**Files:**
- Create: `azure-devops/mods/ado-prs/review/ansi.js` (pure), `azure-devops/mods/ado-prs/review/highlight.js` (runs bat)
- Test: `azure-devops/tests/ado-prs/ansi.test.mjs`

**Interfaces:**
- Produces:
  - `parseAnsi(text: string) → Span[][]` — one array per line; `Span = {text:string, color:string|null, bold:boolean}`; `color` is `#rrggbb` for 24-bit SGR (`38;2;r;g;b`) or a theme name `ansiN` for 30–37/90–97/`38;5;n<16`; reset `0`/`39` → null. Other escapes stripped. Copy the SGR handling from `ado-pipelines/loglines.js` (don't import it).
  - `isDarkTheme(colors: Record<string,string>) → boolean` — relative luminance of `colors.background` < 0.5.
  - `highlightFile(path: string, text: string, dark: boolean) → Promise<Span[][] | null>` in `highlight.js`: writes `text` to `${appHome()}/cache/ado-prs/hl/<sha1(path+text)>.src`, runs `bat --color=always --style=plain --paging=never --tabs=4 --file-name=<path> --theme=<Catppuccin Mocha|Catppuccin Latte> <file>`, parses with `parseAnsi`, memoizes in a Map by the same hash. Returns `null` if bat is not found (tries `bat`, `/opt/homebrew/bin/bat`, `/usr/local/bin/bat`) or exits non-zero.
  - `batAvailable() → Promise<boolean>` (cached).

- [ ] **Step 1: Failing tests**

```js
import { parseAnsi, isDarkTheme } from "../../mods/ado-prs/review/ansi.js";
test("truecolor and reset", () => {
  const lines = parseAnsi("\x1b[38;2;203;166;247mpublic\x1b[0m void\nx");
  assert.deepEqual(lines[0], [{text:"public",color:"#cba6f7",bold:false},{text:" void",color:null,bold:false}]);
  assert.deepEqual(lines[1], [{text:"x",color:null,bold:false}]);
});
test("colour carries across lines until reset", () => {
  const lines = parseAnsi("\x1b[32m/* a\nb */\x1b[0m");
  assert.equal(lines[1][0].color, "ansi2");
});
test("line count matches input", () => assert.equal(parseAnsi("a\n\nb").length, 3));
test("isDarkTheme", () => {
  assert.equal(isDarkTheme({background: "#1e1e2e"}), true);
  assert.equal(isDarkTheme({background: "#eff1f5"}), false);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `ansi.js`, then `highlight.js`** (signatures above).
- [ ] **Step 4: Run, expect PASS.** Also smoke-check bat by hand: `printf 'class A {}\n' > /tmp/x.cs && bat --color=always --style=plain --theme="Catppuccin Mocha" /tmp/x.cs | cat -v` shows `38;2;` sequences.
- [ ] **Step 5: Commit** — `"ado-prs: bat-based syntax highlighting"`

---

### Task 3: Draft store

**Files:**
- Create: `azure-devops/mods/ado-prs/review/drafts.js`
- Test: `azure-devops/tests/ado-prs/drafts.test.mjs`

**Interfaces:**
- Produces:
  - `draftKey(target) → string` where `target = {thread:number} | {file:string, side:'left'|'right', line:number, endLine?:number} | {general:true}` → `"t:12"`, `"f:right:src/A.cs:43-45"`, `"g"`.
  - `class Drafts` — `constructor({load: () => Promise<object|null>, save: (obj) => Promise<void>, now = Date.now})`; `async open(prKey:string)`; `get(key) → {body, target, updated}|null`; `set(key, target, body)` (empty body = delete; saves debounced 300 ms); `delete(key)`; `list() → {key, target, body, updated}[]` for the open PR; `static MAX_AGE_MS = 7*24*3600*1000`. `open` prunes entries older than `MAX_AGE_MS` across **all** PRs and saves if anything was pruned. Stored shape: `{ [prKey]: { [key]: {body, target, updated} } }`; empty PR maps are removed.
  - `prKey(ref) → "<org>/<repoId>/<id>"`.
- Real `load/save` (in `view.js`) read/write `${appHome()}/cache/ado-prs/drafts.json` via `readTextFile`/`writeTextFile`.

- [ ] **Step 1: Failing tests**

```js
import { Drafts, draftKey } from "../../mods/ado-prs/review/drafts.js";
const DAY = 864e5;
function mem(initial) { let s = initial; return { load: async () => s, save: async (o) => { s = structuredClone(o); }, peek: () => s }; }
test("keys", () => {
  assert.equal(draftKey({thread: 12}), "t:12");
  assert.equal(draftKey({file: "src/A.cs", side: "right", line: 43, endLine: 45}), "f:right:src/A.cs:43-45");
  assert.equal(draftKey({general: true}), "g");
});
test("prunes drafts older than 7 days across PRs", async () => {
  const now = 100 * DAY; const m = mem({ "o/r/1": { g: {body: "old", target: {general:true}, updated: now - 8*DAY} },
                                         "o/r/2": { g: {body: "new", target: {general:true}, updated: now - 6*DAY} } });
  const d = new Drafts({ ...m, now: () => now }); await d.open("o/r/2");
  assert.equal(d.get("g").body, "new"); assert.equal(m.peek()["o/r/1"], undefined);
});
test("empty body deletes", async () => {
  const m = mem(null); const d = new Drafts({ ...m, now: () => 1 }); await d.open("o/r/1");
  d.set("g", {general:true}, "hi"); d.set("g", {general:true}, ""); assert.equal(d.get("g"), null);
});
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS** (use `await d.flush()` — add `flush(): Promise<void>` that forces the debounced save — where a test reads `peek()` after `set`).
- [ ] **Step 5: Commit** — `"ado-prs: persisted comment drafts"`

---

### Task 4: Provider seam + ADO provider

**Files:**
- Create: `azure-devops/mods/ado-prs/review/model.js` (JSDoc typedefs + `VOTES`), `review/providers/ado.js`, `review/azrest.js` (real `rest()` over `az`, copied from `ado-workitems/ado.js` `az`/`rest`)
- Test: `azure-devops/tests/ado-prs/ado-provider.test.mjs`, fixtures in `azure-devops/tests/ado-prs/fixtures/*.json` (fictional)

**Interfaces:**
- Produces (neutral model exactly as in the spec's "Provider boundary"; additions below are binding):
  - `VOTES = {approve: 10, approveWithSuggestions: 5, reset: 0, waitForAuthor: -5, reject: -10}`; `voteName(n) → key`.
  - `Ref = {org, project, repoId, id}`. `Range = {from: number|null, to: number}` (iteration ids; `from:null` = against target).
  - `createAdoProvider({rest, org}) → Provider` where `rest(method:'get'|'post'|'patch'|'put', url:string, body?) → Promise<any>`.
  - `Provider` methods (all async): `me() → {id, name}` (from `https://dev.azure.com/<org>/_apis/connectionData` `authenticatedUser`), `getPullRequest(ref) → PullRequest` (includes `gates`, `workItems`, `versions:{latest, all:number[]}`, `projectId`), `listFiles(ref, range) → FileChange[]` (each also has `changeTrackingId`), `getFileContents(ref, file:FileChange, range) → {old:string|null, new:string|null, binary:boolean}`, `listThreads(ref, range) → Thread[]`, `addThread(ref, {target, body, range, file?}) → Thread`, `reply(ref, threadId, body) → Comment`, `setThreadStatus(ref, threadId, status) → Thread`, `vote(ref, key) → number` (returns the vote in the response), `setDraft(ref, bool) → boolean` (returns response `isDraft`), `capabilities = {votes: Object.keys(VOTES), draft: true}`.
  - Exported pure mappers (tested directly): `mapPullRequest(pr, iterations, evaluations, statuses, workItems)`, `mapGate(evaluation)`, `mapStatus(status)`, `mapThreads(rawThreads, meId)`, `mapChange(entry)`, `buildThreadContext({file, side, line, endLine, lineLength, endLineLength, range, changeTrackingId})`.
- Mapping rules (decided here):
  - Threads: drop `isDeleted` and those whose first comment has `commentType === "system"`; `file` from `threadContext` — `rightFileStart` → side `right`, else `leftFileStart` → `left`; comment `isMine` = `author.id === meId`; deleted comments dropped. Fetch with `threads?$iteration=<to>&$baseIteration=<from ?? 0>` so ADO returns positions tracked to the shown iteration.
  - Gates (`_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/<projectId>/<prId>`): `approved→pass`, `rejected|broken→fail`, `running|queued→running`, `notApplicable→notApplicable`, else `pending`; `name = configuration.settings.displayName || configuration.type.displayName`; `kind:'build'` when `configuration.type.displayName === "Build"` with `link:{project, build: context.buildId}` (no link if no buildId); `reason = "<type displayName>: <status>"`; `optional = !configuration.isBlocking`.
  - Statuses (`pullRequests/{id}/statuses`): keep the latest (highest `id`) per `context.genre + "/" + context.name`; `succeeded→pass`, `failed|error→fail`, `pending→running`, else `pending`; `kind:'check'`, `link:{url: targetUrl}` when present.
  - Changes: `iterations/{to}/changes?$compareTo={from ?? 0}&$top=2000&$skip=n`, follow `nextSkip` until 0/absent. `changeType` strings like `"edit, rename"` → `rename` if it contains rename, else first of add/delete/edit. Skip folder entries (`item.isFolder`).
  - File contents: old side = `commonRefCommit` of iteration `to` when `from === null`, else `sourceRefCommit` of iteration `from`; new side = `sourceRefCommit` of iteration `to`. Old path = `oldPath ?? path`. `items?path=…&versionDescriptor.version=<sha>&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true`; `binary = contentMetadata.isBinary`. Add → `old:null`; delete → `new:null`.
  - `buildThreadContext`: side `right` → `rightFileStart:{line, offset:1}`, `rightFileEnd:{line:endLine ?? line, offset: (endLineLength ?? lineLength) + 1}`; side `left` → same with `left*`. `pullRequestThreadContext: {changeTrackingId, iterationContext: {firstComparingIteration: range.from ?? 1, secondComparingIteration: range.to}}`.
  - Vote: `PUT …/pullRequests/{id}/reviewers/{meId}` `{vote}`. Draft: `PATCH …/pullRequests/{id}` `{isDraft}`. Status: `PATCH …/threads/{t}` `{status}`. New thread: `POST …/threads` `{comments:[{parentCommentId:0, content, commentType:1}], status:"active", threadContext?, pullRequestThreadContext?}`. Reply: `POST …/threads/{t}/comments` `{parentCommentId: <first comment id>, content, commentType:1}`.

- [ ] **Step 1: Write fixtures** (fictional): `pr.json`, `iterations.json` (2 iterations with distinct `commonRefCommit`/`sourceRefCommit`), `evaluations.json` (one Build rejected with `buildId: 9001`, one "Minimum number of reviewers" running, one notApplicable non-blocking), `statuses.json` (two entries for the same context, ids 1 and 2), `threads.json` (one system thread, one deleted, one right-side, one left-side, one general), `changes-page1.json` (100 entries, `nextSkip: 100`) and `changes-page2.json` (3 entries incl. `"edit, rename"` with `originalPath`, `nextSkip: 0`).

- [ ] **Step 2: Failing tests** — a fake `rest` routes by URL substring to fixtures and records calls:

```js
test("gates", () => {
  const g = mapGate(evals[0]); assert.deepEqual([g.state, g.kind, g.link], ["fail", "build", {project: "Billing", build: 9001}]);
  assert.equal(mapGate(evals[2]).optional, true);
});
test("statuses keep the latest per context", () => {
  /* mapPullRequest(...).gates has one check from statuses.json, state of id 2 */ });
test("threads: system/deleted dropped, sides mapped", () => {
  const t = mapThreads(threads, "me-1");
  assert.equal(t.length, 3);
  assert.deepEqual(t.map(x => x.file?.side ?? null).sort(), [null, "left", "right"]);
});
test("listFiles follows paging", async () => { assert.equal((await p.listFiles(ref, {from:null,to:2})).length, 103); });
test("rename fetches old side from original path", async () => {
  const files = await p.listFiles(ref, {from:null,to:2}); const f = files.find(x => x.change === "rename");
  await p.getFileContents(ref, f, {from:null,to:2});
  assert.ok(calls.some(c => c.url.includes(`path=${encodeURIComponent(f.oldPath)}`) && c.url.includes(commonRefSha)));
});
test("left-side comment context", () => {
  const c = buildThreadContext({file:"src/A.cs", side:"left", line:43, lineLength:30, range:{from:null,to:2}, changeTrackingId:7});
  assert.deepEqual(c.threadContext.leftFileStart, {line:43, offset:1});
  assert.equal(c.threadContext.rightFileStart, undefined);
  assert.equal(c.pullRequestThreadContext.iterationContext.firstComparingIteration, 1);
});
test("setDraft returns server state", async () => { /* fake PATCH responds {isDraft:true} → returns true */ });
test("vote rejects propagate", async () => { /* fake PUT throws Error("TF401181") → await assert.rejects(p.vote(ref,"approve"), /TF401181/) */ });
```

- [ ] **Step 3: Run, expect FAIL.** **Step 4: Implement** `model.js`, `providers/ado.js`, `azrest.js` (`rest(method,url,body)` = the `ado-workitems` `rest` with `--method`, `--headers Content-Type=application/json`, `--body`). **Step 5: Run, expect PASS.**
- [ ] **Step 6: Live check** — in a scratch `.mjs` is not possible (azrest imports herdr); instead verify in Task 6 against a real PR.
- [ ] **Step 7: Commit** — `"ado-prs: provider seam and Azure DevOps provider"`

---

### Task 5: Placing threads and drafts on diff rows

**Files:**
- Create: `azure-devops/mods/ado-prs/review/anchor.js`
- Test: `azure-devops/tests/ado-prs/anchor.test.mjs`

**Interfaces:**
- Consumes: `Row` (Task 1), `Thread` (Task 4), draft entries (Task 3).
- Produces: `placeThreads(rows: Row[], threads: Thread[], path: string) → {byRow: Map<number /*row index*/, Thread[]>, outdated: Thread[]}` — a thread with `file.path === path` attaches to the row whose `newNo` (side right) or `oldNo` (side left) equals `file.endLine ?? file.startLine`; no matching row → `outdated`. Same function places drafts (`placeDrafts(rows, drafts, path)` with the same return shape, `outdated` = "unplaced drafts").

- [ ] **Step 1: Failing tests**

```js
const rows = diffLines(["a","b","c"], ["a","B","c"]); // ctx a, del b(old2), add B(new2), ctx c
test("right side attaches to new line", () => {
  const {byRow} = placeThreads(rows, [{id:1, file:{path:"x", side:"right", startLine:2}}], "x");
  assert.deepEqual([...byRow.keys()], [2]);
});
test("left side attaches to old line", () => {
  const {byRow} = placeThreads(rows, [{id:1, file:{path:"x", side:"left", startLine:2}}], "x");
  assert.deepEqual([...byRow.keys()], [1]);
});
test("missing line is outdated; other files ignored", () => {
  const r = placeThreads(rows, [{id:1, file:{path:"x", side:"right", startLine:99}}, {id:2, file:{path:"y", side:"right", startLine:1}}], "x");
  assert.deepEqual(r.outdated.map(t => t.id), [1]); assert.equal(r.byRow.size, 0);
});
```

- [ ] **Step 2–4:** run FAIL → implement → run PASS.
- [ ] **Step 5: Commit** — `"ado-prs: anchor threads and drafts to diff rows"`

---

### Task 6: Review screen — header, status strip, file list, Overview, entry points

**Files:**
- Create: `azure-devops/mods/ado-prs/review/view.js` (`class Review`), icons as needed (`back.svg` — copy from `ado-workitems`)
- Modify: `azure-devops/mods/ado-prs/main.js` — row `on_click` (currently `this.open(pr)` at the row, ~line 400 in repo copy) → open review; external icon unchanged; `init` reads `props()?.review` (`{project, repoId, id}`) and opens it; PR id lookup result opens the review; `render()` returns `this.review.render(t)` when set (same as `ado-workitems` `this.detail`).

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `new Review(host, ref, cx)` with `host = {org, back(cx), notify(msg)}`; `render(t)`; `Review.page` = `"overview"` or a file path.

Behaviour (from spec; every write re-fetches the PR and threads on success, and on failure leaves the shown state as the server last reported and shows the error with `notify`):
- **Header:** back arrow; title; `repo · source → target · author · age`; Draft/Publish toggle (`setDraft`); vote buttons Approve ▾ (menu: Approve / Approve with suggestions), Wait for author, Reject, Reset — current vote highlighted (current = my reviewer entry's vote).
- **Status strip:** reviewer chips (vote icon, name, "required"), gate chips (✓ `t.ansi2` / ✗ `t.blocked` / ● `t.working` / ! `t.muted` / – dim; optional gates dim). Build gate click → `run("pane.split", {direction:"right", mod:"ado-pipelines", props:{project, build}})`; check gate with url → open in browser; others → tooltip with `reason`. Thread count `💬 N · M open` on the right. While any gate is `running`, re-fetch the PR every 30 s.
- **Left list:** "Overview" (badge = open general threads), then files (path, colored by change type, badge = thread count). Files load once per range.
- **Overview page:** description via `TextView.markdown`; work items (click → `pane.split` `ado-workitems` props `{detail:id}`); general threads (resolved collapsed; Reply / Resolve / Reactivate; reply box per thread); new general comment box; "Unplaced drafts" (from `placeDrafts` outdated across files — requires loading diffs, so list them by file+line text without placing); per-file thread summary (click → file page).
- **Drafts:** every composer reads/writes the `Drafts` store (Task 3) keyed per `draftKey`; posting clears the key.

- [ ] **Step 1: Implement `view.js` header/strip/list/Overview and the `main.js` wiring.**
- [ ] **Step 2: Unit tests still pass** — `node --test azure-devops/tests/ado-prs/` → PASS.
- [ ] **Step 3: Install and verify against a real PR** — `./install.sh --update ado-prs`; open the PR list (⌘⇧R), click an active PR you are a reviewer on. Check: header fields match ADO web; gate states match the PR page's policies; clicking a failed build gate opens the run in a right split; general threads match ADO; type a general comment, close the dialog, reopen the PR → draft still there; post it → appears in ADO web. Vote Wait for author then Reset → ADO web shows each. Toggle draft on a PR you don't own → error shown, toggle unchanged.
- [ ] **Step 4: Commit** — `"ado-prs: review screen with overview, votes, draft, gates"`

---

### Task 7: File page — highlighted diffs, inline threads, commenting

**Files:**
- Modify: `azure-devops/mods/ado-prs/review/view.js`

**Interfaces:**
- Consumes: `diffLines/toHunks/toSplit` (1), `highlightFile/batAvailable/isDarkTheme` (2), `Drafts` (3), provider `listFiles/getFileContents/listThreads/addThread/reply/setThreadStatus` (4), `placeThreads/placeDrafts` (5).

Behaviour:
- **Toolbar:** path; `[Unified | Split]` toggle (`localStorage` key `review.diffStyle`, default `unified`); `[All changes | Since last look]` (disabled with tooltip when no last look). Last look: `localStorage` `review.seen.<prKey>` = latest iteration id, written when the review opens; the previous value is read **before** writing and is the `from` for "Since last look". If bat is missing: dim hint "Install bat for syntax highlighting (brew install bat)".
- **Rows:** rendered with gpui-kit `list()` (variable height). Each code row: line numbers (old/new in unified; one per column in split), add/del background behind spans from `highlightFile(old)`/`highlightFile(new)` indexed by `oldNo-1`/`newNo-1`; plain text if highlighting is `null`. `gap` segments render as "⋯ N unchanged lines" — click expands.
- **Threads inline** under their row (from `placeThreads`), resolved collapsed (click to expand); outdated threads listed at the top of the file as "Outdated comments". Reply / Resolve / Reactivate as on Overview.
- **New comment:** click a line number → composer under that row; shift-click a second line in the same column → range (`endLine`). Side: del rows and the left split column → `left`; add/ctx rows and the right split column → `right`. Post via `addThread` with `buildThreadContext` inputs (`lineLength` from the row text). Drafts placed by `placeDrafts`.
- **Fallbacks:** `binary` → "Binary file — open in browser"; either side over 20 000 lines or 1 MB → "Too large to show — open in browser".

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Unit tests still pass.**
- [ ] **Step 3: Verify against a real PR** (`./install.sh --update ado-prs`): C# file shows Catppuccin colors in dark and (after switching macOS to light) Latte colors; toggle Unified/Split, reopen → choice remembered; a thread made in ADO web on a deleted line shows on the left/del row; comment on a deleted line here → ADO web shows it on the old side; comment on an added line → new side; range comment (shift-click) spans the right lines in ADO web; a CRLF file shows only real changes; a renamed file shows its diff; push a commit to a test PR, reopen → "Since last look" shows only that commit's changes.
- [ ] **Step 4: Commit** — `"ado-prs: highlighted diffs with inline threads and comments"`

---

### Task 8: Docs

**Files:**
- Modify: `README.md` (`## Requirements`), `azure-devops/RECIPE.md` (PR section under "What you see", files under "Built from"), `azure-devops/preview.png` only if the user asks for a new screenshot.

- [ ] **Step 1:** README Requirements gains: ``- `bat` (`brew install bat`) for syntax highlighting in the pull request review view; without it diffs show plain text.``
- [ ] **Step 2:** RECIPE.md describes the review view (row click opens it, what it shows, votes/draft, toggles, drafts kept 7 days, gates open in a split) and lists `review/*.js` under "Built from"; mention bat there too.
- [ ] **Step 3:** `node --test azure-devops/tests/ado-prs/` → PASS; `./install.sh --update ado-prs` → no diff between repo and live copy (`diff -rq azure-devops/mods/ado-prs ~/.config/herdr-app/mods/ado-prs` prints nothing).
- [ ] **Step 4: Commit** — `"ado-prs: document the review view and bat requirement"`
