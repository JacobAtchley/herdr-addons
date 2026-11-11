// Azure DevOps pull requests: every active PR in the organization, across all
// projects, from one org-level REST call (`az rest`, so it uses the az login).
// Grouped by project; filter All / Mine / To review / Pending, search. Clicking a
// row opens the review view (review/view.js) in place of the list; the external
// icon opens the PR in the browser. The PR id box looks up any one PR by id,
// including closed or older ones, and opens its review.
// props.review = {project, repoId, id} opens one PR's review directly.
//
// Opens as a dialog (mod.open:ado-prs), or as a pane beside a shell.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, props, closeOverlay, run, notify, home, appHome } from "herdr";
import { readFile } from "fs/promises";
import { Review } from "./review/view.js";

// Settings from addons.json in the herdr-app folder (see the herdr-addons
// README). Read on each use, so edits apply without reloading the mod.
async function addonSettings() {
  try {
    return JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8")) ?? {};
  } catch {
    return {};
  }
}

// Claude Code's model for one of the launch buttons: claude.models.<use>,
// else claude.model, else Opus.
const DEFAULT_MODEL = "opus";
async function claudeModel(use) {
  const c = (await addonSettings()).claude ?? {};
  return String(c.models?.[use] || c.model || DEFAULT_MODEL);
}

// The folder Claude Code tabs open in: claude.folder ("~/…" allowed), else home.
async function claudeFolder() {
  const f = (await addonSettings()).claude?.folder;
  return f ? String(f).replace(/^~(?=\/|$)/, home()) : home();
}


const REFRESH_MS = 120000;
// PRs created longer ago than this are left out.
const MAX_AGE_DAYS = 30;
// Review comment threads per PR: system threads (votes, pushes) and deleted ones don't count.
const THREAD_QUERY = "value[?!isDeleted && status!=null && comments[0].commentType!='system'].status";
const RESOLVED = new Set(["fixed", "wontFix", "closed", "byDesign"]);
const THREAD_CONCURRENCY = 6;
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const FILTERS = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "review", label: "To review" },
  { key: "pending", label: "Pending" },
];
// Trim the payload: descriptions and links are large and unused.
const QUERY =
  "value[].{id:pullRequestId,title:title,draft:isDraft,created:creationDate,source:sourceRefName,target:targetRefName," +
  "merge:mergeStatus,repo:repository.name,repoId:repository.id,project:repository.project.name,author:createdBy.displayName," +
  "authorMail:createdBy.uniqueName,reviewers:reviewers[].{name:displayName,mail:uniqueName,vote:vote,group:isContainer,required:isRequired}}";
// The same fields for one PR from the by-id call, plus its status (active, completed, abandoned).
const ONE_QUERY = QUERY.replace(/^value\[\]\.\{/, "{status:status,");

const AZ = ["az", "/opt/homebrew/bin/az", "/usr/local/bin/az"];

async function az(args) {
  let last;
  for (const bin of AZ) {
    try {
      const r = await exec(bin, args);
      if (r.code !== 0 && r.code != null) throw new Error((r.stderr || "az failed").trim().split("\n").pop());
      return r.stdout;
    } catch (e) {
      last = e;
      if (!/not found|No such file|ENOENT|cannot start/i.test(String(e?.message ?? e))) throw e;
    }
  }
  throw last;
}

const branch = (ref) => (ref ?? "").replace(/^refs\/heads\//, "");
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default class AdoPrs extends View {
  init(_props, cx) {
    this.prs = null;
    this.error = null;
    this.loading = false;
    this.fetched = null;
    this.org = null;
    this.me = null;
    this.filter = localStorage.getItem("filter") ?? "all";
    this.folded = {};
    this.threads = {}; // pr id → { resolved, open }
    this.search = InputState.new({ placeholder: "Filter by title, repo, author, branch…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.lookup = null; // { id, loading } | { id, pr } | { id, error }
    this.idBox = InputState.new({ placeholder: "PR id ↵" });
    this.idBox.on("submit", (_e, cx) => this.find(cx));
    this.idBox.on("change", (_e, cx) => {
      if (!this.idBox.value().trim() && this.lookup) { this.lookup = null; cx.notify(); }
    });
    // The review view, when open: replaces the list.
    this.review = null;
    const want = _props?.review ?? props()?.review;
    if (want?.repoId && want?.id) this.openReview(want, cx);
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  openReview({ project, repoId, id, file }, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.ensureOrg();
        this.review?.dispose();
        this.review = new Review(this.reviewHost(), { project, repoId, id, file }, cx);
      } catch (e) {
        notify({ title: "Couldn't open pull request", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  reviewHost() {
    const self = this;
    return {
      get org() { return self.org; },
      back(cx) { self.review = null; cx.notify(); },
      notify: (msg) => notify({ title: "Pull request", body: msg, level: "error" }),
      chrome: (t) => (props()?.overlay ? [this.iconButton(t, "rv-close", "mods/ado-prs/x.svg", "Close", () => this.dismiss())] : []),
    };
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.ensureOrg();
        if (!this.me) this.me = (await az(["account", "show", "--query", "user.name", "-o", "tsv"])).trim().toLowerCase();
        const url = `https://dev.azure.com/${this.org}/_apis/git/pullrequests?searchCriteria.status=active&$top=1000&api-version=7.1`;
        const out = await az(["rest", "--resource", ADO_RESOURCE, "-u", url, "--query", QUERY, "-o", "json"]);
        const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
        this.prs = (JSON.parse(out) ?? []).filter((pr) => Date.parse(pr.created) >= cutoff);
        this.fetched = Date.now();
        this.error = null;
        cx.notify();
        await this.loadThreads(cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // ado.org from addons.json, else the az devops default.
  async ensureOrg() {
    if (!this.org) this.org = (await addonSettings()).ado?.org || null;
    if (this.org) return;
    const cfg = await az(["devops", "configure", "-l"]);
    const m = cfg.match(/organization\s*=\s*(\S+)/);
    if (!m) throw new Error("no org: set ado.org in addons.json or run az devops configure -d organization=…");
    this.org = m[1].replace(/\/+$/, "").split("/").pop();
  }

  // Look up one PR by id: from the loaded list when it's there, else from ADO
  // (any project, any status, any age).
  find(cx) {
    const raw = this.idBox.value().trim().replace(/^[!#]/, "");
    if (!raw) { this.lookup = null; cx.notify(); return; }
    if (!/^\d+$/.test(raw)) { this.lookup = { id: raw, error: "Enter a numeric pull request id" }; cx.notify(); return; }
    const id = Number(raw);
    const known = (this.prs ?? []).find((pr) => pr.id === id);
    if (known) { this.lookup = { id, pr: { ...known, status: "active" } }; this.openReview(known, cx); return; }
    this.lookup = { id, loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.ensureOrg();
        const url = `https://dev.azure.com/${this.org}/_apis/git/pullrequests/${id}?api-version=7.1`;
        const pr = JSON.parse(await az(["rest", "--resource", ADO_RESOURCE, "-u", url, "--query", ONE_QUERY, "-o", "json"]));
        if (this.lookup?.id === id) this.lookup = { id, pr };
        if (pr && this.lookup?.id === id) this.openReview(pr, cx);
        if (pr && !(id in this.threads)) this.loadThreads(cx, [pr]);
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (this.lookup?.id === id) {
          this.lookup = { id, error: /TF401180|404|Not Found|does not exist/i.test(msg) ? `!${id} doesn't exist, or you can't read it` : msg };
        }
      } finally {
        cx.notify();
      }
    });
  }

  // Resolved vs unresolved comment threads, a few PRs at a time; rows fill in as they arrive.
  async loadThreads(cx, prs = this.prs) {
    const queue = [...(prs ?? [])];
    const worker = async () => {
      for (let pr; (pr = queue.shift()); ) {
        const url = `https://dev.azure.com/${this.org}/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repoId}/pullRequests/${pr.id}/threads?api-version=7.1`;
        try {
          const states = JSON.parse(await az(["rest", "--resource", ADO_RESOURCE, "-u", url, "--query", THREAD_QUERY, "-o", "json"])) ?? [];
          const resolved = states.filter((s) => RESOLVED.has(s)).length;
          this.threads[pr.id] = { resolved, open: states.length - resolved };
        } catch (e) {
          this.threads[pr.id] = { error: String(e?.message ?? e) };
        }
        cx.notify();
      }
    };
    await Promise.all(Array.from({ length: THREAD_CONCURRENCY }, worker));
  }

  // ● unresolved · ✓ resolved
  comments(t, pr, key = "pr") {
    const c = this.threads[pr.id];
    const box = h_flex().id(`c-${key}-${pr.id}`).flex_none().w(64).gap(6).text_size(11.5);
    if (!c) return box.child(div().text_color(t.dim).child("…"));
    if (c.error) return box.tooltip(`Couldn't load comments: ${c.error}`).child(div().text_color(t.blocked).child("!"));
    if (!c.open && !c.resolved) return box.tooltip("No comments").child(div().text_color(t.dim).child("—"));
    return box.tooltip(`${c.open} unresolved · ${c.resolved} resolved`)
      .when(c.open > 0, (el) => el.child(div().text_color(t.done).child(`●${c.open}`)))
      .when(c.resolved > 0, (el) => el.child(div().text_color(t.working).child(`✓${c.resolved}`)));
  }

  // The host is closing this copy: write any pending comment draft now.
  async close() {
    if (this.review) await this.review.drafts.flush().catch(() => {});
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  url(pr) {
    const enc = encodeURIComponent;
    return `https://dev.azure.com/${this.org}/${enc(pr.project)}/_git/${enc(pr.repo)}/pullrequest/${pr.id}`;
  }

  open(pr) {
    exec("open", [this.url(pr)]).catch((e) => notify({ title: "Couldn't open PR", body: String(e?.message ?? e), level: "error" }));
  }

  // A new tab with Claude Code reviewing this one PR via the reviewing-ado-open-prs skill.
  async claudeReview(pr) {
    const task = [
      `Use the reviewing-ado-open-prs skill to review this one pull request (skip building the queue; review only this PR):`,
      `Org https://dev.azure.com/${this.org}, project ${pr.project}. PR ${pr.id}, repo ${pr.repo}, "${pr.title}".`,
      `Source ${branch(pr.source)} -> target ${branch(pr.target)}. Author ${pr.author ?? "?"}.`,
      this.url(pr),
    ].join("\n");
    try {
      run("tab.new", { name: `Review !${pr.id}`, folder: await claudeFolder(), argv: ["claude", "--model", await claudeModel("review")], task });
      this.dismiss();
    } catch (e) {
      notify({ title: "Couldn't start review", body: String(e?.message ?? e), level: "error" });
    }
  }

  // Slack mrkdwn: bold title, details line, bare link so it unfurls.
  slackText(pr) {
    const lines = [
      `*PR !${pr.id}: ${pr.title}*${pr.draft ? " _(draft)_" : ""}`,
      `\`${pr.repo}\` · \`${branch(pr.source)}\` → \`${branch(pr.target)}\` · by ${pr.author ?? "?"}`,
      this.url(pr),
    ];
    return lines.join("\n");
  }

  mine(pr) {
    return (pr.authorMail ?? "").toLowerCase() === this.me;
  }
  // Directly assigned to me and I haven't approved/rejected yet.
  toReview(pr) {
    if (this.mine(pr)) return false;
    const r = (pr.reviewers ?? []).find((x) => (x.mail ?? "").toLowerCase() === this.me);
    return Boolean(r) && (r.vote === 0 || r.vote === -5);
  }
  // Not a draft and no reviewer has voted yet: no approvals, no feedback.
  pending(pr) {
    return !pr.draft && (pr.reviewers ?? []).every((r) => !r.vote);
  }

  visible() {
    const q = this.search.value().trim().toLowerCase();
    return (this.prs ?? []).filter((pr) => {
      if (this.filter === "mine" && !this.mine(pr)) return false;
      if (this.filter === "review" && !this.toReview(pr)) return false;
      if (this.filter === "pending" && !this.pending(pr)) return false;
      if (!q) return true;
      return [pr.title, pr.repo, pr.project, pr.author, branch(pr.source), String(pr.id)].some((s) => (s ?? "").toLowerCase().includes(q));
    });
  }

  // ---- pieces

  pill(t, id, label, active, onClick) {
    return div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  iconButton(t, id, icon, tip, onClick, spin = false) {
    let ic = svg(icon).size(14).text_color(t.muted);
    if (spin) ic = ic.spin(900);
    return div().id(id).p(5).rounded(6).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(ic);
  }

  badge(t, text, color) {
    return div().flex_none().px(6).rounded(4).text_size(10.5).font_semibold()
      .text_color(color).border(1).border_color(color).child(text);
  }

  // ✓ approved · ~ with suggestions · … waiting · ✗ rejected · ○ no vote
  votes(t, pr, key = "pr") {
    const people = (pr.reviewers ?? []).filter((r) => !r.group || r.vote !== 0);
    const count = (f) => people.filter(f).length;
    const parts = [
      [count((r) => r.vote === 10), "✓", t.working],
      [count((r) => r.vote === 5), "~", t.working],
      [count((r) => r.vote === -5), "…", t.done],
      [count((r) => r.vote === -10), "✗", t.blocked],
      [count((r) => r.vote === 0), "○", t.dim],
    ].filter((p) => p[0] > 0);
    const tip = people.length
      ? people.map((r) => `${({ 10: "✓", 5: "~", "-5": "…", "-10": "✗" })[r.vote] ?? "○"} ${r.name.replace(/^\[.*?\]\\/, "")}${r.required ? " (required)" : ""}`).join("\n")
      : "No reviewers";
    return h_flex().id(`v-${key}-${pr.id}`).flex_none().gap(6).text_size(11.5).tooltip(tip).children(
      parts.length ? parts.map(([n, g, c]) => div().text_color(c).child(`${g}${n}`)) : [div().text_color(t.dim).child("—")],
    );
  }

  row(t, pr, key = "pr") {
    const review = this.toReview(pr);
    const conflict = pr.merge === "conflicts" && (pr.status ?? "active") === "active";
    const closed = pr.status && pr.status !== "active" ? String(pr.status).toUpperCase() : null;
    return h_flex().id(`${key}-${pr.id}`).px(12).py(7).gap(12).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openReview(pr, cx))
      .child(div().flex_none().w(3).h(30).rounded(2).bg(review ? t.accent : this.mine(pr) ? t.done : "#00000000"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center().min_w(0)
          .when(Boolean(closed), (el) => el.child(this.badge(t, closed, pr.status === "completed" ? t.working : t.dim)))
          .when(pr.draft, (el) => el.child(this.badge(t, "DRAFT", t.dim)))
          .when(conflict, (el) => el.child(this.badge(t, "CONFLICT", t.blocked)))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(pr.draft ? t.muted : t.foreground).child(pr.title)))
        .child(div().truncate().text_size(11.5).text_color(t.dim)
          .child(`${pr.repo} · !${pr.id} · ${branch(pr.source)} → ${branch(pr.target)}`)))
      .child(div().flex_none().w(140).truncate().text_size(12).text_color(t.muted).child(pr.author ?? ""))
      .child(div().flex_none().w(90).child(this.votes(t, pr, key)))
      .child(this.comments(t, pr, key))
      .child(div().flex_none().w(32).text_size(11.5).text_color(t.dim).child(ago(pr.created)))
      .child(h_flex().flex_none().gap(2)
        .child(this.action(t, `rv-${key}-${pr.id}`, "review.svg", "Review with Claude Code", () => this.claudeReview(pr)))
        .child(this.action(t, `sl-${key}-${pr.id}`, "slack.svg", "Copy Slack message", (cx) => {
          cx.write_to_clipboard(this.slackText(pr));
          notify({ title: "Slack message copied", body: `!${pr.id} ${pr.title}`, level: "info", timeout: 2000 });
        }))
        .child(this.action(t, `op-${key}-${pr.id}`, "external.svg", "Open in browser", () => this.open(pr))));
  }

  action(t, id, icon, tip, fn) {
    return div().id(id).p(5).rounded(6).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(`mods/ado-prs/${icon}`).size(14).text_color(t.muted));
  }

  header(t, shown) {
    const total = this.prs?.length ?? 0;
    const counts = { all: total, mine: (this.prs ?? []).filter((p) => this.mine(p)).length, review: (this.prs ?? []).filter((p) => this.toReview(p)).length, pending: (this.prs ?? []).filter((p) => this.pending(p)).length };
    const status = this.error ? "fetch failed" : this.loading ? "loading…" : this.fetched ? `updated ${ago(new Date(this.fetched).toISOString())} ago` : "";
    return h_flex().flex_none().px(16).py(10).gap(12).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/ado-prs/pr.svg").size(16).text_color(t.accent))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Pull requests"))
        .child(div().text_size(12).text_color(t.dim).child(this.org ? `${this.org} · ${shown}/${total} · last ${MAX_AGE_DAYS}d` : "")))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
        FILTERS.map((f) => this.pill(t, `f-${f.key}`, `${f.label} ${counts[f.key]}`, this.filter === f.key, (_e, cx) => {
          this.filter = f.key;
          localStorage.setItem("filter", f.key);
          cx.notify();
        }))))
      .child(h_flex().flex_1().min_w(180).h(26).px(8).rounded(6).bg(t.background).border(1).border_color(t.input)
        .child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().id("id-box").flex_none().w(130).h(26).px(8).gap(6).items_center().rounded(6).bg(t.background).border(1)
        .border_color(this.lookup ? t.accent : t.input).tooltip("Look up any pull request by id (Enter)")
        .child(svg("mods/ado-prs/hash.svg").size(12).flex_none().text_color(t.dim))
        .child(Input.new(this.idBox).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).child(status))
      .child(this.iconButton(t, "refresh", "mods/ado-prs/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx), this.loading))
      .when(Boolean(props()?.overlay), (el) => el
        .child(this.iconButton(t, "as-pane", "mods/ado-prs/panel-right.svg", "Open beside this pane", () => {
          this.dismiss();
          run("pane.split", { direction: "right", mod: "ado-prs" });
        }))
        .child(this.iconButton(t, "close", "mods/ado-prs/x.svg", "Close", () => this.dismiss())));
  }

  // The id lookup's result, pinned above the list.
  lookupCard(t) {
    const l = this.lookup;
    const close = this.iconButton(t, "lookup-x", "mods/ado-prs/x.svg", "Clear lookup", (_e, cx) => {
      this.lookup = null;
      this.idBox.set_value("");
      cx.notify();
    });
    const body = l.pr ? this.row(t, l.pr, "lk")
      : div().px(12).py(9).text_size(12).text_color(l.error ? t.blocked : t.dim).child(l.error ?? `Looking up !${l.id}…`);
    return v_flex().flex_none().mx(8).mt(8).p(4).rounded(8).border(1).border_color(t.border).bg(t.raised)
      .child(h_flex().px(8).pt(2).items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(l.pr ? `${l.pr.project} · !${l.id}` : `PR !${l.id}`))
        .child(close))
      .child(body);
  }

  body(t, list) {
    if (this.error && !this.prs) {
      return v_flex().flex_1().items_center().justify_center().gap(6).p(24)
        .child(div().text_size(13).text_color(t.blocked).child("Couldn't load pull requests"))
        .child(div().text_size(12).text_color(t.muted).child(this.error))
        .child(div().text_size(12).text_color(t.dim).child("Try `az login` in a terminal, then refresh."));
    }
    if (!this.prs) return v_flex().flex_1().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("Loading…"));
    if (!list.length) return v_flex().flex_1().items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("No active pull requests match."));

    const groups = new Map();
    for (const pr of list) {
      if (!groups.has(pr.project)) groups.set(pr.project, []);
      groups.get(pr.project).push(pr);
    }
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    return div().id("list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().p(8).gap(6).children(
      sorted.map(([project, prs]) => {
        prs.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
        const folded = this.folded[project];
        return v_flex().flex_none().gap(1)
          .child(h_flex().id(`g-${project}`).px(8).py(4).gap(8).items_center().rounded(6).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.folded[project] = !folded; cx.notify(); })
            .child(svg(folded ? "mods/ado-prs/chev-right.svg" : "mods/ado-prs/chev-down.svg").size(12).text_color(t.dim))
            .child(div().text_size(12).font_semibold().text_color(t.muted).child(project))
            .child(div().text_size(11).text_color(t.dim).child(String(prs.length))))
          .when(!folded, (el) => el.children(prs.map((pr) => this.row(t, pr))));
      }),
    ));
  }

  render() {
    const t = theme();
    if (this.review) {
      return v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).child(this.review.render(t));
    }
    const list = this.visible();
    return v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground)
      .child(this.header(t, list.length))
      .when(Boolean(this.lookup), (el) => el.child(this.lookupCard(t)))
      .child(this.body(t, list));
  }
}
