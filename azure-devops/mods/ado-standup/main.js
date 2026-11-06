// Standup: one ADO team's morning standup on one screen.
//   Completed      items closed or moved to QA in the window, by person, plus a
//                  14-day throughput chart
//   Needs review   the team's active PRs not yet approved
//   New work       items created in the team's area in the window, by type
//   Impediments    blocking tags, stale in-progress items, stuck PRs, failing
//                  main/master pipelines
//   Builds         failed runs in the window, by pipeline
//   Production     deployments to production environments and what they shipped
// Filters: team, window (since the last workday … 14 days), person. Data comes
// from standup.py (az login); window and person filter locally.
//
// Opens as a dialog (mod.open:ado-standup), or as a pane beside a shell.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, closeOverlay, run, notify, appHome } from "herdr";
import { readFile } from "fs/promises";

// Settings from addons.json in the herdr-app folder (see the herdr-addons
// README). Read on each use, so edits apply without reloading the mod.
async function addonSettings() {
  try {
    return JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8")) ?? {};
  } catch {
    return {};
  }
}

// ado.standup in addons.json: { "project": "…" (required), "team": "…" (the
// first team shown; the picker remembers later choices) }, plus ado.org.
const REFRESH_MS = 300000;
const STALE_DAYS = 3; // in progress with no change this long
const PR_STUCK_DAYS = 5; // open this long with no votes
// Tags that mark an impediment; ado.standup.blockTags in addons.json overrides.
const DEFAULT_BLOCK_TAGS = ["Blocked", "Impediment", "external-dependency"];
let BLOCK_TAGS = DEFAULT_BLOCK_TAGS.map((t) => t.toLowerCase());
const DAY = 86400000;
const ICON = (n) => `mods/ado-standup/${n}.svg`;

// Dark-surface categorical slots and the reserved status steps (validated against
// the catppuccin surface with the dataviz validator: all six checks pass).
const C = { blue: "#3987e5", orange: "#d95926", aqua: "#199e70", yellow: "#c98500", magenta: "#d55181", violet: "#9085e9" };
const S = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };

// ---- time

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
// The previous workday's midnight: Monday (and the weekend) look back to Friday.
function lastWorkday(now = new Date()) {
  const d = startOfDay(now);
  const back = { 0: 2, 1: 3, 6: 1 }[d.getDay()] ?? 1;
  d.setDate(d.getDate() - back);
  return d;
}
const DAYNAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function windows() {
  const lw = lastWorkday();
  const yesterday = startOfDay(Date.now() - DAY).getTime() === lw.getTime();
  return [
    { key: "lastday", label: yesterday ? "Since yesterday" : `Since ${DAYNAME[lw.getDay()]}`, since: lw.getTime() },
    { key: "3d", label: "3 days", since: startOfDay(Date.now() - 2 * DAY).getTime() },
    { key: "7d", label: "7 days", since: startOfDay(Date.now() - 6 * DAY).getTime() },
    { key: "14d", label: "14 days", since: startOfDay(Date.now() - 13 * DAY).getTime() },
  ];
}
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
function ago(iso) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
// When an item was finished: closed for Completed, resolved (moved to QA) for Resolved.
// StateChangeDate is often empty on this board, so it is only the fallback.
const doneAt = (w) => (w.category === "Completed" ? w.closed : w.resolved) ?? w.stateChanged ?? w.changed;
const ageDays = (iso) => (Date.now() - ms(iso)) / DAY;
function when(iso) {
  const d = new Date(ms(iso));
  const today = startOfDay(Date.now()).getTime();
  const day = startOfDay(d).getTime();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (day === today) return `today ${hm}`;
  if (day === today - DAY) return `yesterday ${hm}`;
  return `${DAYNAME[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}
const first = (name) => String(name ?? "?").split(/\s+/)[0];
const lc = (s) => String(s ?? "").toLowerCase();

export default class Standup extends View {
  init(_props, cx) {
    this.team = localStorage.getItem("team");
    this.win = localStorage.getItem("win") ?? "lastday";
    this.who = null; // a member's mail, or null for everyone
    this.prBuilds = false; // include PR validation runs in build failures
    this.open = {}; // expanded rows
    this.data = null;
    this.error = null;
    this.loading = false;
    this.load(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.load(cx));
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    let team = this.team;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const s = await addonSettings();
        const project = s.ado?.standup?.project;
        if (!project) throw new Error("Set ado.standup.project (and ado.standup.team) in addons.json");
        if (!team) team = this.team = s.ado?.standup?.team || null;
        if (!team) throw new Error("Set ado.standup.team in addons.json");
        const tags = Array.isArray(s.ado?.standup?.blockTags) ? s.ado.standup.blockTags.map(String) : DEFAULT_BLOCK_TAGS;
        BLOCK_TAGS = tags.map((t) => t.toLowerCase());
        const script = `${appHome()}/mods/ado-standup/standup.py`;
        const r = await exec("python3", ["-I", script, "--team", team, "--project", String(project), ...(s.ado?.org ? ["--org", String(s.ado.org)] : []), "--block-tags", JSON.stringify(tags)]);
        const out = r.stdout ?? "";
        const i = out.indexOf("@@ADO-STANDUP@@\n");
        if (i < 0) throw new Error((r.stderr || "standup.py printed nothing").trim().split("\n").pop());
        const d = JSON.parse(out.slice(i + 16));
        if (d.fatal) throw new Error(d.fatal);
        if (team !== this.team) return; // switched while loading
        this.data = d;
        this.error = null;
        if (this.who && !(d.members ?? []).some((m) => m.mail === this.who)) this.who = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
        if (team !== this.team) this.load(cx);
      }
    });
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  browse(url) {
    if (url) exec("open", [url]).catch((e) => notify({ title: "Couldn't open", body: String(e?.message ?? e), level: "error" }));
  }

  // ---- derived

  since() {
    return (windows().find((w) => w.key === this.win) ?? windows()[0]).since;
  }

  // Does this person (mail) match the person filter?
  is(p) {
    return !this.who || lc(p?.mail) === this.who;
  }

  model() {
    const d = this.data;
    const since = this.since();
    const inWin = (iso) => ms(iso) >= since;
    const items = d.workitems?.items ?? [];
    const done = (w) => w.category === "Completed" || w.category === "Resolved";
    const completed = items.filter((w) => done(w) && inWin(doneAt(w)) && this.is(w.assigned))
      .sort((a, b) => ms(doneAt(b)) - ms(doneAt(a)));
    const created = items.filter((w) => inWin(w.created) && (this.is(w.createdBy) || this.is(w.assigned)))
      .sort((a, b) => ms(b.created) - ms(a.created));

    const members = new Set((d.members ?? []).map((m) => m.mail));
    const votesOf = (pr) => pr.reviewers.filter((r) => !r.group || r.vote !== 0);
    const approved = (pr) => pr.reviewers.some((r) => r.vote >= 5);
    const prs = (d.prs ?? []).filter((pr) => !pr.draft);
    const review = prs.filter((pr) => !approved(pr) && (this.is(pr.author) || pr.reviewers.some((r) => this.is(r))))
      .sort((a, b) => ms(a.created) - ms(b.created));

    // Impediments: four rules, each row says which one flagged it.
    const imp = [];
    const openItem = (w) => w.category !== "Completed" && w.category !== "Removed";
    for (const w of items) {
      if (!this.is(w.assigned) || !openItem(w)) continue;
      const tag = w.tags.find((t) => BLOCK_TAGS.includes(lc(t)));
      if (tag) imp.push({ kind: "tag", key: `t-${w.id}`, title: w.title, sub: `#${w.id} · ${w.type} · ${w.state} · ${w.assigned?.name ?? "unassigned"}`, why: `tagged ${tag}`, url: w.url, sev: S.serious, at: w.changed });
      else if ((w.category === "InProgress" || w.category === "Resolved") && ageDays(w.changed) >= STALE_DAYS) {
        imp.push({ kind: "stale", key: `s-${w.id}`, title: w.title, sub: `#${w.id} · ${w.type} · ${w.state} · ${w.assigned?.name ?? "unassigned"}`, why: `no change in ${Math.floor(ageDays(w.changed))}d`, url: w.url, sev: S.warning, at: w.changed });
      }
    }
    for (const pr of prs) {
      if (!(this.is(pr.author) || pr.reviewers.some((r) => this.is(r)))) continue;
      const rej = pr.reviewers.find((r) => r.vote === -10), wait = pr.reviewers.find((r) => r.vote === -5);
      const why = rej ? `rejected by ${first(rej.name)}` : wait ? `waiting for author (${first(wait.name)})`
        : !votesOf(pr).some((r) => r.vote !== 0) && ageDays(pr.created) >= PR_STUCK_DAYS ? `open ${Math.floor(ageDays(pr.created))}d, no votes` : null;
      if (why) imp.push({ kind: "pr", key: `p-${pr.id}`, title: pr.title, sub: `!${pr.id} · ${pr.repo} · ${pr.author?.name}`, why, url: pr.url, sev: rej ? S.critical : S.warning, at: pr.created });
    }
    for (const b of d.builds?.latestMain ?? []) {
      if (b.result !== "failed" && b.result !== "partiallySucceeded") continue;
      if (!this.is(b.by)) continue;
      imp.push({ kind: "build", key: `b-${b.id}`, title: `${b.pipeline} is ${b.result === "failed" ? "failing" : "partially failing"} on ${b.branch}`, sub: `#${b.number} · ${b.by?.name ?? ""} · ${when(b.finished)}`, why: "latest main run", url: b.url, sev: b.result === "failed" ? S.critical : S.serious, at: b.finished });
    }
    const rank = { build: 0, pr: 1, tag: 2, stale: 3 };
    imp.sort((a, b) => rank[a.kind] - rank[b.kind] || ms(a.at) - ms(b.at));

    const failed = (d.builds?.failed ?? []).filter((b) => inWin(b.finished) && this.is(b.by) && (this.prBuilds || b.reason !== "pullRequest"))
      .sort((a, b) => ms(b.finished) - ms(a.finished));
    const prFailed = (d.builds?.failed ?? []).filter((b) => inWin(b.finished) && this.is(b.by) && b.reason === "pullRequest").length;
    const deploys = (d.deploys?.rows ?? []).filter((r) => inWin(r.finished) && (this.is(r.by) || (r.workitems ?? []).some((w) => this.is(w.assigned))));
    return { since, completed, created, review, imp, failed, prFailed, deploys, members, items, done };
  }

  // ---- pieces

  pill(t, id, label, active, onClick) {
    return div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer().flex_none()
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
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(ic);
  }

  card(t, id, title, count, body, right = null) {
    return v_flex().id(id).flex_1().min_w(0).rounded(10).border(1).border_color(t.border).bg(t.background)
      .child(h_flex().px(14).pt(12).pb(8).gap(8).items_center()
        .child(div().text_size(13).font_semibold().child(title))
        .when(count != null, (el) => el.child(div().px(6).rounded(8).bg(t.selected).text_size(11).text_color(t.muted).child(String(count))))
        .child(div().flex_1())
        .when(Boolean(right), (el) => el.child(right)))
      .child(v_flex().px(14).pb(12).gap(2).child(body));
  }

  empty(t, text) {
    return div().py(6).text_size(12).text_color(t.dim).child(text);
  }

  legend(t, entries) {
    return h_flex().gap(12).items_center().children(entries.map(([label, color]) =>
      h_flex().gap(5).items_center().child(div().size(8).rounded(2).bg(color)).child(div().text_size(11).text_color(t.muted).child(label))));
  }

  // A horizontal bar chart: rows [{key, label, segs: [{n, color, tip}]}], one shared scale.
  hbars(t, id, rows, { labelW = 120 } = {}) {
    const max = Math.max(1, ...rows.map((r) => r.segs.reduce((a, s) => a + s.n, 0)));
    return v_flex().gap(5).children(rows.map((r) => {
      const total = r.segs.reduce((a, s) => a + s.n, 0);
      const segs = r.segs.filter((s) => s.n > 0);
      return h_flex().id(`${id}-${r.key}`).gap(8).items_center().h(18)
        .when(Boolean(r.onClick), (el) => el.cursor_pointer().on_click(r.onClick))
        .child(div().flex_none().w(labelW).truncate().text_size(11.5).text_color(r.active ? t.foreground : t.muted).text_right().child(r.label))
        .child(h_flex().flex_1().min_w(0).h(12).gap(2)
          .child(h_flex().h_full().gap(2).w(`${(100 * total) / max}%`).children(segs.map((s, i) =>
            div().id(`${id}-${r.key}-${i}`).h_full().flex_grow(s.n).flex_basis(0)
              .rounded_l(i === 0 ? 2 : 0).rounded_r(i === segs.length - 1 ? 4 : 0)
              .bg(s.color).tooltip(s.tip ?? `${s.n}`)))))
        .child(div().flex_none().w(24).text_size(11.5).text_color(t.foreground).child(String(total)));
    }));
  }

  // Completed per day for the last 14 days, the window's days lit.
  throughput(t, m) {
    const today = startOfDay(Date.now()).getTime();
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(today - i * DAY);
    const per = days.map((d) => {
      const inDay = (w) => { const x = ms(doneAt(w)); return x >= d && x < d + DAY; };
      const mine = m.items.filter((w) => m.done(w) && inDay(w) && this.is(w.assigned));
      return { d, closed: mine.filter((w) => w.category === "Completed").length, qa: mine.filter((w) => w.category === "Resolved").length };
    });
    const max = Math.max(1, ...per.map((p) => p.closed + p.qa));
    const H = 96;
    return v_flex().gap(6)
      .child(h_flex().h(H).gap(4).items_end().children(per.map((p, i) => {
        const lit = p.d >= m.since;
        const total = p.closed + p.qa;
        const day = new Date(p.d);
        return v_flex().id(`tp-${i}`).flex_1().min_w(0).h_full().justify_end().gap(2)
          .tooltip(`${DAYNAME[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}: ${p.closed} closed, ${p.qa} to QA`)
          .when(total > 0, (el) => el
            .when(p.qa > 0, (e) => e.child(div().w_full().h(Math.max(2, (H - 4) * p.qa / max)).rounded_t(4).bg(C.aqua).opacity(lit ? 1 : 0.4)))
            .when(p.closed > 0, (e) => e.child(div().w_full().h(Math.max(2, (H - 4) * p.closed / max)).rounded_t(p.qa > 0 ? 0 : 4).bg(C.blue).opacity(lit ? 1 : 0.4))))
          .when(total === 0, (el) => el.child(div().w_full().h(1).bg(t.border)));
      })))
      .child(h_flex().gap(4).children(per.map((p, i) => {
        const day = new Date(p.d);
        return div().flex_1().min_w(0).text_size(10).text_color(p.d >= m.since ? t.muted : t.dim).text_center()
          .child(day.getDay() === 1 || i === 13 || i === 0 ? `${DAYNAME[day.getDay()][0]} ${day.getDate()}` : DAYNAME[day.getDay()][0]);
      })));
  }

  // A clickable list row: colored lead bar, title, sub line, right text.
  row(t, id, { title, sub, right, rightColor, lead, url, extra = null, onClick = null }) {
    return v_flex().id(id).px(8).py(5).gap(1).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick ?? (() => this.browse(url)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().w(3).h(26).rounded(2).bg(lead ?? t.border))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).child(title ?? ""))
          .child(div().truncate().text_size(11).text_color(t.dim).child(sub ?? "")))
        .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11.5).text_color(rightColor ?? t.muted).child(right))))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  // ---- sections

  tiles(t, m) {
    const tiles = [
      ["Completed", m.completed.filter((w) => w.category === "Completed").length, "closed"],
      ["To QA", m.completed.filter((w) => w.category === "Resolved").length, "ready for QA"],
      ["Needs review", m.review.length, "PRs not approved"],
      ["New work", m.created.length, "items created"],
      ["Impediments", m.imp.length, "blockers"],
      ["Failed builds", m.failed.length, this.prBuilds ? "incl. PR builds" : "excl. PR builds"],
      ["To production", m.deploys.length, "deployments"],
    ];
    return h_flex().gap(10).flex_wrap().children(tiles.map(([label, n, sub], i) =>
      v_flex().id(`tile-${i}`).flex_1().min_w(120).px(14).py(10).rounded(10).border(1).border_color(t.border).bg(t.background)
        .child(div().text_size(11).text_color(t.muted).child(label))
        .child(div().text_size(26).font_semibold().text_color(label === "Impediments" && n > 0 ? S.serious : t.foreground).child(String(n)))
        .child(div().text_size(10.5).text_color(t.dim).child(sub))));
  }

  completedCard(t, m) {
    const d = this.data;
    const people = new Map();
    for (const w of m.completed) {
      const k = lc(w.assigned?.mail) || "unassigned";
      const p = people.get(k) ?? { name: w.assigned?.name ?? "Unassigned", mail: k, closed: 0, qa: 0 };
      if (w.category === "Completed") p.closed++; else p.qa++;
      people.set(k, p);
    }
    const rows = [...people.values()].sort((a, b) => b.closed + b.qa - (a.closed + a.qa)).map((p) => ({
      key: p.mail.replace(/[^a-z0-9]/g, ""), label: p.name, active: this.who === p.mail,
      segs: [{ n: p.closed, color: C.blue, tip: `${p.name}: ${p.closed} closed` }, { n: p.qa, color: C.aqua, tip: `${p.name}: ${p.qa} moved to QA` }],
      onClick: (_e, cx) => { if ((d.members ?? []).some((x) => x.mail === p.mail)) { this.who = this.who === p.mail ? null : p.mail; cx.notify(); } },
    }));
    const key = "completed";
    const shown = this.open[key] ? m.completed : m.completed.slice(0, 8);
    return this.card(t, "c-completed", "Completed", m.completed.length,
      v_flex().gap(10)
        .child(this.legend(t, [["Closed", C.blue], ["Moved to QA", C.aqua]]))
        .child(rows.length ? this.hbars(t, "cb", rows) : this.empty(t, "Nothing completed in this window."))
        .child(div().h(1).bg(t.border))
        .child(div().text_size(11).text_color(t.dim).child("Last 14 days"))
        .child(this.throughput(t, m))
        .child(div().h(1).bg(t.border))
        .child(v_flex().children(shown.map((w) => this.row(t, `cw-${w.id}`, {
          title: w.title, sub: `#${w.id} · ${w.type} · ${w.assigned?.name ?? "unassigned"}`,
          right: `${w.category === "Completed" ? "closed" : w.state} ${ago(doneAt(w))}`,
          lead: w.category === "Completed" ? C.blue : C.aqua, url: w.url,
        }))))
        .when(m.completed.length > 8, (el) => el.child(this.more(t, key, m.completed.length))));
  }

  more(t, key, n) {
    return div().id(`more-${key}`).px(8).py(4).text_size(11.5).text_color(t.accent).cursor_pointer()
      .on_click((_e, cx) => { this.open[key] = !this.open[key]; cx.notify(); })
      .child(this.open[key] ? "Show fewer" : `Show all ${n}`);
  }

  reviewCard(t, m) {
    const max = Math.max(1, ...m.review.map((pr) => ageDays(pr.created)));
    const vote = (pr) => {
      const v = pr.reviewers.filter((r) => !r.group || r.vote !== 0);
      const n = (x) => v.filter((r) => r.vote === x).length;
      return [n(-10) ? `✗${n(-10)}` : "", n(-5) ? `…${n(-5)}` : "", n(0) ? `○${n(0)}` : ""].filter(Boolean).join(" ");
    };
    return this.card(t, "c-review", "PRs needing review", m.review.length,
      m.review.length ? v_flex().children(m.review.map((pr) => {
        const age = ageDays(pr.created);
        return this.row(t, `pr-${pr.id}`, {
          title: pr.title, sub: `!${pr.id} · ${pr.repo} · ${pr.author?.name ?? ""}${pr.open ? ` · ${pr.open} open comment${pr.open > 1 ? "s" : ""}` : ""}${vote(pr) ? ` · ${vote(pr)}` : ""}`,
          right: ago(pr.created), rightColor: age >= PR_STUCK_DAYS ? S.warning : t.muted,
          lead: pr.reviewers.some((r) => r.vote === -10) ? S.critical : pr.reviewers.some((r) => r.vote === -5) ? S.warning : C.violet, url: pr.url,
          extra: h_flex().pl(11).h(4).child(div().id(`pa-${pr.id}`).h_full().rounded_r(4).bg(age >= PR_STUCK_DAYS ? S.warning : C.violet).opacity(0.7)
            .w(`${Math.max(2, (100 * age) / max)}%`).tooltip(`open ${Math.floor(age)}d ${Math.floor((age % 1) * 24)}h`)),
        });
      })) : this.empty(t, "Every open PR has an approval."));
  }

  newCard(t, m) {
    const by = new Map();
    for (const w of m.created) by.set(w.type, (by.get(w.type) ?? 0) + 1);
    const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ key: type.replace(/\W/g, ""), label: type, segs: [{ n, color: C.orange, tip: `${n} ${type}` }] }));
    const key = "new";
    const shown = this.open[key] ? m.created : m.created.slice(0, 8);
    return this.card(t, "c-new", "New work", m.created.length,
      v_flex().gap(10)
        .child(rows.length ? this.hbars(t, "nb", rows) : this.empty(t, "Nothing new in this window."))
        .when(m.created.length > 0, (el) => el.child(div().h(1).bg(t.border)))
        .child(v_flex().children(shown.map((w) => this.row(t, `nw-${w.id}`, {
          title: w.title, sub: `#${w.id} · ${w.type} · ${w.state} · by ${w.createdBy?.name ?? "?"}${w.assigned ? ` → ${first(w.assigned.name)}` : " · unassigned"}`,
          right: ago(w.created), lead: C.orange, url: w.url,
        }))))
        .when(m.created.length > 8, (el) => el.child(this.more(t, key, m.created.length))));
  }

  impCard(t, m) {
    const LABEL = { build: "Failing main builds", pr: "Stuck PRs", tag: "Blocking tags", stale: `Stale in progress (${STALE_DAYS}d+)` };
    const groups = ["build", "pr", "tag", "stale"].map((k) => [k, m.imp.filter((x) => x.kind === k)]).filter(([, xs]) => xs.length);
    return this.card(t, "c-imp", "Impediments", m.imp.length,
      groups.length ? v_flex().gap(6).children(groups.map(([k, xs]) => {
        const key = `imp-${k}`;
        const shown = this.open[key] ? xs : xs.slice(0, 6);
        return v_flex()
          .child(div().pt(4).pb(2).text_size(11).font_semibold().text_color(t.dim).child(`${LABEL[k].toUpperCase()}  ${xs.length}`))
          .children(shown.map((x) => this.row(t, `im-${x.key}`, { title: x.title, sub: x.sub, right: x.why, rightColor: t.muted, lead: x.sev, url: x.url })))
          .when(xs.length > 6, (el) => el.child(this.more(t, key, xs.length)));
      })) : this.empty(t, "No impediments. Nice."));
  }

  buildsCard(t, m) {
    const by = new Map();
    for (const b of m.failed) {
      const p = by.get(b.pipeline) ?? { failed: 0, partial: 0 };
      if (b.result === "failed") p.failed++; else p.partial++;
      by.set(b.pipeline, p);
    }
    const rows = [...by.entries()].sort((a, b) => b[1].failed + b[1].partial - (a[1].failed + a[1].partial)).slice(0, 10).map(([name, p]) => ({
      key: name.replace(/\W/g, ""), label: name,
      segs: [{ n: p.failed, color: S.critical, tip: `${name}: ${p.failed} failed` }, { n: p.partial, color: S.serious, tip: `${name}: ${p.partial} partially succeeded` }],
    }));
    const key = "builds";
    const shown = this.open[key] ? m.failed : m.failed.slice(0, 6);
    const toggle = this.pill(t, "pr-builds", this.prBuilds ? `PR builds ${m.prFailed} ✓` : `PR builds ${m.prFailed}`, this.prBuilds, (_e, cx) => { this.prBuilds = !this.prBuilds; cx.notify(); });
    return this.card(t, "c-builds", "Build failures", m.failed.length,
      v_flex().gap(10)
        .when(rows.length > 0, (el) => el.child(this.legend(t, [["✗ Failed", S.critical], ["! Partially succeeded", S.serious]])))
        .child(rows.length ? this.hbars(t, "bb", rows, { labelW: 170 }) : this.empty(t, "No failed runs in this window."))
        .when(m.failed.length > 0, (el) => el.child(div().h(1).bg(t.border)))
        .child(v_flex().children(shown.map((b) => this.row(t, `bf-${b.id}`, {
          title: `${b.result === "failed" ? "✗" : "!"} ${b.pipeline}`, sub: `#${b.number} · ${b.branch} · ${b.by?.name ?? ""}${b.reason === "pullRequest" ? " · PR build" : ""}`,
          right: when(b.finished), lead: b.result === "failed" ? S.critical : S.serious, url: b.url,
        }))))
        .when(m.failed.length > 6, (el) => el.child(this.more(t, key, m.failed.length))), toggle);
  }

  deploysCard(t, m) {
    // Timeline: one lane across the window, a tick per deployment.
    const start = m.since, end = Date.now();
    const span = Math.max(1, end - start);
    const days = [];
    for (let d = startOfDay(start).getTime(); d <= end; d += DAY) days.push(d);
    const lane = v_flex().gap(3)
      .child(div().relative().h(22).rounded(4).bg(t.surface)
        .children(days.slice(1).map((d, i) => div().absolute().top(0).bottom(0).w(1).bg(t.border).left(`${(100 * (d - start)) / span}%`)))
        .children(m.deploys.map((r, i) => div().id(`dt-${i}`).absolute().top(5).size(12).rounded_full().border(2).border_color(t.background)
          .bg(r.result === "succeeded" ? S.good : S.critical).left(`${Math.min(100, Math.max(0, (100 * (ms(r.finished) - start)) / span))}%`).ml(-6)
          .tooltip(`${r.env}: ${r.pipeline} #${r.number} · ${when(r.finished)} · ${r.result}`))))
      .child(h_flex().children(days.map((d, i) => div().flex_1().text_size(10).text_color(t.dim).child(i % Math.ceil(days.length / 8) === 0 ? `${DAYNAME[new Date(d).getDay()]} ${new Date(d).getDate()}` : ""))));
    return this.card(t, "c-deploys", "Promoted to production", m.deploys.length,
      v_flex().gap(10)
        .when(m.deploys.length > 0, (el) => el.child(this.legend(t, [["✓ Succeeded", S.good], ["✗ Failed", S.critical]])).child(lane))
        .child(m.deploys.length ? v_flex().children(m.deploys.map((r, i) => {
          const key = `dep-${i}`;
          const wi = (r.workitems ?? []).filter((w) => this.is(w.assigned) || !this.who);
          return this.row(t, `dp-${i}`, {
            title: `${r.result === "succeeded" ? "✓" : "✗"} ${r.pipeline} → ${r.env}`,
            sub: `#${r.number} · ${r.branch} · ${r.by?.name ?? ""} · ${(r.workitems ?? []).length ? `${(r.workitems ?? []).length} work item${(r.workitems ?? []).length > 1 ? "s" : ""}` : "no linked work items"}`,
            right: when(r.finished), lead: r.result === "succeeded" ? S.good : S.critical, url: r.url,
            onClick: wi.length ? (_e, cx) => { this.open[key] = !this.open[key]; cx.notify(); } : null,
            extra: this.open[key] && wi.length ? v_flex().pl(18).pt(4).gap(1).children(wi.map((w) => h_flex().id(`dw-${i}-${w.id}`).gap(6).cursor_pointer()
              .on_click((_e, cx) => { cx.stop_propagation(); this.browse(w.url); })
              .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${w.id}`))
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(w.title ?? ""))
              .child(div().flex_none().text_size(11).text_color(t.dim).child(first(w.assigned?.name ?? ""))))) : null,
          });
        })) : this.empty(t, "Nothing promoted to production in this window.")));
  }

  // ---- header and render

  header(t) {
    const d = this.data;
    const teams = d?.teams ?? (this.team ? [this.team] : []);
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().px(16).pt(10).pb(6).gap(12).items_center().flex_wrap()
        .child(h_flex().gap(8).items_center()
          .child(svg(ICON("standup")).size(16).text_color(t.accent))
          .child(div().text_size(14).font_semibold().child("Standup"))
          .child(div().text_size(12).text_color(t.dim).child(d ? `${d.project} · ${(d.areas ?? []).map((a) => a.path.split("\\").pop()).join(", ")}` : "")))
        .child(h_flex().gap(2).p(2).rounded(8).bg(t.background).children(teams.map((name) =>
          this.pill(t, `team-${name.replace(/\W/g, "")}`, name, name === this.team, (_e, cx) => {
            if (name === this.team) return;
            this.team = name; this.who = null; this.data = null;
            localStorage.setItem("team", name);
            this.load(cx);
          }))))
        .child(h_flex().gap(2).p(2).rounded(8).bg(t.background).children(windows().map((w) =>
          this.pill(t, `win-${w.key}`, w.label, w.key === this.win, (_e, cx) => { this.win = w.key; localStorage.setItem("win", w.key); cx.notify(); }))))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(this.error ? S.critical : t.dim)
          .child(this.error ? "refresh failed" : this.loading ? "loading…" : d ? `updated ${ago(new Date(d.generated * 1000).toISOString())} ago` : ""))
        .child(this.iconButton(t, "refresh", ICON("refresh"), "Refresh", (cx) => this.load(cx), this.loading))
        .when(Boolean(props()?.overlay), (el) => el
          .child(this.iconButton(t, "as-pane", ICON("panel-right"), "Dock as a pane on the right", () => { this.dismiss(); run("pane.split", { direction: "right", mod: "ado-standup" }); }))
          .child(this.iconButton(t, "close", ICON("x"), "Close", () => this.dismiss()))))
      .when(Boolean(d?.members?.length), (el) => el.child(h_flex().px(16).pb(8).gap(4).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.dim).mr(4).child("Person"))
        .child(this.pill(t, "who-all", "Everyone", !this.who, (_e, cx) => { this.who = null; cx.notify(); }))
        .children(d.members.map((p) => this.pill(t, `who-${p.mail.replace(/[^a-z0-9]/g, "")}`, p.name, this.who === p.mail, (_e, cx) => {
          this.who = this.who === p.mail ? null : p.mail;
          cx.notify();
        })))));
  }

  render() {
    const t = theme();
    const root = v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).child(this.header(t));
    if (!this.data) {
      return root.child(v_flex().flex_1().items_center().justify_center().gap(6)
        .child(div().text_size(13).text_color(this.error ? S.critical : t.dim).child(this.error ? "Couldn't load the standup" : `Loading ${this.team ?? "standup"}…`))
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.muted).child(this.error))
          .child(div().text_size(12).text_color(t.dim).child("Try `az login` in a terminal, then refresh."))));
    }
    const m = this.model();
    const errs = Object.entries(this.data.errors ?? {});
    return root.child(div().id("standup-body").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().p(16).gap(12)
        .when(errs.length > 0, (el) => el.child(div().px(12).py(8).rounded(8).bg(S.critical + "22").text_size(12).text_color(t.foreground)
          .child(`Some data didn't load: ${errs.map(([k, v]) => `${k} (${v})`).join("; ")}`)))
        .child(this.tiles(t, m))
        .child(h_flex().gap(12).items_start().child(this.completedCard(t, m)).child(this.reviewCard(t, m)))
        .child(h_flex().gap(12).items_start().child(this.impCard(t, m)).child(this.newCard(t, m)))
        .child(h_flex().gap(12).items_start().child(this.buildsCard(t, m)).child(this.deploysCard(t, m)))));
  }
}
