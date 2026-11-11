// The pull request review screen: header (votes, draft), status strip
// (reviewers, gates, thread count), file list, Overview page and file pages.
// Speaks only the neutral model (model.js) through a provider.
//
// Writes never update the screen optimistically: on success the PR and its
// threads are re-fetched; on failure the shown state stays as the server last
// reported it and the error goes to host.notify.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView, Popover } from "gpui-base";
import { exec, run, appHome } from "herdr";
import { readFile, writeFile, mkdir } from "fs/promises";
import { Drafts, draftKey, prKey } from "./drafts.js";
import {
  myVote, voteLook, gateLook, gateAction, anyRunning, changeLook, threadSummary, fileDrafts, replyDrafts, targetLabel, ago, displayName,
} from "./summary.js";
import { ICON, button, iconButton, textAction, badge, count, section, note, centered } from "./ui/parts.js";
import { FilePages } from "./filepage.js";
import { sinceLastLook } from "./rows.js";

const GATE_POLL_MS = 30000;
const THEME_CHECK_MS = 1000;
const LIST_W = 260;
const OVERVIEW = "overview";

// ---- drafts store (one per mod instance, shared by every Review) -----------

let draftsStore = null;
let draftsError = () => {};
function drafts() {
  if (draftsStore) return draftsStore;
  const dir = `${appHome()}/cache/ado-prs`;
  const path = `${dir}/drafts.json`;
  draftsStore = new Drafts({
    // A missing or corrupt file is an empty store; never reject.
    load: async () => {
      try {
        const v = JSON.parse(await readFile(path, "utf8"));
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    },
    save: async (data) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path, JSON.stringify(data));
    },
    onError: (e) => draftsError(e),
  });
  return draftsStore;
}

const msg = (e) => String(e?.message ?? e);

export class Review {
  /**
   * @param {{org: string, provider: import("./model.js").Provider, back(cx): void, notify(msg: string): void, chrome?(t): any[]}} host
   * @param {{project: string, repoId: string, id: number}} ref
   */
  constructor(host, ref, cx) {
    this.host = host;
    this.ref = { org: host.org, project: ref.project, repoId: ref.repoId, id: Number(ref.id) };
    this.provider = host.provider;
    this.drafts = drafts();
    draftsError = (e) => host.notify(`Couldn't save comment drafts: ${msg(e)}`);
    this.pk = prKey(this.ref); // drafts of this view always go to this PR
    this.page = ref.file ? String(ref.file) : OVERVIEW; // props may open a file directly
    this.pr = null;
    this.me = null;
    this.threads = null;
    this.files = null;
    this.filesError = null;
    this.range = null; // {from, to} iteration ids shown
    this.rangeMode = "all"; // "all" | "since" (last look)
    this.lastLook = undefined; // latest version seen on the previous visit (null: none)
    this.fp = new FilePages(this);
    this.error = null;
    this.loading = false;
    this.busy = new Set(); // keys of writes in flight
    this.boxes = new Map(); // draftKey → {state, target}
    this.replying = new Set(); // thread ids with an open reply box
    this.expanded = new Set(); // resolved thread ids shown expanded
    this.approveMenu = false;
    this.load(cx);
    this.poll = cx.timer.every(GATE_POLL_MS, (cx) => {
      // Reviewer-count policies sit in "running" until people vote; only builds
      // and checks finish on their own, so only they keep the poll going.
      if (this.pr && anyRunning(this.pr.gates.filter((g) => g.kind !== "policy")) && !this.loading) this.refreshPr(cx);
    });
    // render() notes the theme's darkness; this re-highlights after a switch.
    this.themeCheck = cx.timer.every(THEME_CHECK_MS, (cx) => this.fp.checkTheme(cx));
  }

  dispose() {
    this.poll?.cancel();
    this.poll = null;
    this.themeCheck?.cancel();
    this.themeCheck = null;
    this.drafts.flush().catch((e) => draftsError(e));
    // Text is already in the drafts store; free the native textarea states.
    for (const key of [...this.boxes.keys()]) this.dropBox(key);
  }

  dropBox(key) {
    const box = this.boxes.get(key);
    if (!box) return;
    this.boxes.delete(key);
    try { box.state.release(); } catch { /* already released */ }
  }

  back(cx) {
    this.dispose();
    this.host.back(cx);
  }

  rangeFor(pr) {
    const since = sinceLastLook(this.lastLook, pr.versions);
    if (this.rangeMode === "since" && since.available) return { from: since.from, to: pr.versions.latest };
    return { from: null, to: pr.versions.latest };
  }

  // "Last look": the previous visit's latest version is read once (before this
  // visit overwrites it) and is the `from` of "Since last look".
  recordLook(pr) {
    const k = `review.seen.${this.pk}`;
    try {
      if (this.lastLook === undefined) {
        const prev = Number.parseInt(localStorage.getItem(k) ?? "", 10);
        this.lastLook = Number.isFinite(prev) ? prev : null;
      }
      if (pr.versions.latest != null) localStorage.setItem(k, String(pr.versions.latest));
    } catch {
      if (this.lastLook === undefined) this.lastLook = null;
    }
  }

  setRangeMode(cx, mode) {
    if (this.rangeMode === mode || !this.pr) return;
    this.rangeMode = mode;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.apply(this.pr, cx);
      } catch (e) {
        this.host.notify(msg(e));
      }
      cx.notify();
    });
  }

  // ---- loading

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [pr, me] = await Promise.all([
          this.provider.getPullRequest(this.ref),
          this.provider.me().catch(() => null),
          this.drafts.open(this.pk).catch(() => {}),
        ]);
        this.me = me;
        this.recordLook(pr);
        await this.apply(pr, cx);
        if (!this.boxes.has("g")) this.composer("g", { general: true }, cx);
        for (const d of this.drafts.list(this.pk)) {
          if (this.boxes.has(d.key)) continue;
          if (d.target?.thread != null) {
            this.composer(d.key, d.target, cx);
            this.replying.add(d.target.thread);
          } else if (d.target?.file != null) {
            this.composer(d.key, d.target, cx);
          }
        }
      } catch (e) {
        this.error = msg(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Re-fetch the PR and threads (files only when the range changed).
  async apply(pr, cx) {
    const range = this.rangeFor(pr);
    const same = this.range && this.range.from === range.from && this.range.to === range.to;
    const filesP = same && this.files
      ? Promise.resolve(this.files)
      : this.provider.listFiles(this.ref, range).then((f) => { this.filesError = null; return f; },
        (e) => { this.filesError = msg(e); return null; });
    const [threads, files] = await Promise.all([this.provider.listThreads(this.ref, range), filesP]);
    this.pr = pr;
    this.range = range;
    this.threads = threads;
    if (files || !same) this.files = files;
    if (this.page !== OVERVIEW && this.files && !this.files.some((f) => f.path === this.page)) this.page = OVERVIEW;
    this.fp.ensure(cx);
    cx.notify();
  }

  async reload(cx) {
    await this.apply(await this.provider.getPullRequest(this.ref), cx);
  }

  // Gate polling: PR only.
  refreshPr(cx) {
    cx.spawn(async (cx) => {
      try {
        this.pr = await this.provider.getPullRequest(this.ref);
      } catch {
        // Keep the last known state; the next tick retries.
      }
      cx.notify();
    });
  }

  // Run one write. Success → re-fetch PR + threads; failure → notify, state untouched.
  write(cx, key, fn, after) {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await fn();
      } catch (e) {
        this.host.notify(msg(e));
        this.busy.delete(key);
        cx.notify();
        return;
      }
      try {
        after?.(cx);
        await this.reload(cx);
      } catch (e) {
        this.host.notify(`Saved, but couldn't refresh: ${msg(e)}`);
      } finally {
        this.busy.delete(key);
        cx.notify();
      }
    });
  }

  // ---- actions

  vote(cx, key) {
    this.approveMenu = false;
    this.write(cx, "vote", () => this.provider.vote(this.ref, key));
  }

  toggleDraft(cx) {
    const want = !this.pr.isDraft;
    this.write(cx, "draft", () => this.provider.setDraft(this.ref, want));
  }

  // A comment box bound to the drafts store. Created from init/async/event
  // context only (TextareaState can't be created in render).
  composer(key, target, _cx) {
    const state = TextareaState.new({ value: this.drafts.get(key, this.pk)?.body ?? "", placeholder: "Markdown… (saved as a draft until posted)" });
    state.set_auto_grow(2, 12);
    state.on("change", (_e, cx) => {
      // Always this view's PR: a late event must not write into another PR's drafts.
      this.drafts.set(key, target, state.value(), this.pk);
      cx.notify();
    });
    const box = { state, target };
    this.boxes.set(key, box);
    return box;
  }

  discardDraft(cx, key) {
    this.drafts.delete(key, { pr: this.pk });
    this.dropBox(key);
    cx.notify();
  }

  /**
   * After `body` was posted from box `key`: drop the draft and empty the box,
   * but only while they still hold exactly what was posted (text typed during
   * the post survives). Returns true when the box was emptied.
   */
  clearBox(key, body) {
    this.drafts.delete(key, { pr: this.pk, ifBody: body });
    const box = this.boxes.get(key);
    if (!box || box.state.value().trim() !== body.trim()) return false;
    box.state.set_value("");
    return true;
  }

  postGeneral(cx) {
    const box = this.boxes.get("g");
    const body = box?.state.value().trim();
    if (!body) return;
    this.write(cx, "post:g", () => this.provider.addThread(this.ref, { target: { general: true }, body, range: this.range }),
      () => this.clearBox("g", body));
  }

  startReply(cx, thread) {
    const key = draftKey({ thread: thread.id });
    if (!this.boxes.has(key)) this.composer(key, { thread: thread.id }, cx);
    this.replying.add(thread.id);
    this.boxes.get(key).state.focus();
    cx.notify();
  }

  postReply(cx, thread) {
    const key = draftKey({ thread: thread.id });
    const body = this.boxes.get(key)?.state.value().trim();
    if (!body) return;
    this.write(cx, `post:${key}`, () => this.provider.reply(this.ref, thread.id, body), () => {
      if (this.clearBox(key, body)) this.replying.delete(thread.id);
    });
  }

  setStatus(cx, thread, status) {
    this.write(cx, `status:${thread.id}`, () => this.provider.setThreadStatus(this.ref, thread.id, status));
  }

  openGate(gate) {
    const a = gateAction(gate);
    if (a.kind === "build") this.split("ado-pipelines", { project: a.project, build: a.build });
    else if (a.kind === "url") this.browse(a.url);
  }

  split(mod, props) {
    try {
      run("pane.split", { direction: "right", mod, props });
    } catch (e) {
      this.host.notify(msg(e));
    }
  }

  browse(url) {
    exec("open", [url]).catch((e) => this.host.notify(msg(e)));
  }

  go(cx, page) {
    // A file outside the shown range (e.g. a thread's file under "Since last
    // look"): switch to All changes; apply() then shows it, or falls back to
    // the Overview when the PR doesn't change it at all.
    if (page !== OVERVIEW && this.files && !this.files.some((f) => f.path === page)) {
      if (this.rangeMode !== "since") {
        this.host.notify(`${page} isn't changed in this pull request`);
        return;
      }
      this.page = page;
      this.setRangeMode(cx, "all");
      return;
    }
    this.page = page;
    this.fp.ensure(cx);
    cx.notify();
  }

  // A thread with an unsent reply always shows expanded so the draft is visible.
  threadOpen(th) {
    return th.status !== "resolved" || this.expanded.has(th.id) || this.drafts.get(draftKey({ thread: th.id }), this.pk) != null;
  }

  // ---- header

  header(t) {
    const pr = this.pr;
    const row = h_flex().flex_none().gap(10).items_center()
      .child(iconButton(t, "rv-back", "back", "Back to the list", (_e, cx) => this.back(cx)))
      .child(div().flex_none().text_size(12.5).text_color(t.dim).child(`#${this.ref.id}`))
      .when(Boolean(pr?.isDraft), (el) => el.child(badge(t, "DRAFT", t.dim)))
      .when(Boolean(pr && pr.status !== "active"), (el) => el.child(badge(t, String(pr.status).toUpperCase(), t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground)
        .child(pr?.title ?? (this.error ? "" : "Loading…")))
      .when(Boolean(pr && this.provider.capabilities.draft), (el) => el.child(this.draftToggle(t)))
      .child(iconButton(t, "rv-refresh", "refresh", "Refresh", (_e, cx) => this.load(cx), { spin: this.loading }))
      .when(Boolean(pr?.url), (el) => el.child(iconButton(t, "rv-open", "external", "Open in browser", () => this.browse(pr.url))))
      .children(this.host.chrome?.(t) ?? []);
    let v = v_flex().flex_none().px(16).py(10).gap(6).border_b(1).border_color(t.border).child(row);
    if (pr) {
      v = v.child(h_flex().gap(10).items_center().flex_wrap()
        .child(div().flex_1().min_w(200).truncate().text_size(12).text_color(t.muted)
          .child(`${pr.repo} · ${pr.source} → ${pr.target} · ${pr.author?.name ?? "?"} · ${ago(pr.created)}`))
        .child(this.votes(t)));
    }
    return v;
  }

  draftToggle(t) {
    const pr = this.pr;
    const busy = this.busy.has("draft");
    return button(t, "rv-draft", busy ? "Saving…" : pr.isDraft ? "Publish" : "Mark as draft", (_e, cx) => this.toggleDraft(cx), {
      disabled: busy,
      tip: pr.isDraft ? "Draft: publish it so reviewers are notified" : "Published: turn it back into a draft",
    });
  }

  votes(t) {
    const cur = myVote(this.pr.reviewers, this.me?.id);
    const caps = new Set(this.provider.capabilities.votes);
    const busy = this.busy.has("vote");
    const vb = (key, label, tone) => button(t, `rv-vote-${key}`, label, (_e, cx) => this.vote(cx, key),
      { active: cur === key, tone, disabled: busy });
    const approveLabel = cur === "approveWithSuggestions" ? "Approved w/ suggestions ▾" : cur === "approve" ? "Approved ▾" : "Approve ▾";
    const approveActive = cur === "approve" || cur === "approveWithSuggestions";
    const item = (key, label) => div().id(`rv-menu-${key}`).px(10).py(5).rounded(4).text_size(12).cursor_pointer()
      .text_color(cur === key ? t.ansi2 : t.foreground).when(cur === key, (el) => el.font_semibold())
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.vote(cx, key)).child(label);
    const approve = Popover.new("rv-approve")
      .anchor("top_right")
      .open(this.approveMenu)
      .on_open_change((open, cx) => { this.approveMenu = open && !busy; cx.notify(); })
      .trigger(button(t, "rv-vote-approve-menu", approveLabel, null, { active: approveActive, tone: t.ansi2, disabled: busy, plain: true }))
      .content(v_flex().p(4).min_w(200).rounded(8).border(1).border_color(t.border).bg(t.raised)
        .when(caps.has("approve"), (el) => el.child(item("approve", "Approve")))
        .when(caps.has("approveWithSuggestions"), (el) => el.child(item("approveWithSuggestions", "Approve with suggestions"))));
    return h_flex().flex_none().gap(6).items_center()
      .when(busy, (el) => el.child(note(t, "Voting…")))
      .when(caps.has("waitForAuthor"), (el) => el.child(vb("waitForAuthor", "Wait for author", t.working)))
      .when(caps.has("reject"), (el) => el.child(vb("reject", "Reject", t.blocked)))
      .when(caps.has("approve") || caps.has("approveWithSuggestions"), (el) => el.child(approve))
      .when(caps.has("reset"), (el) => el.child(vb("reset", "Reset", t.muted)));
  }

  // ---- status strip

  strip(t) {
    const pr = this.pr;
    const sum = threadSummary(this.threads);
    const people = pr.reviewers.filter((r) => !r.isGroup || r.vote !== 0 || r.required);
    const reviewers = people.map((r, i) => {
      const l = voteLook(r.vote);
      return h_flex().id(`rv-r-${i}`).flex_none().gap(4).items_center().text_size(11.5)
        .tooltip(`${displayName(r.name)}: ${l.label}${r.required ? " (required)" : ""}`)
        .child(div().text_color(t[l.color]).child(l.glyph))
        .child(div().text_color(t.foreground).child(displayName(r.name)))
        .when(r.required, (el) => el.child(div().text_color(t.dim).child("required")));
    });
    const gates = pr.gates.map((g, i) => {
      const l = gateLook(g);
      const a = gateAction(g);
      const tip = `${g.name}${g.optional ? " (optional)" : ""}\n${g.reason ?? g.state}` +
        (a.kind === "build" ? "\nClick to open the run" : a.kind === "url" ? "\nClick to open in the browser" : "");
      return h_flex().id(`rv-g-${i}`).flex_none().gap(4).items_center().text_size(11.5).tooltip(tip)
        .when(l.dim, (el) => el.opacity(0.55))
        .when(a.kind !== "info", (el) => el.cursor_pointer().hover((s) => s.opacity(0.75)).on_click(() => this.openGate(g)))
        .child(div().text_color(t[l.color]).child(l.glyph))
        .child(div().text_color(t.foreground).child(g.name));
    });
    if (pr.gatesError) {
      gates.push(div().id("rv-g-err").flex_none().text_size(11.5).text_color(t.blocked)
        .tooltip(pr.gatesError).child("! gates unavailable"));
    }
    const sep = () => div().flex_none().w(1).h(14).bg(t.border);
    return h_flex().flex_none().px(16).py(6).gap(12).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).gap(12).items_center().flex_wrap()
        .children(reviewers.length ? reviewers : [note(t, "No reviewers")])
        .child(sep())
        .children(gates.length ? gates : [note(t, "No gates")]))
      .child(div().id("rv-count").flex_none().text_size(11.5).text_color(sum.open ? t.foreground : t.dim)
        .tooltip(`${sum.total} threads, ${sum.open} open`)
        .child(this.threads ? `💬 ${sum.total} · ${sum.open} open` : "💬 …"));
  }

  // ---- left list

  fileList(t) {
    const sum = threadSummary(this.threads);
    const sel = (page) => this.page === page;
    const row = (id, page, kids, tip) => h_flex().id(id).flex_none().px(10).py(4).gap(6).items_center().rounded(6).cursor_pointer()
      .when(sel(page), (el) => el.bg(t.selected))
      .hover((s) => s.bg(sel(page) ? t.selected : t.hover))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_e, cx) => this.go(cx, page))
      .children(kids);
    const rows = [row("rv-f-overview", OVERVIEW, [
      div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child("Overview"),
      count(t, sum.generalOpen, true),
    ], "Description, work items and general comments")];
    if (this.files) {
      this.files.forEach((f, i) => {
        const l = changeLook(f.change);
        const slash = f.path.lastIndexOf("/");
        const name = f.path.slice(slash + 1);
        const dir = f.path.slice(0, slash + 1).replace(/^\//, "");
        const c = sum.byFile.get(f.path);
        rows.push(row(`rv-f-${i}`, f.path, [
          div().flex_none().w(12).text_size(10.5).font_semibold().text_color(t[l.color]).child(l.letter),
          v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(12).text_color(f.change === "delete" ? t.blocked : t.foreground).child(name))
            .when(Boolean(dir), (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(dir))),
          count(t, c?.total, c?.open > 0),
        ], `${f.path}${f.oldPath ? `\nrenamed from ${f.oldPath}` : ""}\n${f.change}${c ? ` · ${c.total} threads, ${c.open} open` : ""}`));
      });
    }
    const status = this.filesError ? note(t, `Couldn't load files: ${this.filesError}`, t.blocked)
      : !this.files ? note(t, "Loading files…") : null;
    return div().id("rv-files").flex_none().w(LIST_W).h_full().min_h(0).border_r(1).border_color(t.border).overflow_y_scrollbar()
      .child(v_flex().p(6).gap(1).children(rows)
        .when(Boolean(this.files), (el) => el.child(div().px(10).pt(6).text_size(10.5).text_color(t.dim)
          .child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`)))
        .when(Boolean(status), (el) => el.child(div().px(10).pt(6).child(status))));
  }

  // ---- threads

  thread(t, th) {
    const resolved = th.status === "resolved";
    const open = this.threadOpen(th);
    const first = th.comments[0];
    const key = draftKey({ thread: th.id });
    const box = this.boxes.get(key);
    const busyStatus = this.busy.has(`status:${th.id}`);
    const busyPost = this.busy.has(`post:${key}`);
    const statusColor = resolved ? t.ansi2 : th.status === "pending" ? t.muted : t.working;
    const head = h_flex().id(`rv-th-h-${th.id}`).gap(8).items_center()
      .when(resolved, (el) => el.cursor_pointer().on_click((_e, cx) => {
        if (this.expanded.has(th.id)) this.expanded.delete(th.id); else this.expanded.add(th.id);
        cx.notify();
      }))
      .when(resolved, (el) => el.child(svg(ICON(open ? "chev-down" : "chev-right")).size(11).text_color(t.dim)))
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child(first?.author ?? "?"))
      .child(div().text_size(11).text_color(statusColor).child(resolved ? th.rawStatus ?? "resolved" : th.status))
      .when(Boolean(th.file), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
        .child(targetLabel({ file: th.file.path, side: th.file.side, line: th.file.startLine, endLine: th.file.endLine }))))
      .when(!th.file, (el) => el.child(div().flex_1()))
      .when(!open, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(first?.body.split("\n")[0] ?? "")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(first ? `${ago(first.created)} ago` : ""));
    let card = v_flex().gap(8).p(10).rounded(8).border(1).border_color(resolved ? t.border : t.accent).child(head);
    if (!open) return card;
    card = card.children(th.comments.map((c, i) => v_flex().gap(3)
      .when(i > 0, (el) => el.child(h_flex().gap(8)
        .child(div().text_size(12).text_color(t.foreground).child(c.author ?? "?"))
        .child(div().text_size(11).text_color(t.dim).child(`${ago(c.created)} ago`))))
      .child(TextView.markdown(`rv-c-${th.id}-${c.id}`, c.body || " ").w_full().text_size(12.5).selectable(true)
        .on_link_click((url) => this.browse(url)))));
    const replying = this.replying.has(th.id) && box;
    if (replying) {
      card = card.child(this.composerBox(t, box, `rv-reply-${th.id}`, busyPost ? "Posting…" : "Reply",
        (cx) => this.postReply(cx, th), busyPost, (cx) => { this.replying.delete(th.id); cx.notify(); }));
    }
    return card.child(h_flex().gap(4).items_center()
      .when(!replying, (el) => el.child(textAction(t, `rv-th-reply-${th.id}`, "Reply", (_e, cx) => this.startReply(cx, th))))
      .child(resolved
        ? textAction(t, `rv-th-st-${th.id}`, busyStatus ? "Reactivating…" : "Reactivate", (_e, cx) => this.setStatus(cx, th, "active"), { disabled: busyStatus })
        : textAction(t, `rv-th-st-${th.id}`, busyStatus ? "Resolving…" : "Resolve", (_e, cx) => this.setStatus(cx, th, "resolved"), { disabled: busyStatus })));
  }

  composerBox(t, box, id, label, onPost, busy, onCancel) {
    const empty = !box.state.value().trim();
    return v_flex().gap(6)
      .child(div().w_full().rounded(6).border(1).border_color(t.input).bg(t.background).p(2)
        .child(Textarea.new(box.state).w_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(8).items_center()
        .child(button(t, `${id}-post`, label, (_e, cx) => onPost(cx), { primary: true, disabled: busy || empty }))
        .when(Boolean(onCancel), (el) => el.child(button(t, `${id}-cancel`, "Hide", (_e, cx) => onCancel(cx),
          { tip: "Hide the box; the draft is kept" })))
        .when(!empty, (el) => el.child(note(t, "Draft saved"))));
  }

  // ---- pages

  overview(t) {
    const pr = this.pr;
    const general = (this.threads ?? []).filter((th) => !th.file);
    general.sort((a, b) => (a.status === "resolved") - (b.status === "resolved"));
    const sum = threadSummary(this.threads);
    const fds = fileDrafts(this.drafts.list(this.pk), this.files);
    const rds = replyDrafts(this.drafts.list(this.pk), this.threads);
    const filesWithThreads = [...sum.byFile.entries()];
    const g = this.boxes.get("g");
    const posting = this.busy.has("post:g");
    return div().id("rv-overview").flex_1().h_full().min_w(0).overflow_y_scrollbar().child(v_flex().px(20).py(16).gap(18)
      .child(v_flex().gap(8).child(section(t, "Description"))
        .child(pr.description.trim()
          ? TextView.markdown(`rv-desc-${pr.id}`, pr.description).w_full().text_size(13).selectable(true).on_link_click((url) => this.browse(url))
          : note(t, "No description.")))
      .when(pr.workItems.length > 0, (el) => el.child(v_flex().gap(4).child(section(t, "Work items", pr.workItems.length))
        .children(pr.workItems.map((w) => h_flex().id(`rv-wi-${w.id}`).px(8).py(4).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).tooltip("Open beside this view")
          .on_click(() => this.split("ado-workitems", { detail: w.id }))
          .child(div().flex_none().text_size(12).text_color(t.accent).child(`#${w.id}`))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(w.title ?? ""))))))
      .child(v_flex().gap(10).child(section(t, "Comments", this.threads ? `${sum.general} · ${sum.generalOpen} open` : "…"))
        .when(Boolean(this.threads) && !general.length, (el) => el.child(note(t, "No general comments.")))
        .children(general.map((th) => this.thread(t, th)))
        .when(Boolean(g), (el) => el.child(this.composerBox(t, g, "rv-new", posting ? "Posting…" : "Comment", (cx) => this.postGeneral(cx), posting))))
      .when(fds.length > 0, (el) => el.child(v_flex().gap(4)
        .child(section(t, "Unsent drafts on files", fds.length))
        .child(note(t, "Not posted yet. Open the file to place and post them; drafts on lines that no longer exist stay here."))
        .children(fds.map((d, i) => h_flex().id(`rv-fd-${i}`).px(8).py(4).gap(8).items_center().rounded(6)
          .when(!d.gone, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.go(cx, d.target.file)))
          .child(div().flex_none().text_size(11.5).text_color(d.gone ? t.blocked : t.accent).child(targetLabel(d.target)))
          .when(d.gone, (el) => el.child(badge(t, "FILE NOT IN PR", t.blocked)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(d.body.split("\n")[0]))))))
      .when(rds.length > 0, (el) => el.child(v_flex().gap(4)
        .child(section(t, "Unsent replies", rds.length))
        .child(note(t, "Replies not posted yet. Replies on file threads are under the thread on the file's page."))
        .children(rds.map((d, i) => h_flex().id(`rv-rd-${i}`).px(8).py(4).gap(8).items_center().rounded(6)
          .when(Boolean(d.file), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.go(cx, d.file)))
          .child(div().flex_none().text_size(11.5).text_color(d.known ? t.accent : t.blocked).child(d.file ?? `Thread #${d.thread}`))
          .when(!d.known, (el) => el.child(badge(t, "THREAD NOT FOUND", t.blocked)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(d.body.split("\n")[0]))
          .when(!d.known, (el) => el.child(button(t, `rv-rd-x-${i}`, "Discard", (_e, cx) => this.discardDraft(cx, d.key))))))))
      .when(filesWithThreads.length > 0, (el) => el.child(v_flex().gap(4).child(section(t, "Threads on files", filesWithThreads.length))
        .children(filesWithThreads.map(([path, c], i) => h_flex().id(`rv-ft-${i}`).px(8).py(4).gap(8).items_center().rounded(6)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.go(cx, path))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(path))
          .child(div().flex_none().text_size(11.5).text_color(c.open ? t.working : t.dim)
            .child(`${c.total} thread${c.total === 1 ? "" : "s"} · ${c.open} open`)))))));
  }

  // The per-file diff page: see filepage.js.
  filePage(t, path) {
    return this.fp.render(t, path);
  }

  render(t) {
    let body;
    if (this.error && !this.pr) {
      body = centered(div().text_size(13).text_color(t.blocked).child("Couldn't load this pull request"),
        div().text_size(12).text_color(t.muted).child(this.error));
    } else if (!this.pr) {
      body = centered(note(t, `Loading !${this.ref.id}…`));
    } else {
      body = h_flex().flex_1().min_h(0).items_start()
        .child(this.fileList(t))
        .child(this.page === OVERVIEW ? this.overview(t) : this.filePage(t, this.page));
    }
    return v_flex().size_full().min_h(0)
      .child(this.header(t))
      .when(Boolean(this.pr), (el) => el.child(this.strip(t)))
      .when(Boolean(this.error && this.pr), (el) => el.child(div().px(16).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(body);
  }
}
