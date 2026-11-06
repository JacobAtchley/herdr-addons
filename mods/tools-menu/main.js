// The tab bar's Tools dropdown (my-tabs): the plugins ported from the old
// herdr, each opened the way its key opens it. Key hints come from keys.json.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, keys } from "herdr";

const TOOLS = [
  { mod: "git-glance", title: "Git Glance", about: "Status, diff, branches, stashes", icon: "git" },
  { mod: "git-glance-pane", title: "Git Glance in a pane", about: "Beside the current terminal", icon: "pane" },
  { mod: "project-runner", title: "Project Runner", about: "Run a package.json script", icon: "play" },
];

const GLYPH = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
function pretty(chord) {
  return chord.split("-").map((p) => GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join("");
}
function keyFor(mod) {
  const k = keys().find((x) => x.action === `mod.open:${mod}`);
  return k ? pretty(k.keys) : "";
}

export default class ToolsMenu extends View {
  pick(name) {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
    run("mod.open", { name });
  }

  render() {
    const t = theme();
    return v_flex().size_full().p(5).gap(1).children(
      TOOLS.map((it) =>
        h_flex().id(`tool-${it.mod}`).gap(10).px(9).py(7).rounded(6).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.pick(it.mod))
          .child(svg(`mods/tools-menu/${it.icon}.svg`).size(15).flex_none().text_color(t.muted))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).text_color(t.foreground).truncate().child(it.title))
            .child(div().text_size(11).text_color(t.dim).truncate().child(it.about)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(keyFor(it.mod)))),
    );
  }
}
