# PR review view — design

Date: 2026-11-11
Addon: `azure-devops` (mod `ado-prs`; live copy in `~/.config/herdr-app/mods/ado-prs`, repo copy in `azure-devops/mods/ado-prs`, synced with `install.sh`)

## Intent

Replace the Azure DevOps pull request web page with an in-Herdr review screen. Today a row click in `ado-prs` opens the browser. The user wants to stay in Herdr and do the whole review there: see what the PR is, whether it can merge, read the changed files and the feedback already on them, leave new feedback, and vote.

The screen must not be tied to Azure DevOps. ADO is the first backend; GitHub should be addable later without touching the UI.

## Goals

1. Clicking a PR row in `ado-prs` opens the review view for that PR (the external-link icon keeps opening the browser).
2. Show: title, repo, source → target branch, author, age, draft state, reviewers with their votes (required ones marked), gates (branch policies / status checks) with pass/fail/running state.
3. List changed files; open any file to see its diff with existing comment threads inline at their lines.
4. Comment on a line (and on a range, see below), reply to a thread, resolve/reactivate a thread.
5. General (non-file) comments live on the Overview page, with a box to add one.
6. Vote: Approve, Approve with suggestions, Wait for author, Reject, Reset. Toggle draft ↔ published.
7. Diff style: unified and side-by-side, toggle, last choice remembered.
8. Diff range: full diff against target, or only changes since the user's last look (iteration compare), toggle.
9. Clicking a build gate opens that run in `ado-pipelines`.

## Non-goals

- GitHub backend (only the seam for it).
- Creating, completing (merging), or abandoning PRs; editing title/description; adding reviewers.
- Editing files or suggesting code changes.
- Syntax highlighting (nice-to-have, builder may add if cheap).
- Offline mode.

## Anti-goals (would make it a failure even if it works)

- A comment posted on the wrong line or wrong side of the diff. Line anchoring must match what ADO's web view would show.
- Losing a half-written comment (younger than 7 days) because of a refresh, navigation, closing the dialog, or a restart.
- A vote or draft change that appears to succeed but didn't — every write must reflect the server's response.
- UI code that calls `az` or knows ADO shapes directly (breaks the GitHub goal).

## Layout (chosen: "header strip", option B in the mockups)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← #4182 Add retry policy to invoice sync                    [Draft ⇄]    │
│ billing-api · feature/retry → main · Dana Ortiz · 2d                     │
│                     [Wait for author ▾] [Reject] [Approve ▾] [Reset]     │
├──────────────────────────────────────────────────────────────────────────┤
│ ✓ Sam Lee  … Core team (req) │ ✓ Build ✗ Unit tests ● Sonar ! Work item  │ 💬 5 · 2 open │
├───────────────┬──────────────────────────────────────────────────────────┤
│ Overview   2  │  [Unified|Split]  [All changes|Since last look]          │
│ InvoiceSync 2 │   41   public async Task SyncAsync(Invoice inv)          │
│ RetryPolicy + │   43 - await _client.PostAsync(inv);                     │
│ Startup.cs  1 │   43 + await _retry.ExecuteAsync(() =>                   │
│ OldBackoff  - │   ┌ Sam Lee · Active ─────────────────────┐              │
│               │   │ Should this be idempotent…? Reply·Resolve           │
└───────────────┴──────────────────────────────────────────────────────────┘
```

- **Header** (always visible): title, repo, branches, author, age; vote buttons; draft toggle; back arrow to the list.
- **Status strip**: reviewer chips (vote icon + name, "required" marker), gate chips (✓ green / ✗ red / ● running / ! not met / – not applicable), thread count with open count.
- **Left list**: "Overview" first (badge = open general threads), then changed files. Files show change type (add/edit/delete/rename) by color, badge = thread count on that file. Builder may show folders as a tree or show full paths, whichever reads better at pane widths.
- **Overview page**: description (markdown, rendered with `TextView.markdown` like ado-workitems), linked work items (click → ado-workitems details in a split pane, props `{detail:id}`), general threads with Reply/Resolve and a new-comment box, then a one-line summary of file threads per file (click jumps to the file).
- **File page**: toolbar with diff style toggle and range toggle; diff with threads inline under their anchor line; resolved threads collapsed by default (click to expand).

## Behaviour details (decided with the user)

- **Votes**: same five as ADO. The button for the current vote is highlighted. Reset = vote 0.
- **Draft**: one toggle; author-only in ADO, so if the API refuses, show the error and leave the toggle unchanged.
- **Diff style toggle**: unified / side-by-side, persisted per user (localStorage).
- **Range toggle**: "All changes" = target branch merge base vs latest iteration. "Since last look" = the iteration the user last viewed vs latest. "Last look" is recorded locally per PR when the user opens the PR (or a file — builder's call). If there is no previous look, the toggle is disabled with a tooltip.
- **Gates**: build gates → `ado-pipelines` with props `{project, build}`, opened as a **split pane** beside the review (`run("pane.split", {direction:"right", mod:"ado-pipelines", props})`) so the review dialog and its state stay put (user's choice; stacked dialogs may come later). Non-build gates → show their reason (policy name + status) in a tooltip or small popover.
- **Work items** linked on the Overview open the same way: split pane with `ado-workitems` props `{detail:id}`.
- **Unsent comments** (new-thread drafts and reply drafts) are saved to disk per PR, keyed by file + side + line (or thread id for replies), e.g. `~/.config/herdr-app/cache/ado-prs/drafts.json`. They survive going back to the list, closing the dialog, and restarts. Cleared when posted; drafts older than 7 days are deleted on load (user's choice). If a draft's line no longer exists after new pushes, show it in the Overview as "unplaced draft" rather than dropping it (my call).

## Provider boundary

Split the mod into:

- `review/view.js` — the UI. Speaks only the neutral model below.
- `review/providers/ado.js` — ADO implementation (`az rest`, reusing the `az()` helper pattern from `main.js`).
- (later) `review/providers/github.js` — `gh api`.

Neutral model (sketch — builder may refine field names):

```
PullRequest { id, url, title, description(markdown), repo, project?, source, target, author{name,id},
              created, isDraft, status, reviewers[{id,name,vote,required,isGroup}],
              gates[{id,name,state:'pass'|'fail'|'running'|'pending'|'notApplicable',
                     kind:'build'|'policy'|'check', link?:{project,build}|{url}, reason?}],
              workItems[{id,title,url}] }
FileChange { path, oldPath?, change:'add'|'edit'|'delete'|'rename', binary? }
Thread { id, status:'active'|'resolved'|..., file?:{path, side:'left'|'right', startLine, endLine},
         comments[{id, author, body(markdown), created, isMine}] }
Versions { latest, lastSeen? }  // opaque tokens; ADO = iteration ids, GitHub = commit shas
```

Provider interface:

```
getPullRequest(ref) → PullRequest
listFiles(ref, range) → FileChange[]          // range: {from?, to}
getFileContents(ref, path, range) → {old?, new?}
listThreads(ref) → Thread[]
addThread(ref, {file?, body}) → Thread
reply(ref, threadId, body) → Comment
setThreadStatus(ref, threadId, status)
vote(ref, value)                                // neutral: approve|approveWithSuggestions|waitForAuthor|reject|reset
setDraft(ref, bool)
```

GitHub mapping notes (for later, not built now): votes map to review states (approve / request changes / comment; "wait for author" has no equivalent → provider declares `capabilities.votes` so the UI hides unsupported buttons); gates = check runs + required status checks; draft via GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft`.

## ADO API notes

All via `az rest --resource 499b84ac-1321-427f-aa17-267ca6975798` against `https://dev.azure.com/<org>/<project>/_apis/git/repositories/<repoId>/pullRequests/<id>…`, api-version 7.1:

- PR: `GET pullRequests/{id}` (+ `/workitems`).
- Iterations: `GET …/iterations`; changes: `GET …/iterations/{n}/changes?$compareTo={m}` (m=0 = merge base).
- File content: `GET repositories/{repoId}/items?path=…&versionDescriptor.version=<commit>&versionDescriptor.versionType=commit&includeContent=true` using the iteration's `sourceRefCommit` / `commonRefCommit` (for "since last look", the earlier iteration's source commit).
- Threads: `GET/POST …/threads`, `POST …/threads/{t}/comments`, `PATCH …/threads/{t}` `{status}`. New file thread needs `threadContext {filePath, rightFileStart/End or leftFileStart/End {line, offset}}` and `pullRequestThreadContext {iterationContext {firstComparingIteration, secondComparingIteration}, changeTrackingId}` so ADO tracks it across pushes — get these from the changes response.
- Vote: `PUT …/reviewers/{myId}` `{vote: 10|5|0|-5|-10}`; my id from `GET https://app.vssps.visualstudio.com/_apis/profile/profiles/me` or `connectionData`.
- Draft: `PATCH pullRequests/{id}` `{isDraft}`.
- Gates: `GET https://dev.azure.com/<org>/<project>/_apis/policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/<projectId>/<prId>` (build policies carry `context.buildId`); plus PR `statuses` for external checks.
- Thread positions in old iterations: ADO returns `pullRequestThreadContext.trackingCriteria` / updated positions; display threads using their position in the iteration being shown, and hide (or list as "outdated") threads that don't map.

The diff itself is computed locally from the two file versions (ADO has no text-diff API). Builder's choice: a small JS Myers/patience diff in the mod, or `git diff --no-index` via `exec` on cached temp files.

## Entry points

- `ado-prs` row click → review view. Recommended: same dialog, list swaps to the review view with a back arrow (pattern used by ado-workitems details). Also support props `{review:{project, repoId, id}}` so another mod or `pane.split --props` can open a PR directly.
- PR id lookup box result also opens the review view.

## Left to the builder

- Exact file split, component structure, and caching strategy (cache file contents by commit sha in `~/.config/herdr-app/cache/ado-prs/`).
- Range comments (shift-click a second line) — include if straightforward; single-line is required.
- Keyboard navigation (j/k files, n/p threads) — nice-to-have.
- Large files / binaries: show "binary" or "too large, open in browser" past a threshold.
- Refresh: manual refresh button plus re-fetch after every write; light polling of gates while any are running.

## Constraints

- Herdr mod runtime (gpui-kit / gpui-base, `exec`, `run`, `props`, `openOverlay`). Known gotchas recorded in memory: `flex_shrink_1`, `h_flex` centers vertically so columns need `h_full()`, `list()` from gpui-kit for variable-height rows, write `mod.json` before `main.js` in new mod folders.
- Repo is public: fictional data only in screenshots/fixtures; commits use the noreply email.
- Settings (org, etc.) come from `addons.json` as in the existing mods.

## Calls made by Claude (check these)

- Provider seam: `review/view.js` + `review/providers/ado.js`, neutral model above.
- Review opens inside the same ado-prs dialog with a back arrow; props `{review:{project, repoId, id}}` also open it directly.
- Non-build gates show their reason on click; no navigation.
- Resolved threads collapsed by default.
- Unplaced drafts (line gone after a push) surface on Overview.
- Syntax highlighting, GitHub backend, merging/abandoning are out of scope.
