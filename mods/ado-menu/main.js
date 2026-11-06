// The tab bar's ADO dropdown (my-tabs): Azure DevOps tools, each opened the
// way its key opens it. Key hints come from keys.json. Add tools to ITEMS
// (and grow the popup height in my-tabs' adoButton: 52 px per row + 10).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, keys } from "herdr";

export const ITEMS = [
  { mod: "ado-prs", title: "Pull requests", about: "Active PRs across all projects", icon: "mods/ado-menu/pr.svg" },
  { mod: "ado-pipelines", title: "Pipelines", about: "Recent runs and their logs", icon: "mods/ado-menu/rocket.svg" },
  { mod: "ado-workitems", title: "Work items", about: "Assigned to me, last 30 days", icon: "mods/ado-menu/workitems.svg" },
  { mod: "ado-standup", title: "Standup", about: "Team's completed work, reviews, blockers, deploys", icon: "mods/ado-menu/standup.svg" },
];

const GLYPH = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
function pretty(chord) {
  return chord.split("-").map((p) => GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join("");
}
function keyFor(mod) {
  const k = keys().find((x) => x.action === `mod.open:${mod}`);
  return k ? pretty(k.keys) : "";
}

export default class AdoMenu extends View {
  pick(name) {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
    run("mod.open", { name });
  }

  render() {
    const t = theme();
    return v_flex().size_full().p(5).gap(1).children(
      ITEMS.map((it) =>
        h_flex().id(`ado-${it.mod}`).gap(10).px(9).py(7).rounded(6).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.pick(it.mod))
          .child(svg(it.icon).size(15).flex_none().text_color(t.muted))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).text_color(t.foreground).truncate().child(it.title))
            .child(div().text_size(11).text_color(t.dim).truncate().child(it.about)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(keyFor(it.mod)))),
    );
  }
}
