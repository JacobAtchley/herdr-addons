# ADO Feed — design

## Why

Jacob is a team lead. Things that need him happen in Azure DevOps during the day,
for example:

- a teammate's PR is waiting on his review;
- a build fails on someone else's PR.

Today he only finds out at the next morning's standup, a day late. The feed
should surface these within minutes, so he can act the same day.

## Goals

- One feed of things that need the lead, from three sources:
  - **pull requests:** ones he must review, or that changed after he looked;
  - **builds:** the team's failures;
  - **work items:** newly assigned to him.
- **He hears about new things without opening anything:**
  - one popup that sums up what's new;
  - a count of unresolved items on the tab bar's ADO button.
- **Filters:**
  - time: **24 hours**, **48 hours**, **1 week**;
  - a **Show resolved** switch.
- **A resolve toggle on each item.** It records the item as resolved in a local
  SQLite database, and for PRs and Pending QA work items it also acts in ADO
  (see Resolve actions).
- **The feed notices on its own** when an item was handled elsewhere (in the ADO
  website or another Herdr view) and resolves it.

## Non-goals

- Other work item events, such as blocking tags, stale items or Pending QA
  items owned by others. The standup board covers those.
- A popup per item.
- GitHub support.
- Filtering by kind or person: the time and resolved filters are enough for
  now.

## Anti-goals (a failure even if it "works")

- **Popup spam:**
  - the first sync after install, or after the database is deleted, posts no
    popup. Everything it finds is stored as **open** (shown in the feed and
    counted on the badge) and marked as already notified. Jacob's call: on day
    one he sees what's waiting, without a burst of popups;
  - each sync posts at most one popup.
- **A toggle that does something in ADO you didn't expect:** the toggle's
  tooltip and label name the ADO action ("Approve and resolve", "Close and
  resolve").
- **A failed ADO action that still marks the item resolved:** the database only
  changes after ADO confirms.

## Where it lives

- **The mod:** a new mod `azure-devops/mods/ado-feed`, the fifth row in the ADO
  dropdown, under Standup: "Feed", with the description "What needs your
  attention".
  - It's a dialog like the others (0.8 × 0.8).
  - `keys.json` gets a key. Builder's call: `cmd-shift-a`, if it's free.
- **The dropdown height:** grow `ado-menu/mod.json` and the `openOverlay` height
  in my-tabs from 218 to 270 (52 per row + 10).
- **"Team"** means the same team as the standup: `ado.standup.project` and the
  standup's remembered team, falling back to `ado.standup.team`. The standup
  stores its team in its own `localStorage`, so the feed reads the
  `addons.json` value. Builder's call: also accept an optional
  `ado.feed.team`.

## Data and state

- **`feed.py`** (python3, stdlib only, run with `-I`) owns all ADO calls and the
  database.
  - It reuses `ado-standup/standup.py`'s `Ado` client (with its retry),
    `token`, `default_org`, `team_info` and the PR/group matching logic. It
    loads that file by path with `importlib` instead of copying it.
  - If reuse becomes awkward, moving the shared code into a module both mods
    load is fine.
- **The database:** `<appHome>/ado-feed.db`.
  - One row per feed item, keyed:
    - `pr:<repoId>:<id>`
    - `build:<definitionId>:<branch>`
    - `wi:<id>`
  - Each row stores: kind, title, the sub-line facts, url, the refs needed to
    open or act on it, `event_at` (the latest triggering event), `event_text`,
    `first_seen`, `resolved_at`, `resolved_by` (`me` | `auto`), and the
    resolve note.
  - A `meta` table holds `last_sync` and whether the baseline exists.
  - Resolved rows older than 30 days are deleted.
- **Concurrency:** both my-tabs and the open feed may run a sync. Use SQLite's
  busy timeout and `BEGIN IMMEDIATE`, so two syncs never interleave writes.
- **Commands.** Each one prints JSON after a marker line, as `standup.py` does:
  - `sync`: fetch, upsert, reopen and auto-resolve. It returns
    `{new: [...], open: N, first: bool, errors: {...}}`.
    - `new` holds the unresolved rows no popup has announced yet. Each row has
      a `notified` flag; `sync --notify` (my-tabs) sets it on what it returns.
      A sync started by the feed doesn't set it, so an item the open feed saw
      first still gets its popup on the next background check.
    - `open` counts every unresolved item, whatever its age.
  - `list --window 24h|48h|1w [--resolved]`: rows for the feed (see The
    feed view for which rows each window holds).
  - `resolve <key>`: runs the ADO action (below), then marks the item resolved.
    It returns the resulting row or an error.
  - Builder's call: `unresolve <key>`, which reopens an item in the database
    only, for a mis-click. ADO isn't touched; a vote or a closed state stays.

## What appears, reappears and auto-resolves

| Kind | Appears when | Reappears (after resolved) when | Auto-resolves when |
|---|---|---|---|
| **PR** | Active, not a draft, has no approval yet from him or from the team's group, and he's a reviewer: by name, or through one of his team's groups (the groups in `team_info`, the same ones the standup matches). "Him" is the signed-in identity from connectionData | A push (a new iteration) or a comment by someone else, later than his vote or resolution | He has voted (from anywhere) after the latest push or comment; **or**, when he's on it only through a group, that group reviewer's vote is 5 or more (someone approved for the group; Jacob's call); or the PR is completed or abandoned |
| **Build** | A failed or partiallySucceeded run on a team pipeline (PR builds included) in the last week. Grouped by pipeline + branch: "failed 3×, latest 10m ago" | A new failed run on that pipeline + branch finished after `resolved_at` | The latest completed run on that pipeline + branch succeeded |
| **Work item** | It's assigned to the lead now and wasn't before, based on the `System.AssignedTo` change in its updates. `event_at` is when it was assigned to him, and `event_text` says who assigned it and from whom | Reassigned to him again after being resolved | It's no longer assigned to him, or it reached a Completed or Removed state category |

- **"Team pipelines":** the same pipelines the standup reads. Builder's call on
  narrowing them to the team's repos, if the project-wide list proves noisy;
  note this in RECIPE.
- **Vote and comment times:** from the PR threads. Vote changes appear as
  system comments with dates; iterations come from the iterations API.

## Resolve actions

| Kind | In ADO | Then |
|---|---|---|
| PR | If his vote is below 5 (not approved), set his vote to 10 (approve) as himself. This adds him as an individual reviewer if he was only on it through a group. If he's already approved (5 or 10), nothing | Resolved, by `me` |
| Build | Nothing | Resolved, by `me` |
| Work item in **Pending QA** (state name) | Set the state to the work item type's Completed-category state, normally "Closed"; read it from the state categories the standup already uses | Resolved, by `me` |
| Work item in any other state | Nothing | Resolved, by `me` |

If the ADO call fails, there's an error popup and the row stays unresolved.

## Polling, popup and count

- **The background poll lives in my-tabs,** next to the orchestrator poll,
  because my-tabs is always mounted.
  - It runs `feed.py sync` every 3 minutes, plus once at startup.
  - It skips a run while one is still going.
- **The popup:** when a sync returns `new` items and the baseline already
  existed, my-tabs posts one notification:
  - title: "3 new in ADO";
  - body: "2 PRs to review · 1 failed build";
  - action: `mod.open ado-feed`.
- **The count:** a badge on the ADO tab-bar button shows `open`, styled like
  the orchestrator's count, with the tooltip "N things need you".
  - It's hidden at 0.
  - It's shared through `setShared("ado.feed.count")`, so the feed can update
    it right after a toggle or its own sync.
- **Sync failure:** keep the last count. Show the error in the feed's banner,
  not as a popup.

## The feed view

- **Header:**
  - icon and "Feed", with the project and team;
  - time pills: 24 hours | 48 hours | 1 week, remembered; 24 hours by default;
  - a "Show resolved" toggle, remembered; off by default;
  - "updated Nm ago", refresh, dock as pane, close (as the standup does).
- **`event_at` per kind:**
  - PR: the latest of when he was added as a reviewer (or the PR's creation
    date), the latest push, and the latest comment by someone else;
  - build: the latest failed run's finish time;
  - work item: when it was assigned to him.
- **Which rows each window shows (Jacob's call):**
  - **24 hours** and **48 hours**: items whose `event_at` falls in that window;
  - **1 week**: every unresolved item, whatever its age, so a PR waiting 10
    days still shows, plus items whose `event_at` is in the last week;
  - **Show resolved** adds the resolved items in the same window. For 1 week,
    that's anything resolved in the last week.
- **List:** newest `event_at` first.
- **Each row:**
  - a lead bar colored by kind;
  - the title;
  - a sub-line that says what happened ("Marcus pushed 2 commits", "failed 3×
    on feature/x", "assigned by Terry, was Marcus");
  - the time ago;
  - on the right, a round check toggle whose tooltip names the action.
- **Resolved rows** (when shown) are dimmed, with "resolved 2h ago by you" or
  "… automatically". Their toggle reopens them (`unresolve`).
- **Clicking a row** opens the item as a stacked dialog, as the standup does:
  - a PR opens in the ado-prs review, `returnTo: "Feed"`;
  - a build opens the latest failed run in ado-pipelines;
  - a work item opens in the ado-workitems detail.
- **Opening the feed** runs a sync and refreshes every 2 minutes while open.
- **Empty state:** "Nothing needs you in the last 24 hours."
- **Errors:** a partial-failure banner like the standup's.

## Testing

- Python `unittest` for `feed.py`'s state logic, with fake ADO responses (no
  network). Cover:
  - appear;
  - group builds;
  - reopen after a newer event;
  - auto-resolve by vote, green run or reassignment;
  - a baseline sync that reports no `new` items;
  - a resolve whose ADO call fails, which leaves the row unresolved;
  - two syncs at once.
  Also cover: a group approval auto-resolving a group-only PR, and the 1 week
  window holding a 10-day-old open item.
- Live, read-only checks against the real org. Don't approve or close anything
  real during development; the PR and work item resolve paths are tested only
  with fakes, and Jacob tries them by hand.
- `herdr-app check` for the mod, plus a screenshot.

## Docs

- README: the new mod and any `addons.json` keys.
- RECIPE.md:
  - the feed;
  - the my-tabs badge;
  - the database location;
  - the menu height change;
  - the key.
