import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, exec, notify, playSound, appHome } from "herdr";
import { readFile } from "fs/promises";

// The orchestrator daemon (mods/orch): polled for approvals so a new plan or
// permission ask notifies here even with its dialog closed.
// orchestrator.url in addons.json (herdr-addons README), read before each poll.
async function orchBase() {
  try {
    const u = JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8"))?.orchestrator?.url;
    if (u) return String(u).replace(/\/+$/, "");
  } catch { /* defaults */ }
  return "http://127.0.0.1:8490";
}
const ORCH_POLL_MS = 15000;
async function orchGet(path) {
  const r = await exec("curl", ["-q", "--noproxy", "*", "-sf", "-m", "10", (await orchBase()) + path]);
  if (r.code !== 0) throw new Error("orchestrator unreachable");
  return JSON.parse(r.stdout);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.orchSeen = new Set(JSON.parse(localStorage.getItem("orch.seen") ?? "[]"));
    this.orchWaiting = 0;
    this.pollOrch(cx);
    cx.timer.every(ORCH_POLL_MS, (cx) => this.pollOrch(cx));
  }

  // Plans waiting for approval and agents halted on a permission. Each new one
  // posts a notification (click: the Approvals tab) and plays the blocked sound.
  pollOrch(cx) {
    if (this.orchBusy) return;
    this.orchBusy = true;
    cx.spawn(async (cx) => {
      try {
        const [ap, ss, inbox] = await Promise.all([orchGet("/v1/approvals"), orchGet("/v1/sessions"), orchGet("/v1/pr-inbox").catch(() => null)]);
        const plans = ap?.pending_approvals ?? [];
        const sessions = ss?.sessions ?? [];
        const asks = sessions.filter((s) => s.awaiting_permission);
        const items = [
          ...plans.map((a) => ({ key: `plan:${a.item_id}:${a.planned_revision ?? ""}`, title: "Plan waiting for approval", body: `${a.item_id} · ${a.title ?? ""}` })),
          ...asks.map((s) => ({ key: `ask:${s.session_id}:${s.permission_title}:${s.permission_tool_input}`, title: "Agent needs a permission", body: `${s.workflow_id ?? ""} · ${s.permission_title || "tool call"}` })),
        ];
        const fresh = items.filter((i) => !this.orchSeen.has(i.key));
        for (const i of fresh.slice(0, 3)) {
          notify({ title: i.title, body: i.body, level: "warning", timeout: 15000, action: { name: "mod.open", args: { name: "orch" } } });
        }
        if (fresh.length > 3) notify({ title: `${fresh.length - 3} more orchestrator approvals`, level: "warning", action: { name: "mod.open", args: { name: "orch" } } });
        if (fresh.length) { playSound("blocked"); setShared("orch.want", "approvals"); }
        this.orchSeen = new Set(items.map((i) => i.key));
        localStorage.setItem("orch.seen", JSON.stringify([...this.orchSeen]));
        this.orchWaiting = items.length;
        this.orchOnline = true;
        setShared("orch.counts", { sessions: sessions.length, approvals: items.length, prs: (inbox?.review_requests ?? []).filter((p) => p.needs_review).length });
      } catch {
        this.orchOnline = false;
      } finally {
        this.orchBusy = false;
        cx.notify();
      }
    });
  }

  // Orchestrator dropdown (mods/orch-menu); a count while approvals wait.
  orchButton(t, stop) {
    const n = this.orchWaiting ?? 0;
    return h_flex().id("orch-btn").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(t.chrome).text_color(n ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .tooltip(this.orchOnline === false ? "Orchestrator (offline)" : n ? `${n} waiting on your approval` : "Orchestrator")
      .on_click(() => openOverlay({ mod: "orch-menu", kind: "popup", width: 300, height: 218 }))
      .child(svg("mods/orch-menu/wand.svg").size(14).text_color(n ? t.done : this.orchOnline === false ? t.dim : t.muted)).child("Orchestrator")
      .when(n > 0, el => el.child(div().px(5).rounded(8).bg(t.done).text_color(t.background).text_size(10.5).child(String(n))))
      .child(svg("mods/tools-menu/chevron-down.svg").size(11));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // Tools dropdown (mods/tools-menu): the ported plugins.
  toolsButton(t, stop) {
    return h_flex().id("tools-btn").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(t.chrome).text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => openOverlay({ mod: "tools-menu", kind: "popup", width: 300, height: 168 }))
      .child(svg("mods/tools-menu/wrench.svg").size(14)).child("Tools")
      .child(svg("mods/tools-menu/chevron-down.svg").size(11));
  }

  // Azure DevOps dropdown (mods/ado-menu): PRs and other ADO tools.
  adoButton(t, stop) {
    return h_flex().id("ado-btn").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(t.chrome).text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => openOverlay({ mod: "ado-menu", kind: "popup", width: 300, height: 218 }))
      .child(svg("mods/ado-menu/ado.svg").size(14)).child("ADO")
      .child(svg("mods/tools-menu/chevron-down.svg").size(11));
  }

  // Datadog dropdown (mods/dd-menu): what needs attention in Datadog.
  ddButton(t, stop) {
    return h_flex().id("dd-btn").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(t.chrome).text_color(t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => openOverlay({ mod: "dd-menu", kind: "popup", width: 300, height: 62 }))
      .child(svg("mods/dd-menu/datadog.svg").size(14)).child("Datadog")
      .child(svg("mods/tools-menu/chevron-down.svg").size(11));
  }

  // Claude usage dashboard (mods/cc-usage): toggles its dialog; lit while open.
  usageButton(t, stop) {
    const on = shared("cc-usage.open") === true;
    return h_flex().id("cc-usage-btn").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .tooltip("Claude usage (⌘⇧U)")
      .on_click(() => run("mod.open", { name: "cc-usage" }))
      .child(svg("mods/cc-usage/gauge.svg").size(14)).child("Usage");
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .child(this.toolsButton(t, stop))
      .child(this.adoButton(t, stop))
      .child(this.orchButton(t, stop))
      .child(this.ddButton(t, stop))
      .child(this.usageButton(t, stop))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
