// The sidebar's "Orchestrator" list: the orchestrator's running sessions, styled
// like the Agents list above it. A working session spins and counts up how long
// it has been running; one halted on a permission ask says "Needs you". A click
// opens the session's transcript in the orch dialog.
//
// Placed by layouts/my-main.json (block "orchestrator" in sidebar-lists).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, openOverlay, appHome } from "herdr";
import { readFile } from "fs/promises";

// orchestrator.url in addons.json (herdr-addons README), read before each poll.
async function base() {
  try {
    const u = JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8"))?.orchestrator?.url;
    if (u) return String(u).replace(/\/+$/, "");
  } catch { /* defaults */ }
  return "http://127.0.0.1:8490";
}
const SESSIONS_MS = 5000; // running sessions
const TITLES_MS = 30000; // workflow titles
const DIALOG = { mod: "orch", kind: "dialog", width: 0.88, height: 0.86 };

async function get(path) {
  // -q first (skips ~/.curlrc); --noproxy keeps loopback off any proxy.
  const r = await exec("curl", ["-q", "--noproxy", "*", "-sS", "-f", "-m", "6", (await base()) + path]);
  if (r.code !== 0) throw new Error((r.stderr || "").trim() || `curl exited ${r.code}`);
  return JSON.parse(r.stdout || "null");
}

const itemOf = (wf) => `${wf.source_type}-${wf.source_id}`;
const phaseLabel = (p) => (p ? String(p).replace(/_/g, " ") : "");

// Seconds → "42s", "4m 12s", "1h 05m".
function elapsed(s) {
  s = Math.max(0, Math.floor(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export default class OrchSidebar extends View {
  init(_props, cx) {
    this.sessions = null;
    this.titles = {};
    this.offline = false;
    this.load(cx);
    this.loadTitles(cx);
    cx.timer.every(SESSIONS_MS, (cx) => this.load(cx));
    cx.timer.every(TITLES_MS, (cx) => this.loadTitles(cx));
    // The running clocks: a repaint a second, only while something runs.
    cx.timer.every(1000, (cx) => { if (this.sessions?.length) cx.notify(); });
  }

  load(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const d = await get("/v1/sessions");
        const list = (d?.sessions ?? []).slice().sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
        // A session the titles don't know yet: fetch them now, not in 30s.
        if (list.some((s) => !(s.workflow_id in this.titles))) this.loadTitles(cx);
        this.sessions = list;
        this.offline = false;
      } catch {
        this.offline = true;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  loadTitles(cx) {
    cx.spawn(async (cx) => {
      try {
        const d = await get("/v1/workflows");
        const wfs = Array.isArray(d) ? d : d?.workflows ?? [];
        for (const w of wfs) this.titles[itemOf(w)] = w.title || "";
        cx.notify();
      } catch { /* titles are a nicety */ }
    });
  }

  openSession(sid) {
    openOverlay({ ...DIALOG, props: { session: sid } });
  }

  row(t, s, now) {
    const waiting = Boolean(s.awaiting_permission);
    const title = this.titles[s.workflow_id] || s.workflow_id || s.session_id;
    const status = waiting
      ? div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked)
        .flex().items_center().child("Needs you")
      : svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    return h_flex().id(`os-${s.session_id}`).px(8).h(30).flex_none().rounded(8).items_center().gap(9).cursor_pointer()
      .hover((x) => x.bg(t.hover))
      .tooltip(`${title}\n${[s.workflow_id, phaseLabel(s.phase)].filter(Boolean).join(" · ")}${waiting && s.permission_title ? `\nWaiting on: ${s.permission_title}` : ""}`)
      .on_click(() => this.openSession(s.session_id))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).max_w(150).truncate().text_color(t.foreground).child(title))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${phaseLabel(s.phase)}`)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(s.started_at ? elapsed(now - s.started_at) : ""))
      .child(status);
  }

  render() {
    const t = theme();
    const now = Date.now() / 1000;
    const list = this.sessions ?? [];
    const note = (text) => div().px(12).text_size(12).text_color(t.dim).child(text);
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(6)
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Orchestrator"))
        .when(list.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(list.length))))
        .child(div().flex_1())
        .child(div().id("os-open").text_size(11).text_color(t.dim).cursor_pointer()
          .hover((x) => x.text_color(t.foreground))
          .tooltip("Open the Orchestrator")
          .on_click(() => openOverlay({ ...DIALOG, props: { tab: "sessions" } }))
          .child(svg("mods/orch/wand.svg").size(13))))
      .when(this.offline && !list.length, (el) => el.child(note("Orchestrator offline.")))
      .when(!this.offline && this.sessions !== null && !list.length, (el) => el.child(note("No sessions running.")))
      .child(v_flex().id("os-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(list.map((s) => this.row(t, s, now))));
  }
}
