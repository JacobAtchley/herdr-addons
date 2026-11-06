// The tab bar's Orchestrator dropdown (my-tabs): Sessions, Approvals and Pull
// requests open the orch dialog on that tab; Dashboard opens the web
// dashboard. Counts come from my-tabs' poller (shared "orch.counts").
// Popup height in my-tabs' orchButton: 52 px per row + 10.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, shared, exec, notify, appHome } from "herdr";
import { readFile } from "fs/promises";

// orchestrator.dashboard (else orchestrator.url) in addons.json, read on click.
async function dashboard() {
  try {
    const o = JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8"))?.orchestrator ?? {};
    if (o.dashboard || o.url) return String(o.dashboard || o.url).replace(/\/+$/, "") + "/";
  } catch { /* defaults */ }
  return "http://localhost:8490/";
}

export const ITEMS = [
  { tab: "sessions", title: "Sessions", about: "Running and recent agent sessions", icon: "mods/orch-menu/sessions.svg" },
  { tab: "approvals", title: "Approvals", about: "Plans and permission asks waiting on you", icon: "mods/orch-menu/approvals.svg" },
  { tab: "prs", title: "Pull requests", about: "Your review queue and your PRs", icon: "mods/orch-menu/pr.svg" },
  { url: true, title: "Dashboard", about: "Open the web dashboard in your browser", icon: "mods/orch-menu/dashboard.svg" },
];

export default class OrchMenu extends View {
  pick(it) {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
    if (it.url) dashboard().then((u) => exec("open", [u])).catch((e) => notify({ title: "Couldn't open the dashboard", body: String(e?.message ?? e), level: "error" }));
    else openOverlay({ mod: "orch", kind: "dialog", width: 0.88, height: 0.86, props: { tab: it.tab } });
  }

  render() {
    const t = theme();
    const counts = shared("orch.counts") ?? {};
    return v_flex().size_full().p(5).gap(1).children(
      ITEMS.map((it) => {
        const n = it.tab ? counts[it.tab] ?? 0 : 0;
        const hot = it.tab === "approvals" && n > 0;
        return h_flex().id(`orch-${it.title}`).gap(10).px(9).py(7).rounded(6).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.pick(it))
          .child(svg(it.icon).size(15).flex_none().text_color(hot ? t.done : t.muted))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).text_color(t.foreground).truncate().child(it.title))
            .child(div().text_size(11).text_color(t.dim).truncate().child(it.about)))
          .when(n > 0, (el) => el.child(div().flex_none().px(6).rounded(8).text_size(11)
            .bg(hot ? t.done : t.selected).text_color(hot ? t.background : t.muted).child(String(n))))
          .when(Boolean(it.url), (el) => el.child(svg("mods/orch/external.svg").size(12).flex_none().text_color(t.dim)));
      }),
    );
  }
}
