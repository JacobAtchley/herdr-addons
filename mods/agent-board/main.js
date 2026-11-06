// Agents as a kanban board: one column per status, a card per agent with the
// last thing it said. Opens as a dialog (mod.open:agent-board), as a pane/tab, or
// as the top of the `board` layout (props.layout), above the shown agent.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, run, theme, hc, props, closeOverlay, setAgentOrder, focused } from "herdr";

const COLUMNS = [
  { status: "blocked", label: "Needs you" },
  { status: "done", label: "Done" },
  { status: "working", label: "Working" },
  { status: "idle", label: "Idle" },
];

// Lines that are an agent's chrome, not what it said: rules, boxes, hints, footers.
const NOISE = /^[\s─━═│┃╭╮╰╯┌┐└┘├┤┬┴┼▔▁▏▕]*$|Tip:|shift\+tab|for shortcuts|esc to interrupt|Update available|auto mode|accept edits|bypass permissions/i;
const RULE = /^\s*[─━═]{20,}/;
const clean = (s) => s.replace(/^[^\p{L}\p{N}"'`(\[]+/u, "").trim();

// What the agent last said: above its input box, skipping chrome. Blocked
// agents usually end with a question, so prefer one of those when asked.
function gist(text, blocked) {
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  let end = lines.length;
  if (!blocked) {
    // The input box: the first rule of the screen's last few lines.
    const from = Math.max(0, lines.length - 14);
    const box = lines.findIndex((l, i) => i >= from && RULE.test(l));
    if (box >= 0) end = box;
  }
  const said = lines.slice(0, end).filter((l) => l.trim() && !NOISE.test(l)).map(clean).filter(Boolean);
  if (blocked) {
    const q = [...said].reverse().find((l) => /\?\s*$/.test(l));
    if (q) return q;
  }
  return said.slice(-2).join(" · ");
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class AgentBoard extends View {
  init(_props, cx) {
    this.width = 0;
    this.gists = {};
    // Each agent's last status and when it changed, kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    // Screens change all the time and aren't live data: read them gently.
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.refresh(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  refresh(cx) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        for (const a of agents()) {
          const r = await hc(["read", a.address, "--lines", "40"]).catch(() => null);
          if (r?.stdout != null) this.gists[a.address] = gist(r.stdout, a.status === "blocked");
        }
      } finally {
        this.reading = false;
      }
      cx.notify();
    });
  }

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      if (this.changed[a.address]?.s === a.status) continue;
      this.changed[a.address] = { s: a.status, at: now };
      dirty = true;
    }
    if (dirty) localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  open(a) {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    // The board layout has no tabs, only an agent block: show the agent there.
    if (props()?.layout) run("agent.focus", { terminal: a.address });
    else run("pane.focus", { pane: a.pane });
  }

  card(t, a, now, kids, shown) {
    const when = this.changed[a.address]?.at;
    const tab = /^\d+$/.test(a.tab_name) ? `tab ${a.tab_name}` : a.tab_name;
    const said = this.gists[a.address];
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    const color = t[a.status] ?? t.dim;
    return v_flex()
      .id(`card-${a.address}`)
      .flex_none()
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(shown ? t.selected : t.background)
      .border(1)
      .border_color(a.status === "blocked" ? color + "80" : t.border)
      .border_l(3)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      // The board layout drags the window by its block; a card is a control.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.open(a))
      .child(h_flex().gap(8).items_center()
        .when(Boolean(icon(a.program, 16, t.foreground)), (el) => el.child(icon(a.program, 16, t.foreground)))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(a.space_name || a.program?.name || a.address))
        .when(a.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(color).spin(900)))
        .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when)))))
      .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
        .child(div().min_w(0).truncate().child(`${a.program?.name ?? a.app ?? "agent"} · ${tab}`))
        .when(Boolean(machine), (el) => el.child(div().flex_none().text_color(t.dim).child(`@${machine}`)))
        .child(div().flex_1())
        .when(kids > 0, (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_color(t.dim).child(`+${kids} sub`)))
        .child(div()
          .id(`peek-${a.address}`)
          .flex_none()
          .p(2)
          .rounded(4)
          .text_color(t.dim)
          .tooltip("Peek")
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("terminal.peek", { terminal: a.address });
          })
          .child(svg("mods/workspace-chrome/monitor.svg").size(12))))
      .when(Boolean(said), (el) => el.child(div()
        .text_size(12)
        .max_h(54)
        .overflow_hidden()
        .text_color(a.status === "blocked" ? t.foreground : t.muted)
        .child(said.length > 180 ? said.slice(0, 179) + "…" : said)));
  }

  column(t, col, cards, stacked) {
    const color = t[col.status] ?? t.dim;
    return v_flex()
      .id(`col-${col.status}`)
      .when(!stacked, (el) => el.flex_1().min_w(0).h_full())
      .when(stacked, (el) => el.w_full().flex_none())
      .rounded(10)
      .bg(t.surface)
      .border(1)
      .border_color(t.border)
      .child(h_flex().px(12).h(36).flex_none().gap(8).items_center()
        .child(div().size(8).rounded(4).bg(color))
        .child(div().text_size(12).font_semibold().text_color(t.foreground).child(col.label))
        .child(div().text_size(12).text_color(t.dim).child(String(cards.length))))
      .child(v_flex()
        .id(`cards-${col.status}`)
        .when(!stacked, (el) => el.flex_1().min_h(0).overflow_y_scrollbar())
        .px(8)
        .pb(8)
        .gap(8)
        .children(cards.length ? cards : [div().px(4).py(6).text_size(12).text_color(t.dim).child("—")]));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const list = agents();
    this.track(list, now);
    const all = terminals();
    const kids = (addr) => all.filter((k) => k.parent === addr && k.state === "live").length;
    // Newest change first within a column.
    const since = (a) => this.changed[a.address]?.at ?? 0;
    const byCol = COLUMNS.map((c) => list.filter((a) => a.status === c.status).sort((x, y) => since(y) - since(x) || y.seq - x.seq));
    setAgentOrder(byCol.flat().map((a) => a.address));
    const stacked = this.width > 0 && this.width < 640;
    const overlay = props()?.overlay;
    const inLayout = Boolean(props()?.layout);
    // In the layout, the agent block below shows focused().agent; elsewhere, the focused pane.
    const isShown = (a) => (inLayout ? a.address === focused()?.agent : a.focused);

    return v_flex()
      .id("root")
      .on_size_change((size, cx) => {
        this.width = size.width;
        cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.canvas ?? t.chrome)
      .text_size(13)
      .child(h_flex().pl(inLayout ? 84 : 16).pr(16).h(44).flex_none().gap(10).items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Agents"))
        .child(div().text_size(12).text_color(t.dim).child(`${list.length} across ${spaces().length} spaces`))
        .child(div().flex_1())
        .when(Boolean(overlay), (el) => el.child(div()
          .id("close")
          .p(4)
          .rounded(4)
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(overlay))
          .child(svg("mods/workspace-chrome/x.svg").size(14)))))
      .when(list.length === 0, (el) => el.child(div().px(16).text_size(12).text_color(t.dim)
        .child("No agents yet. They show up here once they report a status.")))
      .when(list.length > 0, (el) => el.child((stacked ? v_flex().id("board").overflow_y_scrollbar() : h_flex().id("board"))
        .flex_1()
        .min_h(0)
        .px(12)
        .pb(12)
        .gap(10)
        .children(COLUMNS.map((c, i) => this.column(t, c, byCol[i].map((a) => this.card(t, a, now, kids(a.address), isShown(a))), stacked)))));
  }
}
