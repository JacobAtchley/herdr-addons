// Focus the next pane in the whole window, wrapping across spaces: spaces in
// order, tabs in order within each space, panes in layout order within each
// tab. Built-in pane.go stays inside the current tab. Opened by a key as a
// 1px overlay that does its one job and closes itself.
import { View, div } from "gpui-kit";
import { spaces, panes, focused, props, run, closeOverlay } from "herdr";

const STEP = 1;

export default class PaneCycle extends View {
  init(_props, cx) {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    const all = panes().filter((p) => p.terminal);
    const order = spaces().flatMap((s) => s.tabs.flatMap((t) => all.filter((p) => p.tab === t.id)));
    if (order.length < 2) return;
    const i = order.findIndex((p) => p.pane === focused()?.pane);
    const from = i < 0 ? (STEP > 0 ? -1 : 0) : i;
    run("pane.focus", { pane: order[(from + STEP + order.length) % order.length].pane });
  }

  render(_cx) {
    return div();
  }
}
