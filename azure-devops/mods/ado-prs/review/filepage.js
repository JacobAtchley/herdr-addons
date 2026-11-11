// The review's file page: toolbar (diff style, range), the highlighted diff
// in a virtual list, threads inline under their rows, outdated threads and
// unplaced drafts at the top, line/range comment composers.
//
// list() rows can't own handlers, so the list has one on_item_click; a
// mouse-down on the list's wrapper records x (and shift) first, and the click
// is mapped with the pure geometry in rows.js: line-number gutters start a
// comment, fixed-width action buttons are hit-tested by x.

import { div, svg, list } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextView, Scrollbar } from "gpui-base";
import { theme, settings } from "herdr";
import { diffLines, splitLines } from "./diff.js";
import { highlightFile, batAvailable } from "./highlight.js";
import { isDarkTheme } from "./ansi.js";
import { placeThreads, placeDrafts } from "./anchor.js";
import { draftKey } from "./drafts.js";
import {
  tooLarge, sinceLastLook, displayItems, numWidth, gutterWidth, lineAt, actionAt, selectLines, lineLengths, draftFits,
  MARK_W, ACTION_W, ACTION_GAP, wordChunks,
} from "./rows.js";
import { changeLook, targetLabel, ago } from "./summary.js";
import { ICON, button, iconButton, badge, note, centered } from "./ui/parts.js";

const STYLE_KEY = "review.diffStyle";
const CARD_BORDER = 2;
const CARD_PAD = 10;
const SPLIT_INDENT = 12;
const TOP_INDENT = 12;

const msg = (e) => String(e?.message ?? e);
const tint = (c, a) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c + a : c);

export class FilePages {
  constructor(review) {
    this.rv = review;
    this.cache = new Map(); // `${path}|${from}|${to}` → file state
    let style = null;
    try { style = localStorage.getItem(STYLE_KEY); } catch { /* default */ }
    this.style = style === "split" ? "split" : "unified";
    this.anchor = null; // {path, side, line}: the last plain-clicked line
    this.open = new Set(); // draft keys of line composers opened on this visit
    this.down = { x: -1, width: 0, shift: false };
    this.keyed = new Map(); // list item key → what a click on it means (rebuilt each render)
    this.bat = true;
    this.wantDark = null;
  }

  stateKey(path, range) {
    return `${path}|${range?.from ?? ""}|${range?.to ?? ""}`;
  }

  current() {
    const rv = this.rv;
    if (!rv.range || rv.page === "overview") return null;
    return this.cache.get(this.stateKey(rv.page, rv.range)) ?? null;
  }

  // Load the shown file's contents for the current range (no-op when cached).
  ensure(cx) {
    const rv = this.rv;
    if (rv.page === "overview" || !rv.range || !rv.files) return;
    const file = rv.files.find((f) => f.path === rv.page);
    if (!file) return;
    const key = this.stateKey(file.path, rv.range);
    const cached = this.cache.get(key);
    if (cached && !cached.error) return; // a failed load is retried
    const range = { ...rv.range };
    const st = { key, path: file.path, file, range, loading: true, error: null, shown: new Set(), shownVer: 0, memo: null };
    this.cache.set(key, st);
    // Reopen boxes for this file's saved drafts.
    for (const d of rv.drafts.list(rv.pk)) {
      if (d.target?.file === file.path && !rv.boxes.has(d.key)) rv.composer(d.key, d.target, cx);
    }
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const c = await rv.provider.getFileContents(rv.ref, file, range);
        st.binary = c.binary;
        st.large = !c.binary && (tooLarge(c.old) || tooLarge(c.new));
        if (!st.binary && !st.large) {
          st.old = c.old ?? "";
          st.new = c.new ?? "";
          st.rows = diffLines(splitLines(st.old), splitLines(st.new));
          st.numW = numWidth(st.rows.reduce((m, r) => Math.max(m, r.oldNo ?? 0, r.newNo ?? 0), 1));
        }
      } catch (e) {
        st.error = msg(e); // retried by the next ensure() (refresh, revisit)
      } finally {
        st.loading = false;
        cx.notify();
      }
      if (st.rows) await this.highlight(cx, st);
    });
  }

  async highlight(cx, st) {
    const dark = this.wantDark ?? isDarkTheme(theme());
    st.hlFor = dark;
    const oldPath = st.file.oldPath ?? st.path;
    const [o, n] = await Promise.all([
      st.old ? highlightFile(oldPath, st.old, dark) : Promise.resolve([]),
      st.new ? highlightFile(st.path, st.new, dark) : Promise.resolve([]),
    ]);
    if (st.hlFor !== dark) return; // a newer theme switch started another pass
    st.hl = { old: o, new: n };
    if ((st.old && !o) || (st.new && !n)) this.bat = await batAvailable();
    cx.notify();
  }

  // Timer tick: re-highlight the shown file after a light/dark switch.
  checkTheme(cx) {
    const st = this.current();
    if (!st?.rows || this.wantDark == null || st.hlFor === this.wantDark) return;
    this.highlight(cx, st);
  }

  setStyle(cx, style) {
    this.style = style;
    try { localStorage.setItem(STYLE_KEY, style); } catch { /* not persisted */ }
    cx.notify();
  }

  // ---- clicks

  onDown(e) {
    const x = e.local_position?.x ?? (e.bounds ? e.position.x - e.bounds.x : -1);
    this.down = { x, width: e.bounds?.width ?? 0, shift: !!e.modifiers?.shift };
  }

  onItem(key, cx) {
    const it = this.keyed.get(key);
    const st = this.current();
    if (!it || !st) return;
    const rv = this.rv;
    const { x, width, shift } = this.down;
    if (it.kind === "line") {
      const hit = lineAt(it.item, x, { mode: this.style, width, numW: st.numW });
      if (hit) this.startComment(cx, st, hit, shift);
    } else if (it.kind === "gap") {
      for (let i = it.item.start; i < it.item.end; i++) st.shown.add(i);
      st.shownVer++;
      cx.notify();
    } else if (it.kind === "head") {
      if (it.thread.status !== "resolved") return;
      if (rv.expanded.has(it.thread.id)) rv.expanded.delete(it.thread.id); else rv.expanded.add(it.thread.id);
      cx.notify();
    } else if (it.kind === "actions") {
      const a = actionAt(x, this.origin(it.side, width, it.top), it.actions.map((b) => b.id));
      const b = it.actions.find((y) => y.id === a);
      if (b && !b.disabled) b.run(cx);
    }
  }

  // Left edge (list pixels) of the buttons inside a card on `side`.
  origin(side, width, top) {
    const st = this.current();
    let base;
    if (top || !st) base = TOP_INDENT;
    else if (this.style === "split") base = (side === "right" ? width / 2 : 0) + SPLIT_INDENT;
    else base = gutterWidth("unified", st.numW) + 4;
    return base + CARD_BORDER + CARD_PAD;
  }

  startComment(cx, st, hit, shift) {
    const rv = this.rv;
    const path = st.path;
    const anchor = this.anchor?.path === path ? this.anchor : null;
    const sel = selectLines(anchor, hit, shift);
    const range = { from: st.range.from ?? null, to: st.range.to };
    const target = { file: path, ...sel, range };
    const key = draftKey(target);
    if (sel.endLine != null && anchor) {
      // Turn the anchor's single-line composer into the range, keeping its text.
      const oldKey = draftKey({ file: path, side: anchor.side, line: anchor.line, range });
      const text = rv.boxes.get(oldKey)?.state.value() ?? rv.drafts.get(oldKey, rv.pk)?.body ?? "";
      if (oldKey !== key && text && !rv.drafts.get(key, rv.pk)) rv.drafts.set(key, target, text, rv.pk);
      if (oldKey !== key && !rv.busy.has(`post:${oldKey}`)) {
        rv.drafts.delete(oldKey, { pr: rv.pk, ifBody: text || undefined });
        this.open.delete(oldKey);
        rv.dropBox(oldKey);
      }
    } else {
      this.anchor = { path, side: hit.side, line: hit.line };
    }
    if (!rv.boxes.has(key)) rv.composer(key, target, cx);
    this.open.add(key);
    rv.boxes.get(key).state.focus();
    cx.notify();
  }

  postLine(cx, key) {
    const rv = this.rv;
    const st = this.current();
    const box = rv.boxes.get(key);
    const body = box?.state.value().trim();
    if (!body || !st?.rows) return;
    const t = box.target;
    if (!draftFits(t, st.range)) return;
    const lens = lineLengths(st.rows, t.side, t.line, t.endLine);
    const target = { file: t.file, side: t.side, line: t.line, endLine: t.endLine, ...lens };
    const range = st.range;
    rv.write(cx, `post:${key}`, () => rv.provider.addThread(rv.ref, { target, body, range, file: st.file }), () => {
      if (rv.clearBox(key, body)) this.open.delete(key);
    });
  }

  cancelLine(cx, key) {
    this.open.delete(key);
    cx.notify();
  }

  discard(cx, key) {
    this.rv.drafts.delete(key, { pr: this.rv.pk });
    this.open.delete(key);
    this.rv.dropBox(key);
    cx.notify();
  }

  // ---- toolbar

  toolbar(t, path, st) {
    const rv = this.rv;
    const f = (rv.files ?? []).find((x) => x.path === path);
    const since = sinceLastLook(rv.lastLook, rv.pr?.versions);
    const seg = (id, label, on, onClick, { disabled = false, tip } = {}) => div().id(id).flex_none().px(10).py(3).text_size(11.5)
      .text_color(on ? t.foreground : disabled ? t.dim : t.muted)
      .when(on, (el) => el.bg(t.selected).font_semibold())
      .when(!disabled && !on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(label);
    const group = (...kids) => h_flex().flex_none().rounded(6).border(1).border_color(t.border).overflow_hidden().children(kids);
    const url = rv.pr ? rv.provider.fileUrl(rv.pr, path) : null;
    return v_flex().flex_none().px(16).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .when(Boolean(f), (el) => el.child(badge(t, f.change.toUpperCase(), t[changeLook(f.change).color])))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(path))
        .when(Boolean(url), (el) => el.child(iconButton(t, "fp-open", "external", "Open this file in the browser", () => rv.browse(url)))))
      .when(Boolean(f?.oldPath), (el) => el.child(note(t, `Renamed from ${f.oldPath}`)))
      .child(h_flex().gap(10).items_center().flex_wrap()
        .child(group(
          seg("fp-unified", "Unified", this.style === "unified", (_e, cx) => this.setStyle(cx, "unified")),
          seg("fp-split", "Split", this.style === "split", (_e, cx) => this.setStyle(cx, "split"))))
        .child(group(
          seg("fp-all", "All changes", rv.rangeMode !== "since", (_e, cx) => rv.setRangeMode(cx, "all"), { tip: "Target branch vs. the latest push" }),
          seg("fp-since", "Since last look", rv.rangeMode === "since", (_e, cx) => rv.setRangeMode(cx, "since"),
            { disabled: !since.available, tip: since.reason })))
        .when(!this.bat, (el) => el.child(note(t, "Install bat for syntax highlighting (brew install bat)")))
        .when(Boolean(st?.rows && !st.hl), (el) => el.child(note(t, "Highlighting…"))));
  }

  // ---- render

  render(t, path) {
    const rv = this.rv;
    this.wantDark = isDarkTheme(t);
    const st = rv.range ? this.cache.get(this.stateKey(path, rv.range)) : null;
    let body;
    const url = rv.pr ? rv.provider.fileUrl(rv.pr, path) : null;
    const browserBtn = url ? button(t, "fp-browse", "Open in browser", () => rv.browse(url)) : null;
    const inRange = !rv.files || rv.files.some((f) => f.path === path);
    if (!st && !inRange) body = centered(note(t, "Not changed in this range"));
    else if (!st || st.loading) body = centered(note(t, "Loading diff…"));
    else if (st.error) body = centered(note(t, `Couldn't load this file: ${st.error}`, t.blocked));
    else if (st.binary) body = centered(note(t, "Binary file — open in browser"), browserBtn);
    else if (st.large) body = centered(note(t, "Too large to show — open in browser"), browserBtn);
    else body = this.diff(t, st);
    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(this.toolbar(t, path, st))
      .child(body);
  }

  diff(t, st) {
    const rv = this.rv;
    const path = st.path;
    const range = st.range;
    const fileThreads = (rv.threads ?? []).filter((th) => th.file?.path === path);
    const placedT = placeThreads(st.rows, fileThreads, path);
    // Composers: saved drafts for this file plus empty ones opened this visit.
    const byKey = new Map();
    for (const d of rv.drafts.list(rv.pk)) if (d.target?.file === path) byKey.set(d.key, { key: d.key, target: d.target, body: d.body });
    for (const k of this.open) {
      const b = rv.boxes.get(k);
      if (b && b.target?.file === path && !byKey.has(k)) byKey.set(k, { key: k, target: b.target, body: "" });
    }
    const fits = [...byKey.values()].filter((d) => draftFits(d.target, range));
    const unfit = [...byKey.values()].filter((d) => !draftFits(d.target, range));
    const placedD = placeDrafts(st.rows, fits, path);
    const unplaced = [...placedD.outdated, ...unfit];

    const pinned = new Set([...placedT.byRow.keys(), ...placedD.byRow.keys()]);
    const sig = `${this.style}|${[...pinned].sort((a, b) => a - b).join(",")}|${st.shownVer}`;
    if (st.memo?.sig !== sig) st.memo = { sig, items: displayItems(st.rows, { mode: this.style, pinned, shown: st.shown }) };

    // Rows inside open composers' ranges get a selection tint.
    const selected = new Set();
    for (const d of byKey.values()) {
      for (let n = d.target.line; n <= (d.target.endLine ?? d.target.line); n++) selected.add(`${d.target.side}:${n}`);
    }

    const out = []; // {key, render: () => Element, click?}
    const keyed = new Map();
    const push = (key, render, click) => { out.push({ key, render }); if (click) keyed.set(key, click); };

    // Top: outdated threads and unplaced drafts.
    if (placedT.outdated.length) {
      push("out-h", () => this.sectionRow(t, "Outdated comments", "Their lines don't exist in this diff"));
      for (const th of placedT.outdated) this.threadItems(t, th, null, true, push);
    }
    if (unplaced.length) {
      push("ud-h", () => this.sectionRow(t, "Unplaced drafts", "Their lines no longer exist in this diff (or were written against another base); not posted"));
      for (const d of unplaced) this.unplacedItems(t, d, push);
    }
    if (!st.rows.length) {
      push("empty", () => div().px(16).py(12).child(note(t, st.file.change === "rename" ? "Renamed without content changes." : "No changes in this range.")));
    }

    const font = settings().font_family;
    const ctx = { t, st, font, selected };
    for (const item of st.memo.items) {
      if (item.type === "row") {
        push(`r:${item.idx}`, () => this.unifiedRow(ctx, item.row), { kind: "line", item });
      } else if (item.type === "pair") {
        push(`p:${item.left?.idx ?? ""}:${item.right?.idx ?? ""}`, () => this.splitRow(ctx, item), { kind: "line", item });
      } else if (item.type === "gap") {
        push(`g:${item.start}`, () => this.gapRow(t, item), { kind: "gap", item });
      } else if (item.type === "attach") {
        for (const th of placedT.byRow.get(item.idx) ?? []) this.threadItems(t, th, th.file.side, false, push);
        for (const d of placedD.byRow.get(item.idx) ?? []) this.composerItems(t, d, false, push);
      }
    }
    this.keyed = keyed;

    const id = `fp-list-${st.key}-${this.style}`;
    return v_flex().relative().flex_1().min_h(0).bg(t.background)
      .on_mouse_down("left", (e) => this.onDown(e))
      .child(list(id, out.length, (i) => out[i].key, (i) => out[i].render())
        .on_item_click((key, cx) => this.onItem(key, cx))
        .size_full())
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  // ---- rows

  spans(ctx, side, no, text) {
    const { t, st } = ctx;
    const hl = st.hl?.[side === "left" ? "old" : "new"]?.[no - 1];
    const chunks = wordChunks(hl && hl.length ? hl : [{ text, color: null, bold: false }]);
    const kids = chunks.length
      ? chunks.map((s) => {
          let el = div().flex_shrink_1().min_w(0).text_color(this.color(t, s.color)).child(s.text);
          if (s.bold) el = el.font_semibold();
          return el;
        })
      : [div().child(" ")];
    return h_flex().flex_1().min_w(0).flex_wrap().items_start().children(kids);
  }

  color(t, c) {
    if (!c) return t.foreground;
    if (c.startsWith("#")) return c;
    return t[c] ?? t.foreground;
  }

  num(ctx, n, sel) {
    return div().flex_none().w(ctx.st.numW).pr(8).text_right().cursor_pointer()
      .text_color(sel ? ctx.t.foreground : ctx.t.dim).child(n == null ? "" : String(n));
  }

  look(t, kind) {
    if (kind === "add") return { bg: tint(t.ansi2, "24"), mark: "+", markColor: t.ansi2 };
    if (kind === "del") return { bg: tint(t.ansi1, "24"), mark: "-", markColor: t.ansi1 };
    return { bg: null, mark: "", markColor: t.dim };
  }

  unifiedRow(ctx, r) {
    const { t, font, selected } = ctx;
    const l = this.look(t, r.kind);
    const side = r.kind === "del" ? "left" : "right";
    const no = side === "left" ? r.oldNo : r.newNo;
    const sel = selected.has(`${side}:${no}`);
    return h_flex().w_full().items_start().font_family(font).text_size(12)
      .when(Boolean(l.bg), (el) => el.bg(l.bg))
      .when(sel, (el) => el.bg(t.selection ?? t.selected))
      .child(this.num(ctx, r.oldNo, sel))
      .child(this.num(ctx, r.newNo, sel))
      .child(div().flex_none().w(MARK_W).cursor_pointer().text_color(l.markColor).child(l.mark || " "))
      .child(this.spans(ctx, r.kind === "del" ? "left" : "right", r.kind === "del" ? r.oldNo : r.newNo, r.text));
  }

  half(ctx, cell, side) {
    const { t, selected } = ctx;
    if (!cell) return div().flex_1().min_w(0).h_full().bg(t.raised);
    const r = cell.row;
    const l = this.look(t, r.kind);
    const no = side === "left" ? r.oldNo : r.newNo;
    const sel = selected.has(`${side}:${no}`);
    return h_flex().flex_1().min_w(0).h_full().items_start()
      .when(Boolean(l.bg), (el) => el.bg(l.bg))
      .when(sel, (el) => el.bg(t.selection ?? t.selected))
      .child(this.num(ctx, no, sel))
      .child(div().flex_none().w(MARK_W).cursor_pointer().text_color(l.markColor).child(l.mark || " "))
      .child(this.spans(ctx, side, no, r.text));
  }

  splitRow(ctx, item) {
    return h_flex().w_full().items_stretch().font_family(ctx.font).text_size(12)
      .child(this.half(ctx, item.left, "left"))
      .child(div().flex_none().w(1).h_full().bg(ctx.t.border))
      .child(this.half(ctx, item.right, "right"));
  }

  gapRow(t, g) {
    return h_flex().w_full().px(12).py(3).gap(8).items_center().bg(t.raised).cursor_pointer()
      .child(div().text_size(11.5).text_color(t.dim).child(`⋯ ${g.count} unchanged line${g.count === 1 ? "" : "s"}`))
      .child(div().text_size(11).text_color(t.accent).child("Show"));
  }

  sectionRow(t, title, sub) {
    return v_flex().px(TOP_INDENT).pt(10).pb(4).gap(2)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(title))
      .when(Boolean(sub), (el) => el.child(div().text_size(11).text_color(t.dim).child(sub)));
  }

  // ---- cards (threads, composers, unplaced drafts)

  // Wrap card content so it sits under its side (split) or under the code (unified).
  place(t, side, top, content, { accent, first = false, last = false } = {}) {
    const st = this.current();
    const card = v_flex().w_full().border_l(CARD_BORDER).border_color(accent ?? t.border).bg(t.surface)
      .px(CARD_PAD).pt(first ? 8 : 2).pb(last ? 8 : 2)
      .child(content);
    if (top || !st) return div().w_full().pl(TOP_INDENT).pr(16).child(card);
    if (this.style === "split") {
      const cell = div().flex_1().min_w(0).pl(SPLIT_INDENT).pr(12).child(card);
      const empty = div().flex_1().min_w(0);
      return h_flex().w_full().items_start().children(side === "right" ? [empty, cell] : [cell, empty]);
    }
    return div().w_full().pl(gutterWidth("unified", st.numW) + 4).pr(16).child(card);
  }

  // Fixed-width action buttons (hit-tested by x in onItem).
  actionRow(t, actions) {
    return h_flex().gap(ACTION_GAP).items_center().children(actions.map((a) => div().flex_none().w(ACTION_W).py(3).rounded(5)
      .border(1).border_color(a.primary ? t.accent : t.border).when(Boolean(a.primary && !a.disabled), (el) => el.bg(t.accent))
      .when(Boolean(a.disabled), (el) => el.opacity(0.5)).when(!a.disabled, (el) => el.cursor_pointer())
      .text_size(11.5).text_center().truncate()
      .text_color(a.primary && !a.disabled ? t.background : t.foreground).child(a.label)));
  }

  threadItems(t, th, side, top, push) {
    const rv = this.rv;
    const resolved = th.status === "resolved";
    const open = rv.threadOpen(th);
    const accent = resolved ? t.border : t.accent;
    const first = th.comments[0];
    const statusColor = resolved ? t.ansi2 : th.status === "pending" ? t.muted : t.working;
    const where = th.file ? targetLabel({ file: "", side: th.file.side, line: th.file.startLine, endLine: th.file.endLine }).replace(/^:/, "line ") : "";
    push(`th:${th.id}:h`, () => this.place(t, side, top, h_flex().gap(8).items_center()
      .when(resolved, (el) => el.cursor_pointer().child(svg(ICON(open ? "chev-down" : "chev-right")).size(11).text_color(t.dim)))
      .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(first?.author ?? "?"))
      .child(div().flex_none().text_size(11).text_color(statusColor).child(resolved ? th.rawStatus ?? "resolved" : th.status))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(where))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(open ? "" : first?.body.split("\n")[0] ?? ""))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(first ? `${ago(first.created)} ago` : "")),
    { accent, first: true, last: !open }), { kind: "head", thread: th });
    if (!open) return;
    th.comments.forEach((c, i) => {
      push(`th:${th.id}:c:${c.id}`, () => this.place(t, side, top, v_flex().gap(3).pt(4)
        .when(i > 0, (el) => el.child(h_flex().gap(8)
          .child(div().text_size(12).text_color(t.foreground).child(c.author ?? "?"))
          .child(div().text_size(11).text_color(t.dim).child(`${ago(c.created)} ago`))))
        .child(TextView.markdown(`fp-c-${th.id}-${c.id}`, c.body || " ").w_full().text_size(12.5)), { accent }));
    });
    const key = draftKey({ thread: th.id });
    const box = rv.boxes.get(key);
    const replying = rv.replying.has(th.id) && box;
    if (replying) this.composerItems(t, { key, target: { thread: th.id }, side, top, accent }, top, push, th);
    const busyStatus = rv.busy.has(`status:${th.id}`);
    const actions = [];
    if (!replying) actions.push({ id: "reply", label: "Reply", run: (cx) => rv.startReply(cx, th) });
    actions.push(resolved
      ? { id: "status", label: busyStatus ? "Reactivating…" : "Reactivate", disabled: busyStatus, run: (cx) => rv.setStatus(cx, th, "active") }
      : { id: "status", label: busyStatus ? "Resolving…" : "Resolve", disabled: busyStatus, run: (cx) => rv.setStatus(cx, th, "resolved") });
    push(`th:${th.id}:a`, () => this.place(t, side, top, div().pt(6).child(this.actionRow(t, actions)), { accent, last: true }),
      { kind: "actions", side, top, actions });
  }

  // A composer for a line draft (d.target has file/side/line) or a reply (thread given).
  composerItems(t, d, top, push, thread) {
    const rv = this.rv;
    const box = rv.boxes.get(d.key);
    if (!box) return;
    const side = thread ? d.side : d.target.side;
    const accent = d.accent ?? t.accent;
    const busy = rv.busy.has(`post:${d.key}`);
    const empty = !box.state.value().trim();
    const label = thread ? null : `${d.target.endLine != null ? "Lines" : "Line"} ${targetLabel({ ...d.target, file: "" }).replace(/^:/, "")}`
      + (d.target.side === "left" ? "" : " (new)");
    push(`cmp:${d.key}`, () => this.place(t, side, top, v_flex().gap(4).pt(thread ? 6 : 0)
      .when(Boolean(label), (el) => el.child(div().text_size(11).text_color(t.dim).child(`New comment · ${label}`)))
      .child(div().w_full().rounded(6).border(1).border_color(t.input).bg(t.background).p(2)
        .child(Textarea.new(box.state).w_full().text_size(12.5).text_color(t.foreground))),
    { accent, first: !thread }));
    const actions = [{ id: "post", label: busy ? "Posting…" : thread ? "Reply" : "Comment", primary: true, disabled: busy || empty,
      run: (cx) => (thread ? rv.postReply(cx, thread) : this.postLine(cx, d.key)) }];
    if (thread) actions.push({ id: "hide", label: "Hide", run: (cx) => { rv.replying.delete(thread.id); cx.notify(); } });
    else if (empty && !busy) actions.push({ id: "cancel", label: "Cancel", run: (cx) => this.cancelLine(cx, d.key) });
    push(`cmp:${d.key}:a`, () => this.place(t, side, top, h_flex().gap(8).items_center().pt(6)
      .child(this.actionRow(t, actions))
      .when(!empty, (el) => el.child(note(t, "Draft saved"))), { accent, last: !thread }),
    { kind: "actions", side, top, actions });
  }

  unplacedItems(t, d, push) {
    push(`ud:${d.key}`, () => this.place(t, null, true, v_flex().gap(4)
      .child(div().text_size(11).text_color(t.working).child(targetLabel(d.target)))
      .child(div().text_size(12.5).text_color(t.foreground).child(d.body || "(empty)")), { accent: t.working, first: true }));
    // Copy lets the text be re-posted on the right line; Discard deletes it.
    const actions = [
      { id: "copy", label: "Copy", run: (cx) => cx.write_to_clipboard(d.body ?? "") },
      { id: "discard", label: "Discard", run: (cx) => this.discard(cx, d.key) },
    ];
    push(`ud:${d.key}:a`, () => this.place(t, null, true, div().pt(6).child(this.actionRow(t, actions)), { accent: t.working, last: true }),
      { kind: "actions", side: null, top: true, actions });
  }
}
