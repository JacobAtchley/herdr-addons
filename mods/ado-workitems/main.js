// Azure DevOps work items, across every project. "Mine" shows what is assigned
// to me, grouped by project; "Others" shows everything else (unassigned
// included), grouped by assignee. Items older than MAX_AGE_DAYS are left out:
// by created date (default) or by last update (toggle). One org-level WIQL
// query, then the fields in batches of 200 (`az rest`, using the az login).
//
// A separate "#id" box looks one work item up directly, whatever its age,
// assignee or state. Clicking a row opens Details (detail.js: the whole item, rich
// fields rendered, editable), Refine (a new herdr tab with Claude Code primed
// to refine the item) and Open in browser.
//
// Opens as a dialog (mod.open:ado-workitems), or as a pane beside a shell.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, props, closeOverlay, run, notify, home, appHome } from "herdr";
import { readFile } from "fs/promises";
import { get, post, defaultOrg, ago, lastSegment, isDone, toItem, typeColor, stateColor, FIELDS } from "./ado.js";
import { Detail, pruneImages } from "./detail.js";

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

// The folder Claude Code tabs open in: claude.folder ("~/…" allowed), else home.
async function claudeFolder() {
  const f = (await addonSettings()).claude?.folder;
  return f ? String(f).replace(/^~(?=\/|$)/, home()) : home();
}


const MAX_AGE_DAYS = 30;
const REFRESH_MS = 120000;
// "Others" can be over a thousand items: render at most this many rows.
const MAX_ROWS = 400;
const BATCH_CONCURRENCY = 4;
const AGE = [
  { key: "created", label: "Created" },
  { key: "changed", label: "Updated" },
];
const SCOPES = [
  { key: "mine", label: "Mine", tip: "Assigned to me" },
  { key: "others", label: "Others", tip: "Not assigned to me (unassigned included)" },
];
const UNASSIGNED = "Unassigned";

export default class AdoWorkItems extends View {
  init(_props, cx) {
    // The image viewer (detail.js zoom): just the picture.
    const p = { ...(props() ?? {}), ...(_props ?? {}) };
    if (p.image) { this.viewer = p; return; }
    pruneImages();
    this.org = null;
    this.scope = localStorage.getItem("scope") === "others" ? "others" : "mine";
    // Per scope: { items, error, loading, fetched }.
    this.data = { mine: {}, others: {} };
    this.age = localStorage.getItem("age") ?? "created";
    this.showDone = localStorage.getItem("showDone") === "true";
    this.folded = {};
    this.search = InputState.new({ placeholder: "Filter by title, id, type, state, tag, person…" });
    this.search.on("change", (_e, cx) => cx.notify());
    // Lookup by id: { id, loading, item, error }.
    this.lookup = null;
    this.idBox = InputState.new({ placeholder: "Work item id ↵" });
    this.idBox.on("submit", (_e, cx) => this.find(cx));
    this.idBox.on("change", (_e, cx) => {
      if (!this.idBox.value().trim() && this.lookup) { this.lookup = null; cx.notify(); }
    });
    // The details view, when open: replaces the list. props.detail opens one.
    this.detail = null;
    const want = Number(_props?.detail ?? props()?.detail);
    if (want) this.openDetail(want, cx);
    this.refresh(cx);
    // The hidden scope refreshes when it's switched back to, if it's stale.
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  get cur() { return this.data[this.scope]; }

  async ensureOrg() {
    if (!this.org) this.org = (await addonSettings()).ado?.org || (await defaultOrg());
  }

  openDetail(id, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.ensureOrg();
        this.detail = new Detail(this.detailHost(), id, cx);
      } catch (e) {
        notify({ title: "Couldn't open work item", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  detailHost() {
    const self = this;
    return {
      get org() { return self.org; },
      back(cx) { self.detail = null; cx.notify(); },
      openDetail: (id, cx) => this.openDetail(id, cx),
      refine: (it) => this.refine(it),
      // A save: patch the item in whichever lists hold it.
      updated: (fields) => {
        const it = toItem(fields);
        for (const d of Object.values(this.data)) {
          const i = (d.items ?? []).findIndex((x) => x.id === it.id);
          if (i >= 0) d.items[i] = it;
        }
        if (this.lookup?.item?.id === it.id) this.lookup.item = it;
      },
      chrome: (t) => this.chrome(t, { detail: this.detail?.id }),
    };
  }

  // Dock / close, at the right of either header.
  chrome(t, paneProps) {
    if (!props()?.overlay) return [];
    return [
      this.iconButton(t, "as-pane", "mods/ado-workitems/panel-right.svg", "Open beside this pane", () => {
        this.dismiss();
        run("pane.split", { direction: "right", mod: "ado-workitems", props: paneProps ?? {} });
      }),
      this.iconButton(t, "close", "mods/ado-workitems/x.svg", "Close", () => this.dismiss()),
    ];
  }

  refresh(cx) {
    const scope = this.scope;
    const d = this.data[scope];
    if (d.loading) return;
    d.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.ensureOrg();
        const api = `https://dev.azure.com/${this.org}/_apis/wit`;
        const who = scope === "mine" ? "[System.AssignedTo] = @Me" : "[System.AssignedTo] <> @Me";
        // Both age rules in one query; the toggle filters locally.
        const wiql = `SELECT [System.Id] FROM workitems WHERE ${who} AND ` +
          `([System.CreatedDate] >= @Today - ${MAX_AGE_DAYS} OR [System.ChangedDate] >= @Today - ${MAX_AGE_DAYS}) ORDER BY [System.ChangedDate] DESC`;
        const ids = (await post(`${api}/wiql?api-version=7.1`, { query: wiql }, "workItems[].id")) ?? [];
        const chunks = [];
        for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
        const results = new Array(chunks.length);
        let next = 0;
        const worker = async () => {
          while (next < chunks.length) {
            const k = next++;
            const out = await post(`${api}/workitemsbatch?api-version=7.1`, { ids: chunks[k], fields: FIELDS }, "value[].fields");
            results[k] = (out ?? []).map(toItem);
          }
        };
        await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, worker));
        d.items = results.flat();
        d.fetched = Date.now();
        d.error = null;
      } catch (e) {
        d.error = String(e?.message ?? e);
      } finally {
        d.loading = false;
        cx.notify();
      }
    });
  }

  setScope(scope, cx) {
    if (this.scope === scope) return;
    this.scope = scope;
    localStorage.setItem("scope", scope);
    const d = this.cur;
    if (!d.items || Date.now() - (d.fetched ?? 0) > REFRESH_MS) this.refresh(cx);
    cx.notify();
  }

  find(cx) {
    const raw = this.idBox.value().trim().replace(/^#/, "");
    if (!raw) { this.lookup = null; cx.notify(); return; }
    if (!/^\d+$/.test(raw)) { this.lookup = { id: raw, error: "Enter a numeric work item id" }; cx.notify(); return; }
    const id = Number(raw);
    this.lookup = { id, loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.ensureOrg();
        const out = await get(`https://dev.azure.com/${this.org}/_apis/wit/workitems/${id}?fields=${FIELDS.join(",")}&api-version=7.1`, "fields");
        if (this.lookup?.id === id) this.lookup = { id, item: toItem({ ...out, "System.Id": id }) };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (this.lookup?.id === id) this.lookup = { id, error: /TF401232/.test(msg) ? `#${id} doesn't exist, or you can't read it` : msg };
      } finally {
        cx.notify();
      }
    });
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  url(it) {
    return `https://dev.azure.com/${this.org}/${encodeURIComponent(it.project)}/_workitems/edit/${it.id}`;
  }

  open(it) {
    exec("open", [this.url(it)]).catch((e) => notify({ title: "Couldn't open work item", body: String(e?.message ?? e), level: "error" }));
  }

  async refine(it) {
    const task = [
      `Help me refine Azure DevOps work item #${it.id} so the team can pick it up.`,
      `Org https://dev.azure.com/${this.org}, project ${it.project}. ${it.type ?? "Work item"} "${it.title}", state ${it.state ?? "?"}, ` +
        `assigned to ${it.assignee ?? "nobody"}, area ${it.area ?? "?"}, iteration ${it.iteration ?? "?"}. ${this.url(it)}`,
      `Read it in full with the azure-devops MCP tools (description, acceptance criteria, repro steps, comments, and its parent/child/related links), ` +
        `and look at the relevant code in this folder if that helps.`,
      `Then give me: a short summary of the problem and the goal; gaps, ambiguities and assumptions; open questions for the PO or team; ` +
        `proposed acceptance criteria (Given/When/Then where it fits); a suggested task breakdown; risks and dependencies; and a rough size.`,
      `Work through it with me. Don't change anything in Azure DevOps until I approve the exact wording.`,
    ].join("\n");
    try {
      run("tab.new", { name: `Refine #${it.id}`, folder: await claudeFolder(), argv: ["claude", "--model", await claudeModel("refine")], task });
      this.dismiss();
    } catch (e) {
      notify({ title: "Couldn't start refinement", body: String(e?.message ?? e), level: "error" });
    }
  }

  done(it) {
    return isDone(it.state);
  }

  recent(it) {
    const when = this.age === "changed" ? it.changed : it.created;
    return Date.now() - Date.parse(when) <= MAX_AGE_DAYS * 86400000;
  }

  visible() {
    const q = this.search.value().trim().toLowerCase();
    return (this.cur.items ?? []).filter((it) => {
      if (!this.recent(it)) return false;
      if (!this.showDone && this.done(it)) return false;
      if (!q) return true;
      return [it.title, String(it.id), it.type, it.state, it.assignee, lastSegment(it.iteration), ...it.tags]
        .some((s) => (s ?? "").toLowerCase().includes(q));
    });
  }

  // ---- pieces

  pill(t, id, label, active, onClick, tip) {
    let el = div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
    if (tip) el = el.tooltip(tip);
    return el;
  }

  iconButton(t, id, icon, tip, onClick, spin = false) {
    let ic = svg(icon).size(14).text_color(t.muted);
    if (spin) ic = ic.spin(900);
    return div().id(id).p(5).rounded(6).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(ic);
  }

  action(t, id, icon, tip, fn) {
    return div().id(id).p(5).rounded(6).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); })
      .child(svg(`mods/ado-workitems/${icon}`).size(14).text_color(t.muted));
  }

  row(t, it, key = "wi", showWho = this.scope === "others") {
    const tc = typeColor(t, it.type);
    const sc = stateColor(t, it.state);
    const when = this.age === "changed" ? it.changed : it.created;
    return h_flex().id(`${key}-${it.id}`).px(12).py(7).gap(12).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openDetail(it.id, cx))
      .child(div().flex_none().w(3).h(30).rounded(2).bg(tc))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`#${it.id}`))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(this.done(it) ? t.muted : t.foreground).child(it.title ?? "")))
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().text_size(11.5).text_color(tc).child(it.type ?? ""))
          .when(showWho, (el) => el.child(div().flex_none().text_size(11.5).text_color(it.assignee ? t.muted : t.dim).child(`· ${it.assignee ?? UNASSIGNED}`)))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`· ${lastSegment(it.iteration)}`))
          .children(it.tags.slice(0, 4).map((tag) => div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(tag)))))
      .child(div().flex_none().w(30).text_size(11.5).text_color(it.priority === 1 ? t.ansi1 : t.dim).child(it.priority != null ? `P${it.priority}` : ""))
      .child(h_flex().flex_none().w(120).justify_end()
        .child(div().px(7).py(1).rounded(10).border(1).border_color(sc).text_size(11).text_color(sc).truncate().child(it.state ?? "")))
      .child(div().id(`${key}-age-${it.id}`).flex_none().w(36).text_size(11.5).text_color(t.dim)
        .tooltip(`Created ${it.created?.slice(0, 10)} · updated ${it.changed?.slice(0, 10)}`)
        .child(ago(when)))
      .child(h_flex().flex_none().gap(2)
        .child(this.action(t, `${key}-in-${it.id}`, "info.svg", "Details", (cx) => this.openDetail(it.id, cx)))
        .child(this.action(t, `${key}-rf-${it.id}`, "refine.svg", "Refine with Claude Code", () => this.refine(it)))
        .child(this.action(t, `${key}-op-${it.id}`, "external.svg", "Open in browser", () => this.open(it))));
  }

  header(t, shown) {
    const d = this.cur;
    const recent = (d.items ?? []).filter((it) => this.recent(it));
    const doneCount = recent.filter((it) => this.done(it)).length;
    const status = d.error ? "fetch failed" : d.loading ? "loading…" : d.fetched
      ? (Date.now() - d.fetched < 60000 ? "updated just now" : `updated ${ago(new Date(d.fetched).toISOString())} ago`) : "";
    const count = (s) => {
      const items = this.data[s].items;
      return items ? ` ${items.filter((it) => this.recent(it) && (this.showDone || !this.done(it))).length}` : "";
    };
    return h_flex().flex_none().px(16).py(10).gap(12).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/ado-workitems/board.svg").size(16).text_color(t.accent))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Work items"))
        .child(div().text_size(12).text_color(t.dim).child(this.org ? `${this.org} · ${shown}` : "")))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
        SCOPES.map((s) => this.pill(t, `scope-${s.key}`, `${s.label}${count(s.key)}`, this.scope === s.key, (_e, cx) => this.setScope(s.key, cx), s.tip))))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11.5).text_color(t.dim).child(`Last ${MAX_AGE_DAYS}d by`))
        .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
          AGE.map((a) => this.pill(t, `age-${a.key}`, a.label, this.age === a.key, (_e, cx) => {
            this.age = a.key;
            localStorage.setItem("age", a.key);
            cx.notify();
          })))))
      .child(this.pill(t, "show-done", `Closed ${doneCount}`, this.showDone, (_e, cx) => {
        this.showDone = !this.showDone;
        localStorage.setItem("showDone", String(this.showDone));
        cx.notify();
      }, this.showDone ? "Hide finished items" : "Show finished items"))
      .child(h_flex().flex_1().min_w(180).h(26).px(8).rounded(6).bg(t.background).border(1).border_color(t.input)
        .child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().id("id-box").flex_none().w(150).h(26).px(8).gap(6).items_center().rounded(6).bg(t.background).border(1)
        .border_color(this.lookup ? t.accent : t.input).tooltip("Look up any work item by id (Enter)")
        .child(svg("mods/ado-workitems/hash.svg").size(12).flex_none().text_color(t.dim))
        .child(Input.new(this.idBox).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(div().text_size(11).text_color(d.error ? t.blocked : t.dim).child(status))
      .child(this.iconButton(t, "refresh", "mods/ado-workitems/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx), d.loading))
      .children(this.chrome(t));
  }

  // The id lookup's result, pinned above the list.
  lookupCard(t) {
    const l = this.lookup;
    const close = this.iconButton(t, "lookup-x", "mods/ado-workitems/x.svg", "Clear lookup", (_e, cx) => {
      this.lookup = null;
      this.idBox.set_value("");
      cx.notify();
    });
    const body = l.item ? this.row(t, l.item, "lk", true)
      : div().px(12).py(9).text_size(12).text_color(l.error ? t.blocked : t.dim).child(l.error ?? `Looking up #${l.id}…`);
    return v_flex().flex_none().mx(8).mt(8).p(4).rounded(8).border(1).border_color(t.border).bg(t.raised)
      .child(h_flex().px(8).pt(2).gap(8).items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(`Lookup #${l.id}`))
        .child(close))
      .child(body);
  }

  body(t, list) {
    const d = this.cur;
    const center = (...kids) => v_flex().flex_1().items_center().justify_center().gap(6).p(24).children(kids);
    if (d.error && !d.items) {
      return center(
        div().text_size(13).text_color(t.blocked).child("Couldn't load work items"),
        div().text_size(12).text_color(t.muted).child(d.error),
        div().text_size(12).text_color(t.dim).child("Try `az login` in a terminal, then refresh."));
    }
    if (!d.items) return center(div().text_size(12).text_color(t.dim).child(this.scope === "others" ? "Loading everyone else's work items…" : "Loading…"));
    if (!list.length) {
      return center(div().text_size(12).text_color(t.dim).child(this.scope === "others"
        ? `No matching work items from the last ${MAX_AGE_DAYS} days.`
        : `Nothing assigned to you from the last ${MAX_AGE_DAYS} days.`));
    }

    // Mine: by project. Others: by assignee, unassigned first.
    const byWho = this.scope === "others";
    const groups = new Map();
    for (const it of list) {
      const g = byWho ? it.assignee ?? UNASSIGNED : it.project;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    const key = this.age === "changed" ? "changed" : "created";
    const sorted = [...groups.entries()].sort((a, b) =>
      (byWho ? (b[0] === UNASSIGNED) - (a[0] === UNASSIGNED) : 0) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    let budget = MAX_ROWS;
    let hidden = 0;
    const groupEls = sorted.map(([group, items]) => {
      const fk = `${this.scope}:${group}`;
      const folded = this.folded[fk];
      items.sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]));
      const shown = folded ? [] : items.slice(0, Math.max(0, budget));
      if (!folded) hidden += items.length - shown.length;
      budget -= shown.length;
      return v_flex().flex_none().gap(1)
        .child(h_flex().id(`g-${fk}`).px(8).py(4).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.folded[fk] = !folded; cx.notify(); })
          .child(svg(folded ? "mods/ado-workitems/chev-right.svg" : "mods/ado-workitems/chev-down.svg").size(12).text_color(t.dim))
          .child(div().text_size(12).font_semibold().text_color(t.muted).child(group))
          .child(div().text_size(11).text_color(t.dim).child(String(items.length))))
        .children(shown.map((it) => this.row(t, it)));
    });
    return div().id("list").flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().p(8).gap(6).children(groupEls)
      .when(hidden > 0, (el) => el.child(div().px(12).py(8).text_size(11.5).text_color(t.dim)
        .child(`${hidden} more not shown. Narrow it with the filter or fold some groups.`))));
  }

  renderViewer(t) {
    const v = this.viewer;
    return v_flex().size_full().bg(t.background)
      .child(h_flex().flex_none().px(14).py(8).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(v.title ?? "Image"))
        .child(div().text_size(11.5).text_color(t.dim).child(v.w && v.h ? `${v.w} × ${v.h}` : ""))
        .child(h_flex().id("v-preview").gap(6).px(10).py(4).rounded(6).border(1).border_color(t.border).items_center()
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => exec("open", [v.original]).catch((e) => notify({ title: "Couldn't open", body: String(e?.message ?? e), level: "error" })))
          .child(svg("mods/ado-workitems/external.svg").size(13).text_color(t.muted)).child("Open in Preview"))
        .child(this.iconButton(t, "v-close", "mods/ado-workitems/x.svg", "Close (Esc)", () => this.dismiss())))
      .child(div().id("v-img").flex_1().min_h(0).p(12).cursor_pointer().tooltip("Click to close")
        .on_click(() => this.dismiss())
        .child(image(v.image).size_full()));
  }

  render() {
    const t = theme();
    if (this.viewer) return this.renderViewer(t);
    if (this.detail) {
      return v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).child(this.detail.render(t));
    }
    const list = this.visible();
    return v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground)
      .child(this.header(t, list.length))
      .when(Boolean(this.lookup), (el) => el.child(this.lookupCard(t)))
      .child(this.body(t, list));
  }
}
