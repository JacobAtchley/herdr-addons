// Orchestrator: the local orchestrator daemon's sessions, approvals and PR
// inbox, the way its web dashboard (http://localhost:8490) shows them.
//   Sessions       live and recent agent sessions; open one for its transcript
//                  (newest first) and steer the live one.
//   Approvals      plans waiting on you (read DESIGN.md / PLAN.md, approve or
//                  reject) and agents halted on a tool permission (approve/deny).
//   Pull requests  PRs that need your review (hand one to the agent) and yours.
// The tab bar's Orchestrator button (my-tabs) polls approvals and notifies.
//
// Opens as a dialog (mod.open:orch), with props {tab} from the Orchestrator menu.

import { View, div, svg, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, VirtualListScrollHandle, v_virtual_list, TextView } from "gpui-base";
import { exec, theme, settings, props, closeOverlay, notify, shared, setShared, run, openOverlay, appHome } from "herdr";
import { readFile } from "fs/promises";
import { api, dashUrl, baseUrl } from "./api.js";

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

const POLL_MS = 5000; // lists
const LIVE_MS = 3000; // an open live session's transcript
const TAIL = 400; // newest transcript events loaded
const TAIL_ROW = 22; // px per event line in live tail
const PERMISSION_WINDOW_S = 3600; // the daemon auto-denies an ask after this
const CONFIRM_MS = 3000;
const TABS = [
  { key: "sessions", label: "Sessions" },
  { key: "approvals", label: "Approvals" },
  { key: "prs", label: "Pull requests" },
];
const ICON = (n) => `mods/orch/${n}.svg`;

// ---- helpers

function ago(when) {
  const ms = typeof when === "number" ? when * 1000 : Date.parse(String(when).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(when)) ? "" : "Z"));
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
// "14m" until an ISO time, or "now" once it has passed.
function until(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = (ms - Date.now()) / 1000;
  if (s <= 0) return "now";
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function clock(ts) {
  const d = new Date(ts * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
const phaseLabel = (p) => (p ? String(p).replace(/_/g, " ") : "");
const itemOf = (wf) => `${wf.source_type}-${wf.source_id}`;
const msg = (e) => String(e?.message ?? e);
function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
// A tool call's command or path, from its raw input.
function toolSummary(raw) {
  const j = parseJson(raw);
  const r = j?.raw_input ?? j ?? {};
  return r.command ?? r.file_path ?? r.path ?? r.pattern ?? r.url ?? r.query ?? (typeof raw === "string" ? raw : "");
}
function stateColor(t, state) {
  const s = String(state ?? "").toUpperCase();
  if (/BLOCKED|FAILED|ERROR/.test(s)) return t.blocked;
  if (/AWAITING|APPROV|WAIT/.test(s)) return t.done;
  if (/EXECUT|PLANN|REVIEWING|RUNNING|INVESTIG|FIX/.test(s)) return t.accent;
  if (/PUBLISHED|REVIEWED|DONE|MERGED|COMPLETE/.test(s)) return t.ansi2;
  return t.dim;
}

export default class Orchestrator extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // The full-screen reader for a plan's DESIGN.md / PLAN.md (planCard).
    if (p.doc) {
      this.reader = { item: p.doc.item, file: p.doc.file, title: p.doc.title, source: false };
      this.artifacts = {};
      this.loadArtifacts(p.doc.item, cx);
      return;
    }
    // A notification click opens the dialog via mod.open (no props): my-tabs leaves the tab to show.
    const want = shared("orch.want");
    if (want) setShared("orch.want", null);
    this.tab = p.session ? "sessions" : p.tab ?? want ?? localStorage.getItem("tab") ?? "sessions";
    this.data = {}; // status, sessions, workflows, approvals, history, inbox, perms
    this.error = null;
    this.loading = false;
    this.fetched = null;
    this.open = {}; // expanded rows
    this.artifacts = {}; // item id → {loading, data, error}
    this.source = {}; // plan file key → show the raw Markdown
    this.busy = {}; // action key → true
    this.errors = {}; // row key → message
    this.confirm = {}; // action key → armed at ms
    this.session = p.session ?? null; // open transcript: session id
    this.events = null;
    this.eventsError = null;
    // Live tail: keep the transcript scrolled to its newest event. Scrolling up turns it off.
    this.tail = true; // every transcript opens tailing
    this.txScroll = VirtualListScrollHandle.new();
    this.steer = InputState.new({ placeholder: "Steer this session… (sent after its current step)" });
    this.steer.on("submit", (_e, cx) => this.sendSteer(cx));
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    cx.timer.every(LIVE_MS, (cx) => { if (this.session && this.isLive(this.session)) this.loadEvents(cx); });
    if (this.session) this.loadEvents(cx);
  }

  // ---- data

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const settle = (p) => p.then((v) => v, () => null);
        const [status, sessions, workflows, approvals, history, inbox] = await Promise.all([
          api.status(), settle(api.sessions()), settle(api.workflows()), settle(api.approvals()), settle(api.history(120)), settle(api.prInbox()),
        ]);
        const live = sessions?.sessions ?? [];
        const perms = {};
        await Promise.all(live.filter((s) => s.awaiting_permission).map(async (s) => {
          try { const r = await api.permission(s.session_id); if (r?.pending && r.permission) perms[s.session_id] = r.permission; } catch { /* next poll */ }
        }));
        this.data = { status, sessions: live, workflows: workflows?.workflows ?? this.data.workflows ?? [], approvals: approvals?.pending_approvals ?? [], history: history?.entries ?? this.data.history ?? [], inbox: inbox ?? this.data.inbox, perms };
        this.error = null;
        this.fetched = Date.now();
        setShared("orch.counts", this.counts());
      } catch (e) {
        this.error = msg(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  counts() {
    const d = this.data;
    const asks = (d.sessions ?? []).filter((s) => s.awaiting_permission).length;
    const reviews = (d.inbox?.review_requests ?? []).filter((p) => p.needs_review).length;
    return { sessions: (d.sessions ?? []).length, approvals: (d.approvals ?? []).length + asks, prs: reviews };
  }

  isLive(sid) {
    return (this.data.sessions ?? []).some((s) => s.session_id === sid);
  }

  workflow(id) {
    return (this.data.workflows ?? []).find((w) => itemOf(w) === id || w.source_id === id) ?? null;
  }

  loadEvents(cx) {
    const sid = this.session;
    if (this.eventsLoading) return;
    this.eventsLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await api.sessionHistory(sid, TAIL);
        if (this.session !== sid) return;
        // A tool's command arrives in its progress events; keep it on the start.
        const all = r?.events ?? [];
        const cmd = {};
        for (const e of all) if (e.tool_call_id && !cmd[e.tool_call_id] && e.tool_input) { const c = toolSummary(e.tool_input); if (c) cmd[e.tool_call_id] = c; }
        this.events = all.filter((e) => e.kind !== "usage" && e.kind !== "tool_progress").map((e) => (e.kind === "tool_start" && cmd[e.tool_call_id] ? { ...e, command: cmd[e.tool_call_id] } : e));
        this.eventsMore = Boolean(r?.has_more);
        this.eventsUsage = [...(r?.events ?? [])].reverse().find((e) => e.kind === "usage")?.text ?? null;
        this.eventsError = null;
        if (this.tail) this.toBottom(cx);
      } catch (e) {
        this.eventsError = msg(e);
      } finally {
        this.eventsLoading = false;
        cx.notify();
      }
    });
  }

  // Rows are measured as they're drawn, so the first jump can land short of
  // new, taller rows: jump again once they've been laid out.
  toBottom(cx) {
    const jump = () => {
      this.txScroll.scroll_to_bottom();
      const n = this.events?.length ?? 0;
    };
    jump();
    for (const ms of [40, 150, 400]) cx.timer.after(ms, (cx) => { if (this.tail) { jump(); cx.notify(); } });
  }

  setTail(on, cx) {
    this.tail = on;
    if (on) this.toBottom(cx);
    cx.notify();
  }

  openSession(sid, cx) {
    this.session = sid;
    this.tail = true;
    this.events = null;
    this.eventsError = null;
    this.tab = "sessions";
    this.loadEvents(cx);
    cx.notify();
  }

  // Runs an action once (busy-guarded), shows its error on the row, refreshes after.
  act(key, row, fn, cx, done) {
    if (this.busy[key]) return;
    this.busy[key] = true;
    delete this.errors[row];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await fn();
        done?.(r);
      } catch (e) {
        this.errors[row] = msg(e);
      } finally {
        delete this.busy[key];
        cx.notify();
        this.refresh(cx);
      }
    });
  }

  // Two clicks within CONFIRM_MS fire; the first arms the button.
  armed(key, cx) {
    const now = Date.now();
    if (this.confirm[key] && now - this.confirm[key] <= CONFIRM_MS) { delete this.confirm[key]; return true; }
    this.confirm[key] = now;
    cx.timer.after(CONFIRM_MS + 50, (cx) => cx.notify());
    cx.notify();
    return false;
  }
  isArmed(key) {
    return this.confirm[key] && Date.now() - this.confirm[key] <= CONFIRM_MS;
  }

  // Ask the daemon to poll now, then re-read a little later to show what it found.
  pollNow(cx) {
    this.act("poll", "poll", () => api.poll(), cx, () => {
      notify({ title: "Orchestrator polling", body: "Checking for new work items and PR feedback now.", level: "info", timeout: 2500 });
      cx.timer.after(4000, (cx) => this.refresh(cx));
      cx.timer.after(15000, (cx) => this.refresh(cx));
    });
  }

  sendSteer(cx) {
    const text = this.steer.value().trim();
    const sid = this.session;
    if (!text || !sid) return;
    this.act(`steer:${sid}`, `steer:${sid}`, () => api.steer(sid, text), cx, () => {
      this.steer.set_value("");
      notify({ title: "Steer sent", body: "Delivered after the session's current step.", level: "info", timeout: 2500 });
      this.loadEvents(cx);
    });
  }

  loadArtifacts(itemId, cx) {
    if (this.artifacts[itemId]) return;
    this.artifacts[itemId] = { loading: true };
    cx.spawn(async (cx) => {
      try { this.artifacts[itemId] = { data: await api.artifacts(itemId) }; } catch (e) { this.artifacts[itemId] = { error: msg(e) }; }
      cx.notify();
    });
  }

  // A session's folder: its workflow's worktree, else the cwd its Claude
  // transcript recorded (~/.claude/projects/*/<id>.jsonl), else null.
  async sessionFolder(sid, workflowId) {
    const wt = this.workflow(workflowId)?.worktree_path;
    const script = 'd="$1"; if [ -n "$d" ] && [ -d "$d" ]; then echo "$d"; exit; fi; ' +
      'f=$(ls "$HOME"/.claude/projects/*/"$2".jsonl 2>/dev/null | head -1); [ -n "$f" ] || exit 0; ' +
      'c=$(grep -m1 -o \'"cwd":"[^"]*"\' "$f" | head -1 | sed \'s/^"cwd":"//; s/"$//\'); [ -d "$c" ] && echo "$c"';
    const r = await exec("/bin/sh", ["-c", script, "sh", wt ?? "", sid]);
    return (r.stdout ?? "").trim() || null;
  }

  // A new tab: a shell in the session's worktree, or Claude Code resuming the session there.
  openSessionTab(kind, sid, workflowId, cx) {
    const key = `${kind}:${sid}`;
    if (kind === "resume" && this.isLive(sid) && !this.armed(key, cx)) return;
    this.act(key, `row:${sid}`, async () => {
      const folder = await this.sessionFolder(sid, workflowId);
      if (!folder) {
        notify({ title: "No worktree for this session", body: "It may have been cleaned up after the work finished.", level: "warning", timeout: 4000 });
        return;
      }
      const label = String(workflowId ?? sid.slice(0, 8)).replace(/^ado-(pr-)?/, "");
      if (kind === "folder") run("tab.new", { name: `WT ${label}`, folder });
      else run("tab.new", { name: `Resume ${label}`, folder, argv: ["claude", "--resume", sid, "--model", await claudeModel("resume")] });
      this.dismiss();
    }, cx);
  }

  sessionActions(t, sid, workflowId) {
    const resumeKey = `resume:${sid}`;
    const live = this.isLive(sid);
    return h_flex().flex_none().gap(2)
      .child(this.iconButton(t, `wt-${sid}`, ICON("folder"), "Open the worktree in a new tab", (cx) => this.openSessionTab("folder", sid, workflowId, cx), Boolean(this.busy[`folder:${sid}`])))
      .child(this.iconButton(t, `cr-${sid}`, ICON("resume"),
        this.isArmed(resumeKey) ? "Still running under the orchestrator: click again to resume it anyway" : live ? "Resume in Claude Code (it's still running: asks to confirm)" : "Resume in Claude Code in a new tab",
        (cx) => this.openSessionTab("resume", sid, workflowId, cx), Boolean(this.busy[resumeKey])));
  }

  browse(url) {
    if (url) exec("open", [url]).catch((e) => notify({ title: "Couldn't open", body: msg(e), level: "error" }));
  }

  // Reopen this view (tab, and the open session if any) as a pane beside the focused one.
  dock() {
    const p = { tab: this.tab };
    if (this.session) p.session = this.session;
    this.dismiss();
    run("pane.split", { direction: "right", mod: "orch", props: p });
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  // ---- small pieces

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
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(ic);
  }

  // A text button; `tone` colors it (filled when primary).
  button(t, id, label, onClick, { tone = null, primary = false, busy = false, tip = null } = {}) {
    const c = tone ?? t.muted;
    let el = div().id(id).px(10).py(4).rounded(6).text_size(12).cursor_pointer().flex_none()
      .border(1).border_color(primary ? c : t.border)
      .text_color(primary ? t.background : c)
      .when(primary, (e) => e.bg(c))
      .hover((s) => s.bg(primary ? c : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!busy) onClick(cx); })
      .child(busy ? "…" : label);
    if (tip) el = el.tooltip(tip);
    return el;
  }

  badge(t, text, color) {
    return div().flex_none().px(6).py(1).rounded(4).text_size(10.5).text_color(color).border(1).border_color(color).child(text);
  }

  section(t, title, n) {
    return h_flex().px(4).pt(14).pb(6).gap(8).items_center()
      .child(div().text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .when(n != null, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(n))));
  }

  empty(t, text) {
    return div().px(4).py(8).text_size(12).text_color(t.dim).child(text);
  }

  rowError(t, key) {
    const e = this.errors[key];
    return e ? div().text_size(11.5).text_color(t.blocked).child(e) : null;
  }

  // ---- header

  header(t) {
    const c = this.counts();
    const s = this.data.status;
    const statusText = this.error ? "offline" : !this.fetched ? "connecting…" : s?.status ?? "";
    return h_flex().flex_none().px(16).py(10).gap(12).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg(ICON("wand")).size(16).text_color(t.accent))
        .child(div().text_size(14).font_semibold().child("Orchestrator"))
        .child(h_flex().gap(5).items_center()
          .child(div().size(7).rounded_full().bg(this.error ? t.blocked : this.fetched ? t.ansi2 : t.dim))
          .child(div().text_size(12).text_color(t.dim).child(statusText))))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.background).children(
        TABS.map((x) => this.pill(t, `tab-${x.key}`, c[x.key] ? `${x.label} ${c[x.key]}` : x.label, this.tab === x.key, (_e, cx) => {
          this.tab = x.key;
          localStorage.setItem("tab", x.key);
          cx.notify();
        })),
      ))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).child(this.fetched ? `updated ${ago(this.fetched / 1000)} ago` : ""))
      .when(Boolean(s?.next_poll_at), (el) => el.child(div().text_size(11).text_color(t.dim)
        .child(`next poll ${until(s.next_poll_at) === "now" ? "now" : "in " + until(s.next_poll_at)}`)))
      .child(this.button(t, "poll-now", "Poll now", (cx) => this.pollNow(cx), {
        busy: this.busy.poll,
        tip: this.errors.poll ? `Poll failed: ${this.errors.poll}` : s?.last_poll_at ? `Last poll ${ago(s.last_poll_at)} ago. Polls ADO now for new work items and PR feedback.` : "Poll ADO now for new work items and PR feedback",
        tone: this.errors.poll ? t.blocked : null,
      }))
      .child(this.iconButton(t, "refresh", ICON("refresh"), "Refresh this view", (cx) => this.refresh(cx), this.loading))
      .child(this.iconButton(t, "dash", ICON("external"), "Open the web dashboard", () => this.browse(dashUrl("/"))))
      .when(Boolean(props()?.overlay), (el) => el
        .child(this.iconButton(t, "as-pane", ICON("panel-right"), "Dock as a pane on the right", () => this.dock()))
        .child(this.iconButton(t, "close", ICON("x"), "Close", () => this.dismiss())));
  }

  // ---- sessions

  sessionsTab(t) {
    if (this.session) return this.transcript(t);
    const live = this.data.sessions ?? [];
    const liveIds = new Set(live.map((s) => s.session_id));
    // Recent finished sessions, newest first, from the activity history.
    const recent = [];
    const seen = new Set();
    for (const h of this.data.history ?? []) {
      if (h.kind !== "session_finished" || !h.session_id || liveIds.has(h.session_id) || seen.has(h.session_id)) continue;
      seen.add(h.session_id);
      recent.push(h);
      if (recent.length >= 30) break;
    }
    return v_flex().px(12).pb(16)
      .child(this.section(t, "Running", live.length))
      .child(live.length ? v_flex().gap(2).children(live.map((s) => this.liveRow(t, s))) : this.empty(t, "No sessions running."))
      .child(this.section(t, "Recent", recent.length))
      .child(recent.length ? v_flex().gap(2).children(recent.map((h) => this.recentRow(t, h))) : this.empty(t, "Nothing finished recently."));
  }

  liveRow(t, s) {
    const wf = this.workflow(s.workflow_id);
    const pct = s.context_size ? Math.round((100 * (s.tokens_used ?? 0)) / s.context_size) : null;
    return h_flex().id(`s-${s.session_id}`).px(10).py(8).gap(12).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => this.openSession(s.session_id, cx))
      .child(div().flex_none().size(8).rounded_full().bg(s.awaiting_permission ? t.done : t.accent).loop("opacity", { from: 0.35, to: 1, period: 1200 }))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center().min_w(0)
          .when(s.awaiting_permission, (el) => el.child(this.badge(t, "NEEDS PERMISSION", t.done)))
          .child(div().flex_1().min_w(0).truncate().text_size(13).child(wf?.title ?? s.workflow_id ?? s.session_id)))
        .child(div().truncate().text_size(11.5).text_color(t.dim)
          .child([s.workflow_id, phaseLabel(s.phase), wf?.repo_key, s.pending_steering ? `${s.pending_steering} steer queued` : null].filter(Boolean).join(" · "))))
      .child(div().flex_none().w(90).text_size(11.5).text_color(pct > 80 ? t.done : t.dim).text_right().child(pct != null ? `${pct}% context` : ""))
      .child(div().flex_none().w(96).text_size(11.5).text_color(t.dim).text_right().child(`${s.event_count ?? 0} events`))
      .child(div().flex_none().w(36).text_size(11.5).text_color(t.dim).text_right().child(ago(s.started_at)))
      .child(this.sessionActions(t, s.session_id, s.workflow_id));
  }

  recentRow(t, h) {
    return h_flex().id(`r-${h.session_id}`).px(10).py(7).gap(12).items_center().rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .on_click((_e, cx) => this.openSession(h.session_id, cx))
      .child(div().flex_none().size(8).rounded_full().bg(h.outcome === "done" ? t.ansi2 : h.outcome ? t.blocked : t.dim))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13).text_color(t.muted).child(h.title || h.workflow_id))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child([h.workflow_id, phaseLabel(h.phase), h.outcome].filter(Boolean).join(" · "))))
      .child(div().flex_none().w(36).text_size(11.5).text_color(t.dim).text_right().child(ago(h.created_at)))
      .child(this.sessionActions(t, h.session_id, h.workflow_id));
  }

  transcript(t) {
    const sid = this.session;
    const live = (this.data.sessions ?? []).find((s) => s.session_id === sid);
    const first = this.events?.[0];
    const wf = this.workflow(live?.workflow_id ?? first?.workflow_id);
    const ask = this.data.perms?.[sid];
    // The live session listed first is the one that takes a steer (as the dashboard).
    const steerable = live && (this.data.sessions ?? [])[0]?.session_id === sid;
    const head = h_flex().flex_none().px(12).py(8).gap(10).items_center().border_b(1).border_color(t.border)
      .child(this.iconButton(t, "back", ICON("back"), "All sessions", (cx) => { this.session = null; this.events = null; cx.notify(); }))
      .child(div().flex_none().size(8).rounded_full().bg(live ? t.accent : t.dim))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).font_semibold().child(wf?.title ?? live?.workflow_id ?? first?.workflow_id ?? sid))
        .child(div().truncate().text_size(11.5).text_color(t.dim)
          .child([live?.workflow_id ?? first?.workflow_id, phaseLabel(live?.phase ?? first?.phase), live ? "live" : "finished", this.eventsUsage, this.eventsMore ? `newest ${TAIL} events` : null].filter(Boolean).join(" · "))))
      .child(this.pill(t, "tail", this.tail ? "● Live tail" : "○ Live tail", this.tail, (_e, cx) => this.setTail(!this.tail, cx)))
      .child(this.button(t, "open-dash", "Open in dashboard", () => this.browse(dashUrl(`/sessions/${sid}`))));
    let body;
    if (this.eventsError && !this.events) body = v_flex().p(14).child(div().text_size(12).text_color(t.blocked).child(this.eventsError));
    else if (!this.events) body = v_flex().p(14).child(div().text_size(12).text_color(t.dim).child("Loading transcript…"));
    else {
      const ev = this.events; // oldest first, newest at the bottom
      const font = settings().font_family;
      const id = `tx-${sid}`;
      body = ev.length
        ? v_flex().relative().flex_1().min_h(0)
          .on_scroll_wheel((e, cx) => { if (this.tail && e.delta.y > 0.5) this.setTail(false, cx); })
          .child(this.tail
            // Live tail: one line per event, so the list can be scrolled to its end exactly.
            ? v_virtual_list(`${id}-tail`, ev.length, TAIL_ROW, (i) => String(ev[i].seq ?? ev[i].id ?? i),
              (r) => ev.slice(r.start, r.end).map((e) => this.eventRow(t, e, font, true))).track_scroll(this.txScroll).size_full()
            : list(id, ev.length, (i) => String(ev[i].seq ?? ev[i].id ?? i), (i) => this.eventRow(t, ev[i], font)).size_full())
          .child(Scrollbar.vertical(this.tail ? `${id}-tail` : id).absolute().inset_0())
        : v_flex().p(14).child(div().text_size(12).text_color(t.dim).child("No events yet."));
    }
    let root = v_flex().flex_1().min_h(0).child(head);
    if (ask) root = root.child(div().px(12).pt(10).child(this.askCard(t, live, ask)));
    root = root.child(body);
    if (steerable) {
      root = root.child(v_flex().flex_none().px(12).py(10).gap(4).border_t(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(h_flex().flex_1().h(30).px(8).rounded(6).bg(t.background).border(1).border_color(t.input)
            .child(Input.new(this.steer).flex_1().text_size(12.5)))
          .child(this.button(t, "steer-send", "Send", (cx) => this.sendSteer(cx), { tone: t.accent, primary: true, busy: this.busy[`steer:${sid}`] })))
        .when(Boolean(this.errors[`steer:${sid}`]), (el) => el.child(this.rowError(t, `steer:${sid}`))));
    }
    return root;
  }

  // One transcript event. Tool progress and usage are dropped on load.
  eventRow(t, e, font, compact = false) {
    let mark = "·", color = t.dim, text = e.text ?? "", mono = false, bold = false;
    switch (e.kind) {
      case "message": mark = "›"; color = t.foreground; break;
      case "thought": mark = "∴"; color = t.dim; break;
      case "tool_start": mark = "$"; color = t.accent; mono = true; { const c = e.command ?? toolSummary(e.tool_input); text = c ? `${c}` : e.text || e.tool_name; if (c && e.text && e.text !== "Terminal") text = `${e.text}: ${c}`; } break;
      case "permission": case "permission_pending": mark = "?"; color = t.done; mono = true; text = `asks: ${e.text}`; break;
      case "permission_approved": mark = "✓"; color = t.ansi2; mono = true; text = `approved: ${e.text}`; break;
      case "permission_denied": mark = "✗"; color = t.blocked; mono = true; text = `denied: ${e.text}`; break;
      case "session_start": mark = "▶"; color = t.dim; break;
      case "state_change": mark = "→"; color = t.accent; text = `${e.state_from} → ${e.state_to}`; bold = true; break;
      case "result": mark = "■"; color = t.ansi2; bold = true; break;
      case "steering": mark = "↪"; color = t.ansi5 ?? t.accent; text = `steer: ${e.text || e.steering}`; break;
      case "plan": mark = "☰"; color = t.muted; break;
      case "error": mark = "!"; color = t.blocked; break;
      default: break;
    }
    if (compact) text = String(text).replace(/\s*\n\s*/g, " ⏎ ");
    if (mono) text = text.length > 600 ? text.slice(0, 600) + "…" : text;
    let line = div().flex_1().flex_shrink_1().min_w(0).text_size(mono ? 11.5 : 12.5).text_color(color).child(text);
    if (compact) line = line.truncate();
    if (mono) line = line.font_family(font);
    if (bold) line = line.font_semibold();
    const row = compact ? h_flex().w_full().min_w(0).h(TAIL_ROW).px(14).gap(8).items_center() : h_flex().w_full().min_w(0).px(14).py(3).gap(8).items_start();
    return row
      .child(div().flex_none().w(52).text_size(10.5).text_color(t.dim).pt(1).child(e.timestamp ? clock(e.timestamp) : ""))
      .child(div().flex_none().w(12).text_size(12).text_color(color).child(mark))
      .child(line);
  }

  // ---- approvals

  approvalsTab(t) {
    const plans = this.data.approvals ?? [];
    const asks = (this.data.sessions ?? []).filter((s) => s.awaiting_permission);
    return v_flex().px(12).pb(16)
      .child(this.section(t, "Agents waiting on a permission", asks.length))
      .child(asks.length ? v_flex().gap(8).children(asks.map((s) => this.askCard(t, s, this.data.perms?.[s.session_id]))) : this.empty(t, "No agent is waiting on a permission."))
      .child(this.section(t, "Plans waiting for approval", plans.length))
      .child(plans.length ? v_flex().gap(8).children(plans.map((a) => this.planCard(t, a))) : this.empty(t, "No plans waiting."));
  }

  askCard(t, s, p) {
    const sid = s?.session_id ?? p?.session_id;
    const key = `ask:${sid}`;
    const left = p?.timestamp ? Math.max(0, Math.round(p.timestamp + PERMISSION_WINDOW_S - Date.now() / 1000)) : null;
    const input = s?.permission_tool_input ? toolSummary(s.permission_tool_input) : "";
    const font = settings().font_family;
    return v_flex().id(`ask-${sid}`).gap(6).p(10).rounded(8).border(1).border_color(t.done).bg(t.done + "14")
      .child(h_flex().gap(8).items_center()
        .child(this.badge(t, s?.permission_kind ? `PERMISSION · ${String(s.permission_kind).toUpperCase()}` : "PERMISSION", t.done))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(s?.permission_title || p?.title || "Tool call"))
        .when(left != null, (el) => el.child(div().flex_none().text_size(11).text_color(left < 300 ? t.blocked : t.dim).child(left ? `${Math.floor(left / 60)}m left` : "expired"))))
      .child(div().text_size(11.5).text_color(t.dim).child([s?.permission_workflow_id || s?.workflow_id, phaseLabel(s?.permission_phase || s?.phase), this.workflow(s?.workflow_id)?.title].filter(Boolean).join(" · ")))
      .when(Boolean(input), (el) => el.child(div().p(8).rounded(6).bg(t.background).text_size(11.5).font_family(font).text_color(t.foreground)
        .child(input.length > 1200 ? input.slice(0, 1200) + "…" : input)))
      .when(Boolean(s?.permission_ask_reason), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`Why it asked: ${s.permission_ask_reason}`)))
      .child(h_flex().gap(6).items_center()
        .child(this.button(t, `ask-ok-${sid}`, "Approve", (cx) => {
          if (!p) { this.errors[key] = "Still loading the ask; try again in a moment."; cx.notify(); return; }
          this.act(`${key}:ok`, key, () => api.answerPermission(sid, p.tool_call_id, true), cx);
        }, { tone: t.ansi2, primary: true, busy: this.busy[`${key}:ok`] }))
        .child(this.button(t, `ask-no-${sid}`, "Deny", (cx) => {
          if (!p) { this.errors[key] = "Still loading the ask; try again in a moment."; cx.notify(); return; }
          this.act(`${key}:no`, key, () => api.answerPermission(sid, p.tool_call_id, false), cx);
        }, { tone: t.blocked, busy: this.busy[`${key}:no`] }))
        .when(this.session !== sid, (el) => el.child(this.button(t, `ask-open-${sid}`, "Open session", (cx) => this.openSession(sid, cx)))))
      .when(Boolean(this.errors[key]), (el) => el.child(this.rowError(t, key)));
  }

  // Rendered / Source toggle.
  segmented(t, id, source, onChange) {
    const pill = (k, label, active) => div().id(`${id}-${k}`).px(8).py(2).rounded(5).text_size(11).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onChange(k === "src", cx))
      .child(label);
    return h_flex().gap(2).p(2).rounded(7).bg(t.raised).child(pill("md", "Rendered", !source)).child(pill("src", "Source", source));
  }

  markdown(id, text, size = 13) {
    return TextView.markdown(id, text).w_full().text_size(size).selectable(true)
      .on_link_click((url) => { if (/^https?:/i.test(url)) this.browse(url); });
  }

  readFull(itemId, file, title) {
    openOverlay({ mod: "orch", kind: "dialog", width: 0.92, height: 0.92, props: { doc: { item: itemId, file, title } } });
  }

  renderReader(t) {
    const r = this.reader;
    const art = this.artifacts[r.item];
    const files = [["DESIGN.md", art?.data?.design], ["PLAN.md", art?.data?.plan]].filter(([, text]) => text);
    const text = files.find(([f]) => f === r.file)?.[1] ?? files[0]?.[1];
    const font = settings().font_family;
    const tab = (f) => div().id(`rd-${f}`).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .text_color(r.file === f ? t.foreground : t.muted).when(r.file === f, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { r.file = f; cx.notify(); }).child(f);
    const body = !art || art.loading ? div().p(20).text_size(12).text_color(t.dim).child("Loading…")
      : art.error ? div().p(20).text_size(12).text_color(t.blocked).child(art.error)
        : !text ? div().p(20).text_size(12).text_color(t.dim).child("Nothing recorded.")
          : h_flex().w_full().justify_center().child(v_flex().w_full().max_w(960).px(28).py(20)
            .child(r.source ? div().text_size(12).font_family(font).text_color(t.foreground).child(text) : this.markdown(`rd-md-${r.file}`, text, 14)));
    return v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground)
      .child(h_flex().flex_none().px(16).py(10).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11).px(6).py(1).rounded(4).bg(t.done).text_color(t.background).child("PLAN"))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(r.title || r.item))
        .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(files.map(([f]) => tab(f))))
        .child(this.segmented(t, "rd-mode", r.source, (v, cx) => { r.source = v; cx.notify(); }))
        .child(this.iconButton(t, "rd-close", ICON("x"), "Close (Esc)", () => { const o = props()?.overlay; if (o) closeOverlay(o); })))
      .child(div().id("rd-body").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }

  planCard(t, a) {
    const id = a.item_id;
    const key = `plan:${id}`;
    const open = this.open[key];
    const art = this.artifacts[id];
    const font = settings().font_family;
    // DESIGN.md / PLAN.md: open by default, rendered as Markdown (Source shows the raw file).
    const file = (label, text) => {
      const fk = `${key}:${label}`;
      const shown = this.open[fk] !== false;
      const src = Boolean(this.source[fk]);
      return v_flex().gap(4)
        .child(h_flex().gap(6).items_center()
          .child(h_flex().id(`f-${fk}`).flex_1().gap(6).items_center().cursor_pointer()
            .on_click((_e, cx) => { this.open[fk] = !shown; cx.notify(); })
            .child(svg(ICON(shown ? "chev-down" : "chev-right")).size(11).text_color(t.dim))
            .child(div().text_size(12).font_semibold().text_color(t.muted).child(label))
            .child(div().text_size(11).text_color(t.dim).child(`${text.split("\n").length} lines`)))
          .when(shown, (el) => el
            .child(this.segmented(t, `fm-${fk}`, src, (v, cx) => { this.source[fk] = v; cx.notify(); }))
            .child(this.iconButton(t, `fx-${fk}`, ICON("expand"), "Read full screen", () => this.readFull(id, label, a.title || id)))))
        .when(shown, (el) => el.child(div().id(`fb-${fk}`).max_h(560).overflow_y_scrollbar().px(14).py(10).rounded(6).bg(t.background)
          .child(src ? div().text_size(11.5).font_family(font).text_color(t.foreground).child(text) : this.markdown(`md-${fk}`, text))));
    };
    const approveKey = `${key}:approve`, rejectKey = `${key}:reject`;
    return v_flex().id(`plan-${id}`).gap(6).p(10).rounded(8).border(1).border_color(t.done).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(this.badge(t, "PLAN", t.done))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(a.title || id))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${id} · ${a.repo_key ?? ""}`)))
      .when(Boolean(a.plan_is_stale), (el) => el.child(div().px(8).py(5).rounded(6).bg(t.blocked + "22").text_size(11.5).text_color(t.blocked)
        .child(`The work item changed since this plan was written (revision ${a.planned_revision ?? "?"} → ${a.latest_revision ?? "?"}). Re-read it before approving.`)))
      .child(h_flex().id(`pf-${id}`).gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.open[key] = !open; if (!open) this.loadArtifacts(id, cx); cx.notify(); })
        .child(svg(ICON(open ? "chev-down" : "chev-right")).size(11).text_color(t.dim))
        .child(div().text_size(12).text_color(t.accent).child(open ? "Hide the plan" : "Read the plan")))
      .when(Boolean(open), (el) => el.child(
        !art || art.loading ? div().text_size(11.5).text_color(t.dim).child("Loading…")
          : art.error ? div().text_size(11.5).text_color(t.blocked).child(art.error)
            : !art.data?.plan && !art.data?.design ? div().text_size(11.5).text_color(t.blocked).child("No PLAN.md recorded for this item: approving would run an implementation with nothing to implement.")
              : v_flex().gap(6).pl(4)
                .when(Boolean(art.data.design), (e) => e.child(file("DESIGN.md", art.data.design)))
                .when(Boolean(art.data.plan), (e) => e.child(file("PLAN.md", art.data.plan)))))
      .child(h_flex().gap(6).items_center()
        .child(this.button(t, `pa-${id}`, this.isArmed(approveKey) ? "Click again to approve" : "Approve", (cx) => {
          if (this.armed(approveKey, cx)) this.act(approveKey, key, () => api.approvePlan(id), cx, () => notify({ title: "Plan approved", body: a.title || id, level: "success", timeout: 3000 }));
        }, { tone: t.ansi2, primary: true, busy: this.busy[approveKey] }))
        .child(this.button(t, `pr-${id}`, this.isArmed(rejectKey) ? "Click again to reject" : "Reject", (cx) => {
          if (this.armed(rejectKey, cx)) this.act(rejectKey, key, () => api.rejectPlan(id), cx);
        }, { tone: t.blocked, busy: this.busy[rejectKey] }))
        .child(div().flex_1())
        .child(this.button(t, `pw-${id}`, "Workflow", () => this.browse(dashUrl(`/workflows/${id}`))))
        .when(Boolean(a.url), (el) => el.child(this.button(t, `pi-${id}`, "Work item", () => this.browse(a.url)))))
      .when(Boolean(this.errors[key]), (el) => el.child(this.rowError(t, key)));
  }

  // ---- pull requests

  prsTab(t) {
    const inbox = this.data.inbox;
    if (!inbox) return this.empty(t, this.error ? "Orchestrator offline." : "Loading…");
    if (inbox.enabled === false) return v_flex().p(12).child(this.empty(t, "The PR inbox is off. Add a pr_inbox: block to config/orchestrator.yaml and restart the daemon."));
    const needs = (inbox.review_requests ?? []).filter((p) => p.needs_review);
    const voted = (inbox.review_requests ?? []).filter((p) => !p.needs_review);
    const mine = inbox.my_prs ?? [];
    return v_flex().px(12).pb(16)
      .child(h_flex().px(4).pt(10).gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(inbox.error ? t.blocked : t.dim)
          .child(inbox.error ? `Inbox error: ${inbox.error}` : inbox.refreshed_at ? `Inbox refreshed ${ago(inbox.refreshed_at)} ago` : ""))
        .child(this.button(t, "inbox-refresh", "Refresh from ADO", (cx) => this.act("inbox", "inbox", () => api.refreshInbox(), cx), { busy: this.busy.inbox })))
      .when(Boolean(this.errors.inbox), (el) => el.child(this.rowError(t, "inbox")))
      .child(this.section(t, "Needs your review", needs.length))
      .child(needs.length ? v_flex().gap(2).children(needs.map((p) => this.prRow(t, p, true))) : this.empty(t, "Nothing waiting on your review."))
      .child(this.section(t, "Your PRs", mine.length))
      .child(mine.length ? v_flex().gap(2).children(mine.map((p) => this.prRow(t, p, false))) : this.empty(t, "You have no active PRs."))
      .when(voted.length > 0, (el) => el
        .child(h_flex().id("voted-toggle").px(4).pt(14).pb(6).gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.open.voted = !this.open.voted; cx.notify(); })
          .child(svg(ICON(this.open.voted ? "chev-down" : "chev-right")).size(11).text_color(t.dim))
          .child(div().text_size(11).font_semibold().text_color(t.dim).child(`ALREADY VOTED OR NOT NEEDED  ${voted.length}`)))
        .when(Boolean(this.open.voted), (e) => e.child(v_flex().gap(2).children(voted.map((p) => this.prRow(t, p, true))))));
  }

  threads(t, p) {
    const total = p.feedback_total ?? 0;
    const open = total - (p.feedback_resolved ?? 0);
    if (!total) return div().flex_none().w(64).text_size(11.5).text_color(t.dim).child("—");
    return h_flex().id(`th-${p.pr_id}`).flex_none().w(64).gap(6).text_size(11.5).tooltip(`${open} unresolved · ${p.feedback_resolved ?? 0} resolved`)
      .when(open > 0, (el) => el.child(div().text_color(t.done).child(`●${open}`)))
      .when((p.feedback_resolved ?? 0) > 0, (el) => el.child(div().text_color(t.ansi2).child(`✓${p.feedback_resolved}`)));
  }

  prRow(t, p, review) {
    const key = `pr:${p.pr_id}`;
    const wf = p.review_workflow ?? p.tracked_workflow;
    const wfState = typeof wf === "object" ? wf?.state : null;
    const voteText = { 10: "approved", 5: "approved w/ suggestions", "-5": "waiting for author", "-10": "rejected" }[p.my_vote];
    const meta = [p.repo_name, `!${p.pr_id}`, `${String(p.source_branch ?? "").replace(/^refs\/heads\//, "")} → ${String(p.target_branch ?? "").replace(/^refs\/heads\//, "")}`];
    return v_flex().id(`p-${p.pr_id}-${review ? "r" : "m"}`).px(10).py(7).gap(3).rounded(6).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .on_click(() => this.browse(p.url))
      .child(h_flex().gap(12).items_center()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center().min_w(0)
            .when(Boolean(p.is_draft), (el) => el.child(this.badge(t, "DRAFT", t.dim)))
            .when(review && Boolean(p.is_required), (el) => el.child(this.badge(t, "REQUIRED", t.accent)))
            .when(Boolean(p.via_group), (el) => el.child(this.badge(t, `via ${p.via_group}`, t.dim)))
            .when(!review && Boolean(p.feedback_waiting), (el) => el.child(this.badge(t, "FEEDBACK WAITING", t.done)))
            .when(Boolean(p.auto_addressed), (el) => el.child(this.badge(t, "AUTO-ADDRESSED", t.ansi2)))
            .when(Boolean(wfState), (el) => el.child(this.badge(t, String(wfState).replace(/_/g, " "), stateColor(t, wfState))))
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(p.is_draft ? t.muted : t.foreground).child(p.title)))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(meta.join(" · "))))
        .child(div().flex_none().w(130).truncate().text_size(12).text_color(t.muted).child(review ? p.author ?? "" : voteText ?? ""))
        .child(this.threads(t, p))
        .child(div().flex_none().w(32).text_size(11.5).text_color(t.dim).child(ago(p.created_at)))
        .when(review, (el) => el.child(wfState ? div().flex_none().w(128)
          : p.claim_holder
          ? div().flex_none().w(128).text_size(11.5).text_color(t.dim).truncate().child(`claimed by ${p.claim_holder.name ?? "someone"}`)
          : div().flex_none().w(128).flex().justify_end().child(this.button(t, `rv-${p.pr_id}`, "Review with agent", (cx) => {
            this.act(key, key, () => api.reviewPr(p.pr_id), cx, (r) => notify({ title: "Review dispatched", body: `!${p.pr_id} → ${r?.item_id ?? "agent"}`, level: "success", timeout: 3000 }));
          }, { tone: t.accent, busy: this.busy[key] || p.reviewable === false, tip: p.reviewable === false ? "Not reviewable by the agent" : null }))))
        .child(this.iconButton(t, `po-${p.pr_id}-${review}`, ICON("external"), "Open in browser", () => this.browse(p.url))))
      .when(Boolean(this.errors[key]), (el) => el.child(this.rowError(t, key)));
  }

  // ---- render

  render() {
    const t = theme();
    if (this.reader) return this.renderReader(t);
    const root = v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).child(this.header(t));
    if (this.error && !this.fetched) {
      return root.child(v_flex().flex_1().items_center().justify_center().gap(6)
        .child(div().text_size(13).text_color(t.blocked).child("Can't reach the orchestrator"))
        .child(div().text_size(12).text_color(t.muted).child(this.error))
        .child(div().text_size(12).text_color(t.dim).child(`Is the daemon running at ${baseUrl()}? (orchestrator.url in addons.json)`)));
    }
    if (this.tab === "sessions" && this.session) return root.child(this.transcript(t));
    const body = this.tab === "approvals" ? this.approvalsTab(t) : this.tab === "prs" ? this.prsTab(t) : this.sessionsTab(t);
    return root.child(div().id(`body-${this.tab}`).flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
}
