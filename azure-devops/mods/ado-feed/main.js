// Feed: what needs a team lead's attention, from Azure DevOps.
//   PRs waiting on his approval that nobody else has reviewed or commented on,
//   his own PRs with feedback still to address, failing builds, and work items newly assigned to him (not in Code Review or
//   Pending QA). Each row has a toggle that resolves it (approving the PR when
//   that applies). Data and state come from feed.py,
//   which keeps a local database; this view only lists, syncs and toggles.
//
// Opens as a dialog (mod.open:ado-feed, cmd-shift-f), or as a pane.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, closeOverlay, openOverlay, run, notify, appHome, setShared } from "herdr";

const SYNC_MS = 120000;
const ICON = (n) => `mods/ado-feed/${n}.svg`;
const KIND_COLOR = { pr: "#9085e9", mine: "#e0a030", build: "#d03b3b", wi: "#3987e5" };
const S = { critical: "#d03b3b" };
const MARKER = "@@ADO-FEED@@\n";
const WINDOWS = [
  { key: "24h", label: "24 hours", empty: "in the last 24 hours" },
  { key: "48h", label: "48 hours", empty: "in the last 48 hours" },
  { key: "1w", label: "1 week", empty: "in the last week" },
];

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
function ago(iso) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Run feed.py and return the parsed object after the marker line.
async function feed(...args) {
  const script = `${appHome()}/mods/ado-feed/feed.py`;
  const r = await exec("python3", ["-I", script, "--home", appHome(), ...args]);
  const out = r.stdout ?? "";
  const i = out.indexOf(MARKER);
  if (i < 0) throw new Error((r.stderr || "feed.py printed nothing").trim().split("\n").pop());
  return JSON.parse(out.slice(i + MARKER.length));
}

export default class Feed extends View {
  init(_props, cx) {
    this.win = readPref("win", "24h");
    if (!WINDOWS.some((w) => w.key === this.win)) this.win = "24h";
    this.resolved = readPref("resolved", "false") === "true";
    this.data = null; // the last list result
    this.sync = null; // the last sync result
    this.fatal = null;
    this.error = null;
    this.loading = false; // a sync is running
    this.busy = new Set(); // row keys with a resolve in flight
    this.syncing = false;
    this.refresh(cx, true);
    cx.timer.every(SYNC_MS, (cx) => this.refresh(cx, false));
  }

  applyCount(d) {
    if (d && typeof d.open === "number") {
      try { setShared("ado.feed.count", d.open); } catch {}
    }
  }

  // list, then (optionally) sync and list again.
  async list() {
    const d = await feed("list", "--window", this.win, ...(this.resolved ? ["--resolved"] : []));
    if (d.fatal) { this.fatal = d.fatal; return; }
    if (d.error) throw new Error(d.error);
    this.fatal = null;
    this.data = d;
    this.applyCount(d);
  }

  refresh(cx, paintFirst) {
    if (this.syncing) return;
    this.syncing = true;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (paintFirst) { await this.list(); cx.notify(); }
        const s = await feed("sync");
        if (s.fatal) { this.fatal = s.fatal; return; }
        if (s.error) throw new Error(s.error);
        this.sync = s;
        this.applyCount(s);
        await this.list();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.syncing = false;
        this.loading = false;
        cx.notify();
      }
    });
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try { await this.list(); this.error = null; } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  toggle(row, cx) {
    if (this.busy.has(row.key)) return;
    this.busy.add(row.key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await feed(row.resolved_at ? "unresolve" : "resolve", row.key);
        const msg = r.fatal ?? r.error;
        if (msg) notify({ title: "Couldn't resolve", body: String(msg), level: "error" });
      } catch (e) {
        notify({ title: "Couldn't resolve", body: String(e?.message ?? e), level: "error" });
      }
      try { await this.list(); } catch (e) { this.error = String(e?.message ?? e); }
      this.busy.delete(row.key);
      cx.notify();
    });
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  browse(url) {
    if (url) exec("open", [url]).catch((e) => notify({ title: "Couldn't open", body: String(e?.message ?? e), level: "error" }));
  }

  // Open the item in its own mod as a dialog on top of this one; its back
  // arrow and Esc return here.
  openRow(row) {
    const ref = row.ref ?? {};
    if ((row.kind === "pr" || row.kind === "mine") && ref.repoId) {
      openOverlay({
        mod: "ado-prs", kind: "dialog", width: 0.94, height: 0.92,
        props: { review: { project: ref.project, repoId: ref.repoId, id: ref.id, returnTo: "Feed" } },
      });
    } else if (row.kind === "build" && ref.build != null) {
      openOverlay({
        mod: "ado-pipelines", kind: "dialog", width: 0.9, height: 0.86,
        props: { project: ref.project, build: ref.build, returnTo: "Feed" },
      });
    } else if (row.kind === "wi" && ref.id != null) {
      openOverlay({
        mod: "ado-workitems", kind: "dialog", width: 0.8, height: 0.8,
        props: { detail: ref.id, returnTo: "Feed" },
      });
    } else {
      this.browse(row.url);
    }
  }

  pill(t, id, label, active, onClick) {
    return div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer().flex_none()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  iconButton(t, id, icon, tip, onClick, spin = false, color = null) {
    let ic = svg(icon).size(14).text_color(color ?? t.muted);
    if (spin) ic = ic.spin(900);
    return div().id(id).p(5).rounded(6).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(ic);
  }

  tip(row) {
    if (row.resolved_at) return "Reopen";
    if (row.action === "approve") return "Approve and resolve";
    if (row.action === "close") return "Close and resolve";
    return "Resolve";
  }

  row(t, row) {
    const id = `row-${row.key.replace(/[^A-Za-z0-9]/g, "-")}`;
    const done = Boolean(row.resolved_at);
    const busy = this.busy.has(row.key);
    const right = done
      ? `resolved ${ago(row.resolved_at)} ago ${row.resolved_by === "me" ? "by you" : "automatically"}`
      : ago(row.event_at);
    const sub = [row.sub, row.event_text].filter(Boolean).join(" · ");
    return h_flex().id(id).px(8).py(6).gap(8).items_center().rounded(6).cursor_pointer()
      .when(done, (el) => el.opacity(0.55))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.openRow(row))
      .child(div().flex_none().w(3).h(30).rounded(2).bg(KIND_COLOR[row.kind] ?? t.border))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).child(row.title ?? ""))
        .child(div().truncate().text_size(11).text_color(t.dim).child(sub)))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(right))
      .child(this.iconButton(t, `${id}-toggle`, ICON(done ? "check-filled" : "check"), this.tip(row),
        (cx) => this.toggle(row, cx), busy, done ? t.dim : null));
  }

  header(t) {
    const d = this.data;
    const upd = ago(d?.last_sync) || (this.sync?.generated ? ago(new Date(this.sync.generated * 1000).toISOString()) : "");
    return h_flex().flex_none().px(16).pt(10).pb(8).gap(12).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg(ICON("feed")).size(16).text_color(t.accent))
        .child(div().text_size(14).font_semibold().child("Feed"))
        .child(div().text_size(12).text_color(t.dim).child(d ? `${d.project} · ${d.team}` : "")))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.background).children(WINDOWS.map((w) =>
        this.pill(t, `win-${w.key}`, w.label, w.key === this.win, (_e, cx) => {
          if (w.key === this.win) return;
          this.win = w.key; writePref("win", w.key); this.reload(cx); cx.notify();
        }))))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.background)
        .child(this.pill(t, "show-resolved", "Show resolved", this.resolved, (_e, cx) => {
          this.resolved = !this.resolved; writePref("resolved", String(this.resolved)); this.reload(cx); cx.notify();
        })))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(this.error ? S.critical : t.dim)
        .child(this.error ? "refresh failed" : this.loading ? "syncing…" : upd ? `updated ${upd} ago` : ""))
      .child(this.iconButton(t, "refresh", ICON("refresh"), "Refresh", (cx) => this.refresh(cx, false), this.loading))
      .when(Boolean(props()?.overlay), (el) => el
        .child(this.iconButton(t, "as-pane", ICON("panel-right"), "Dock as a pane on the right", () => { this.dismiss(); run("pane.split", { direction: "right", mod: "ado-feed" }); }))
        .child(this.iconButton(t, "close", ICON("x"), "Close", () => this.dismiss())));
  }

  center(t, lines) {
    return v_flex().flex_1().items_center().justify_center().gap(6)
      .children(lines.map(([text, color, size], i) => div().text_size(size ?? 12).text_color(color).child(text)));
  }

  render() {
    const t = theme();
    const root = v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).child(this.header(t));
    if (this.fatal) {
      return root.child(this.center(t, [
        ["Couldn't load the feed", S.critical, 13],
        [this.fatal, t.muted],
        ["Try `az login` in a terminal, then refresh.", t.dim],
      ]));
    }
    if (!this.data) {
      return root.child(this.center(t, this.error
        ? [["Couldn't load the feed", S.critical, 13], [this.error, t.muted], ["Try `az login` in a terminal, then refresh.", t.dim]]
        : [["Loading the feed…", t.dim, 13]]));
    }
    const errs = Object.entries(this.sync?.errors ?? {});
    const rows = this.data.rows ?? [];
    const w = WINDOWS.find((x) => x.key === this.win) ?? WINDOWS[0];
    return root.child(div().id("feed-body").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().p(16).gap(8)
        .when(errs.length > 0, (el) => el.child(div().px(12).py(8).rounded(8).bg(S.critical + "22").text_size(12).text_color(t.foreground)
          .child(`Some data didn't load: ${errs.map(([k, v]) => `${k} (${v})`).join("; ")}`)))
        .when(rows.length === 0, (el) => el.child(div().py(24).text_size(13).text_color(t.dim).text_center()
          .child(`Nothing needs you ${w.empty}.`)))
        .child(v_flex().gap(2).children(rows.map((r) => this.row(t, r))))));
  }
}
