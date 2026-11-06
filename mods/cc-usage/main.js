// Claude Code usage, ccusage-style: cost and tokens by day, model, repo,
// folder, branch and session, plus the live 5-hour block. Data comes from
// ./aggregate.py (reads ~/.claude/projects transcripts, caches incrementally
// in ~/.cache/cc-usage-herdr). Costs are list-price estimates.
//
// Opens as a dialog (mod.open:cc-usage), or as a pane beside a shell.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, theme, settings, props, closeOverlay, run, home, appHome, setShared } from "herdr";
import { bars, spark, line, strip, heatmap, legend, series, alpha } from "./charts.js";

const RANGES = [
  { key: "1", label: "Today", days: 1 },
  { key: "7", label: "7d", days: 7 },
  { key: "30", label: "30d", days: 30 },
  { key: "90", label: "90d", days: 90 },
  { key: "all", label: "All", days: 0 },
];
const TABS = ["Overview", "Projects", "Sessions"];
const GROUPS = [
  { key: "repo", label: "Repo" },
  { key: "folder", label: "Folder" },
  { key: "branch", label: "Branch" },
  { key: "model", label: "Model" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REFRESH_MS = 60000;
const LIMITS_MS = 60000;
// Plan limits: ./limits.py prints them (and keeps a copy in the cache file);
// without it the row reads whatever the cache file holds.
const LIMITS_CACHE = "/.cache/cc-usage-herdr/limits.json";

// ---- formatting

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const shortDay = (k) => `${MONTHS[+k.slice(5, 7) - 1]} ${+k.slice(8, 10)}`;
function usd(v) {
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 100) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
}
function tok(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function ago(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dur(min) {
  const m = Math.round(min);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}
function when(ts) {
  const d = new Date(ts * 1000);
  return `${shortDay(dayKey(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const tokens = (v) => v[1] + v[2] + v[3] + v[4];

// ---- data

function dayRange(days, first) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  let n = days;
  if (!n) n = first ? Math.max(1, Math.round((today - fromKey(dayKey(new Date(first * 1000)))) / 86400000) + 1) : 30;
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(today.getTime() - i * 86400000)));
  return out;
}

function sum(perDay, keys) {
  const v = [0, 0, 0, 0, 0, 0];
  if (!perDay) return v;
  for (const k of keys) {
    const d = perDay[k];
    if (d) for (let i = 0; i < 6; i++) v[i] += d[i];
  }
  return v;
}

export default class CcUsage extends View {
  init(_props, cx) {
    this.report = null;
    this.error = null;
    this.loading = false;
    // props {tab, range, group, repo} pick the first view (a pane or tab can ask).
    const p = props() ?? {};
    this.tab = p.tab ?? localStorage.getItem("tab") ?? "Overview";
    this.range = localStorage.getItem("range") ?? "30";
    this.group = localStorage.getItem("group") ?? "repo";
    this.open = {}; // expanded repo rows
    this.repoFilter = p.repo ?? null; // sessions filtered to a repo label
    if (p.range) this.range = String(p.range);
    if (p.group) this.group = p.group;
    if (p.expand) this.open[p.expand] = true;
    this.width = 900;
    if (p.overlay) setShared("cc-usage.open", true); // lights the tab-bar button
    this.script = `${appHome()}/mods/cc-usage/aggregate.py`;
    // Last report first, so the panel paints at once; then a fresh scan.
    cx.spawn(async (cx) => {
      const cached = await readTextFile(`${home()}/.cache/cc-usage-herdr/report.json`).catch(() => null);
      if (cached && !this.report) {
        try {
          this.report = JSON.parse(cached);
          this.index();
          cx.notify();
        } catch {}
      }
    });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.limits = null; // {fetched, limits:[{key,label,used,resets_at}]} | {error}
    this.loadLimits(cx);
    cx.timer.every(LIMITS_MS, (cx) => this.loadLimits(cx));
    // The reset countdowns tick down between fetches.
    cx.timer.every(30000, (cx) => { if (this.limits?.limits?.length) cx.notify(); });
  }

  loadLimits(cx) {
    if (this.limitsBusy) return;
    this.limitsBusy = true;
    cx.spawn(async (cx) => {
      let res = null;
      try {
        const r = await exec("python3", [`${appHome()}/mods/cc-usage/limits.py`]);
        if (r.code === 0) res = JSON.parse(r.stdout);
      } catch {}
      if (!res || res.error) {
        // No fetcher, or it failed: fall back to the last good figures.
        const cached = await readTextFile(home() + LIMITS_CACHE).catch(() => null);
        try {
          const c = cached && JSON.parse(cached);
          if (c?.limits?.length) res = { ...c, stale: res?.error ?? "showing the last fetched figures" };
        } catch {}
      }
      this.limits = res ?? { error: "not connected" };
      this.limitsBusy = false;
      cx.notify();
    });
  }

  // ---- plan limits row

  limitsRow(t) {
    const L = this.limits;
    if (!L) return div();
    const now = Date.now() / 1000;
    const wrap = (inner) => h_flex().flex_none().px(16).py(10).gap(12).items_center().flex_wrap()
      .border_b(1).border_color(t.border).bg(t.background).child(inner);
    if (!L.limits?.length) {
      return wrap(h_flex().gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("Plan limits"))
        .child(div().text_size(11.5).text_color(t.dim).child(
          L.error === "not connected" ? "Not connected: limits.py is missing." : `Unavailable: ${L.error}`)));
    }
    const cells = L.limits.map((l) => {
      const used = Math.max(0, Math.min(100, l.used));
      const left = 100 - used;
      // Status color plus a word, never color alone.
      const [color, word] = used >= 90 ? [t.ansi1, "Almost out"] : used >= 75 ? [t.ansi3, "Running low"] : [t.ansi2, ""];
      const reset = l.resets_at ? Date.parse(l.resets_at) / 1000 : 0;
      const resetIn = reset > now ? `resets in ${reset - now >= 172800 ? `${Math.floor((reset - now) / 86400)}d ${Math.floor(((reset - now) % 86400) / 3600)}h` : dur((reset - now) / 60)}` : reset ? "resetting" : "";
      const resetAt = reset ? new Date(reset * 1000) : null;
      const tip = `${l.label}: ${used.toFixed(0)}% used, ${left.toFixed(0)}% left` +
        (resetAt ? `\nResets ${when(reset)}` : "");
      return v_flex().id(`lim-${l.key}`).flex_1().flex_basis(0).min_w(150).gap(5).tooltip(tip)
        .child(h_flex().items_center().gap(6)
          .child(div().text_size(11.5).text_color(t.muted).truncate().child(l.label))
          .child(div().flex_1())
          .when(Boolean(word), (el) => el.child(div().text_size(10.5).font_semibold().text_color(color).child(word))))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child(l.left_text || `${left.toFixed(0)}% left`))
        .child(div().w_full().h(6).rounded(3).bg(alpha(t.foreground, 0.08))
          .child(div().h_full().rounded(3).bg(color).w(`${Math.max(used, used > 0 ? 2 : 0)}%`)))
        .child(div().text_size(11).text_color(t.dim).truncate().child(l.note || resetIn || " "));
    });
    return wrap(h_flex().w_full().gap(20).items_center().flex_wrap()
      .child(v_flex().flex_none().gap(2)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("Plan limits"))
        .child(div().text_size(10.5).text_color(L.stale ? t.ansi3 : t.dim)
          .tooltip(L.stale ? String(L.stale) : "Refreshed every minute")
          .child(L.fetched ? (L.stale ? `stale · ${ago(now - L.fetched)}` : ago(now - L.fetched)) : "")))
      .children(cells));
  }

  set(field, value, cx) {
    this[field] = value;
    localStorage.setItem(field, String(value));
    cx.notify();
  }

  refresh(cx, full = false) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = full ? [this.script, "--full"] : [this.script];
        const r = await exec("python3", args);
        if (r.code !== 0 && r.code != null) throw new Error((r.stderr || "aggregate.py failed").trim().split("\n").pop());
        this.report = JSON.parse(r.stdout);
        this.index();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Stable colors per model (all-time order), so a range change never repaints.
  index() {
    const r = this.report;
    const all = Object.keys(r.days);
    const models = [...r.model].sort((a, b) => sum(b.days, all)[0] - sum(a.days, all)[0]);
    this.modelOrder = models.map((m) => m.key);
  }

  modelColor(key) {
    const pal = series(settings().dark !== false);
    const i = this.modelOrder?.indexOf(key) ?? -1;
    return i >= 0 && i < 6 ? pal[i] : theme().dim;
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  // Lifecycle: the dialog went away (Esc, toggle, close button).
  async close(_cx) {
    if (props()?.overlay) setShared("cc-usage.open", false);
  }

  // ---- pieces

  pill(t, id, label, active, onClick) {
    return div()
      .id(id)
      .px(10)
      .py(3)
      .rounded(6)
      .text_size(12)
      .cursor_pointer()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
  }

  segmented(t, id, items, value, onPick) {
    return h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
      items.map((it) => this.pill(t, `${id}-${it.key}`, it.label, it.key === value, (_e, cx) => onPick(it.key, cx))),
    );
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

  card(t, title, body, { flex = 1, right } = {}) {
    return v_flex()
      .flex_1()
      .flex_grow(flex)
      .flex_basis(0)
      .min_w(260)
      .p(14)
      .gap(10)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(12).font_semibold().text_color(t.muted).child(title))
        .when(Boolean(right), (el) => el.child(right)))
      .child(body);
  }

  stat(t, label, value, sub) {
    return v_flex()
      .flex_1()
      .min_w(150)
      .p(14)
      .gap(4)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .child(div().text_size(11.5).text_color(t.muted).child(label))
      .child(div().text_size(24).font_semibold().text_color(t.foreground).child(value))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(sub ?? " "));
  }

  // ---- header

  header(t) {
    const r = this.report;
    const age = r ? ago(Date.now() / 1000 - r.generated) : "";
    return h_flex()
      .flex_none()
      .px(16)
      .py(10)
      .gap(12)
      .items_center()
      .flex_wrap()
      .border_b(1)
      .border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/cc-usage/gauge.svg").size(16).text_color(t.accent))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Claude usage")))
      .child(this.segmented(t, "tab", TABS.map((x) => ({ key: x, label: x })), this.tab, (k, cx) => this.set("tab", k, cx)))
      .child(div().flex_1())
      .child(this.segmented(t, "range", RANGES, this.range, (k, cx) => this.set("range", k, cx)))
      .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).child(this.error ? "scan failed" : this.loading ? "scanning…" : age))
      .child(this.iconButton(t, "refresh", "mods/cc-usage/refresh.svg", "Rescan (shift-click: rebuild cache)", (e, cx) => this.refresh(cx, Boolean(e?.modifiers?.shift)), this.loading))
      .when(Boolean(props()?.overlay), (el) => el
        .child(this.iconButton(t, "as-pane", "mods/cc-usage/panel-right.svg", "Open beside this pane", () => {
          this.dismiss();
          run("pane.split", { direction: "right", mod: "cc-usage" });
        }))
        .child(this.iconButton(t, "close", "mods/cc-usage/x.svg", "Close", () => this.dismiss())));
  }

  // ---- overview

  overview(t, keys) {
    const r = this.report;
    const dark = settings().dark !== false;
    const blue = series(dark)[0];
    const total = sum(r.days, keys);
    const n = keys.length;
    // Compare only against a full previous period that has data from its start.
    const firstDay = r.first ? dayKey(new Date(r.first * 1000)) : null;
    let prevKeys = this.range === "all" ? [] : dayRange(n * 2).slice(0, n);
    if (!firstDay || prevKeys[0] < firstDay) prevKeys = [];
    const prev = sum(r.days, prevKeys);
    const delta = (a, b) => {
      if (!prevKeys.length || b <= 0) return null;
      const p = ((a - b) / b) * 100;
      return `${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(0)}% vs previous ${n === 1 ? "day" : `${n}d`}`;
    };
    const costSub = delta(total[0], prev[0]) ?? (this.range === "all" ? `since ${firstDay ? shortDay(firstDay) : "—"}` : `${usd(total[0] / n)}/day`);
    const activeDays = keys.filter((k) => r.days[k]?.[0] > 0).length;
    const sessions = r.sessions.filter((s) => dayKey(new Date(s.end * 1000)) >= keys[0]).length;

    // KPI row
    const kpis = h_flex().gap(12).flex_wrap()
      .child(this.stat(t, "Cost (est.)", usd(total[0]), costSub))
      .child(this.stat(t, "Tokens", tok(tokens(total)), `${tok(total[2])} out · ${tok(total[1])} in`))
      .child(this.stat(t, "Avg / active day", usd(activeDays ? total[0] / activeDays : 0), `${activeDays} of ${n} days active`))
      .child(this.stat(t, "Messages", tok(total[5]), `${sessions} sessions`))
      .child(this.blockStat(t));

    // Daily cost stacked by model (top 5 models of the range + other).
    const inRange = r.model.map((m) => ({ m, c: sum(m.days, keys)[0] })).filter((x) => x.c > 0).sort((a, b) => b.c - a.c);
    const top = inRange.slice(0, 5).map((x) => x.m);
    const rest = inRange.slice(5).map((x) => x.m);
    const weekly = n > 62;
    const buckets = [];
    for (let i = 0; i < n; i += weekly ? 7 : 1) buckets.push(keys.slice(i, i + (weekly ? 7 : 1)));
    const today = dayKey(new Date());
    const cols = buckets.map((b, i) => {
      const segs = top.map((m) => ({ v: sum(m.days, b)[0], color: this.modelColor(m.key) }));
      const other = rest.reduce((s, m) => s + sum(m.days, b)[0], 0);
      if (other > 0) segs.push({ v: other, color: t.dim });
      const tot = sum(r.days, b);
      const lines = top.map((m) => [m.label, sum(m.days, b)[0]]).filter((x) => x[1] > 0).map(([l, c]) => `${l} ${usd(c)}`);
      if (other > 0) lines.push(`other ${usd(other)}`);
      const label = weekly ? `Week of ${shortDay(b[0])}` : shortDay(b[0]);
      return {
        key: b[0],
        segs,
        highlight: b.includes(today),
        tip: `${label} · ${usd(tot[0])} · ${tok(tokens(tot))} tokens${lines.length ? "\n" + lines.join("\n") : ""}`,
      };
    });
    const every = Math.max(1, Math.ceil(buckets.length / 8));
    const xl = buckets.map((b, i) => (i % every === 0 ? shortDay(b[0]) : ""));
    const modelLegend = legend(t, [
      ...top.map((m) => ({ color: this.modelColor(m.key), label: m.label, value: usd(sum(m.days, keys)[0]) })),
      ...(rest.length ? [{ color: t.dim, label: "other", value: usd(rest.reduce((s, m) => s + sum(m.days, keys)[0], 0)) }] : []),
    ]);
    const daily = this.card(t, weekly ? "Weekly cost by model" : "Daily cost by model",
      v_flex().gap(10).child(top.length > 1 ? modelLegend : div()).child(bars(t, "daily", cols, { height: 150, labels: xl })), { flex: 2 });

    // Cumulative spend
    let run_ = 0;
    const cum = keys.map((k) => (run_ += r.days[k]?.[0] ?? 0));
    const cumCard = this.card(t, "Cumulative spend",
      v_flex().gap(6)
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child(usd(run_)))
        .child(line(t, cum, blue, { height: 110 }))
        .child(h_flex().justify_between().text_size(10).text_color(t.dim).child(shortDay(keys[0])).child(shortDay(keys[n - 1]))));

    // Token mix
    const pal = series(dark);
    const mix = [
      { v: total[4], color: pal[0], label: "Cache read" },
      { v: total[3], color: pal[1], label: "Cache write" },
      { v: total[1], color: pal[2], label: "Input" },
      { v: total[2], color: pal[3], label: "Output" },
    ].map((p) => ({ ...p, tip: `${p.label} · ${tok(p.v)}` }));
    const hit = total[4] / Math.max(1, total[4] + total[3] + total[1]);
    const mixCard = this.card(t, "Token mix",
      v_flex().gap(10)
        .child(strip(t, "mix", mix))
        .child(legend(t, mix.map((p) => ({ color: p.color, label: p.label, value: tok(p.v) }))))
        .child(h_flex().gap(16)
          .child(this.mini(t, "Cache hit rate", `${(hit * 100).toFixed(1)}%`))
          .child(this.mini(t, "Subagent share", `${(r.subagentShare * 100).toFixed(0)}%`, "all time"))
          .child(this.mini(t, "$ / 1M tokens", usd(tokens(total) ? (total[0] / tokens(total)) * 1e6 : 0)))));

    // Top repos
    const repos = r.repo.map((g) => ({ g, v: sum(g.days, keys) })).filter((x) => x.v[0] > 0).sort((a, b) => b.v[0] - a.v[0]).slice(0, 7);
    const maxRepo = repos[0]?.v[0] ?? 1;
    const repoCard = this.card(t, "Top repos",
      v_flex().gap(6).children(repos.map(({ g, v }) =>
        h_flex().id(`top-${g.key}`).gap(10).items_center().px(4).py(2).rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(`${g.path} · ${tok(tokens(v))} tokens · ${v[5]} msgs`)
          .on_click((_e, cx) => {
            this.group = "repo";
            this.open = { [g.key]: true };
            this.set("tab", "Projects", cx);
          })
          .child(div().w(150).flex_none().truncate().text_size(12.5).text_color(t.foreground).child(g.label))
          .child(div().flex_1().h(10).child(div().h_full().rounded_r(3).bg(blue).w(`${Math.max(1, (v[0] / maxRepo) * 100)}%`)))
          .child(div().w(64).flex_none().text_right().text_size(12).text_color(t.foreground).child(usd(v[0]))))),
      { right: div().id("all-repos").text_size(11).text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.set("tab", "Projects", cx)).child("All →") });

    // Heatmap (last 30 days, from the script) and recent 5h blocks
    const heat = this.card(t, "When you spend · last 30 days", heatmap(t, "heat", r.heat, blue, usd));
    const blocks = r.blocks.slice(-24);
    const blockCard = this.card(t, "5-hour blocks",
      bars(t, "blocks", blocks.map((b) => ({
        key: String(b.start),
        segs: [{ v: b.cost, color: blue }],
        highlight: r.active && b.start === r.active.start,
        tip: `${when(b.start)} · ${usd(b.cost)} · ${tok(b.tokens)} tokens · ${b.msgs} msgs`,
      })), { height: 110 }));

    const wide = this.width >= 980;
    const rowOf = (...kids) => (wide ? h_flex().gap(12).items_start() : v_flex().gap(12)).children(kids);
    return v_flex().gap(12)
      .child(kpis)
      .child(rowOf(daily, cumCard))
      .child(rowOf(repoCard, mixCard))
      .child(rowOf(heat, blockCard));
  }

  mini(t, label, value, sub) {
    return v_flex().gap(2)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(h_flex().gap(6).items_end()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(value))
        .when(Boolean(sub), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(sub))));
  }

  blockStat(t) {
    const a = this.report.active;
    const blue = series(settings().dark !== false)[0];
    if (!a) return this.stat(t, "Current 5h block", "—", "no active block");
    const elapsed = Math.min(1, Math.max(0, (Date.now() / 1000 - a.start) / (5 * 3600)));
    return v_flex()
      .flex_1()
      .min_w(220)
      .p(14)
      .gap(4)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .child(h_flex().justify_between()
        .child(div().text_size(11.5).text_color(t.muted).child("Current 5h block"))
        .child(div().text_size(11.5).text_color(t.dim).child(`${dur(a.remainMin)} left`)))
      .child(h_flex().gap(8).items_end()
        .child(div().text_size(24).font_semibold().text_color(t.foreground).child(usd(a.cost)))
        .child(div().text_size(11.5).text_color(t.dim).pb(4).child(`→ ${usd(a.projected)} projected`)))
      .child(div().w_full().h(6).rounded(3).bg(alpha(t.foreground, 0.08))
        .child(div().h_full().rounded(3).bg(blue).w(`${elapsed * 100}%`)))
      .child(div().text_size(11.5).text_color(t.dim).truncate().child(`${usd(a.burnPerHour)}/h · ${tok(a.tokPerMin)} tok/min · ${a.msgs} msgs`));
  }

  // ---- projects table

  row(t, keys, g, v, maxCost, depth, { expandable, expanded, onClick, sub } = {}) {
    const dark = settings().dark !== false;
    const color = this.group === "model" && depth === 0 ? this.modelColor(g.key) : series(dark)[0];
    const last14 = dayRange(14).map((k) => g.days[k]?.[0] ?? 0);
    const share = maxCost > 0 ? v[0] / maxCost : 0;
    return h_flex()
      .id(`row-${depth}-${g.key}`)
      .gap(12)
      .items_center()
      .px(12)
      .py(7)
      .border_b(1)
      .border_color(alpha(t.border, 0.6))
      .when(depth > 0, (el) => el.bg(alpha(t.foreground, 0.025)))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click(onClick))
      .child(div().w(14).flex_none().text_size(10).text_color(t.dim).child(expandable ? (expanded ? "▾" : "▸") : ""))
      .child(v_flex().flex_1().min_w(120).pl(depth * 16)
        .child(div().truncate().text_size(12.5).text_color(depth ? t.muted : t.foreground).child(g.label))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .child(div().w(120).flex_none().h(8).rounded(4).bg(alpha(t.foreground, 0.06))
        .child(div().h_full().rounded(4).bg(color).w(`${Math.max(share > 0 ? 2 : 0, share * 100)}%`)))
      .child(div().w(72).flex_none().text_right().text_size(12.5).font_medium().text_color(t.foreground).child(usd(v[0])))
      .child(div().w(70).flex_none().text_right().text_size(12).text_color(t.muted).child(tok(tokens(v))))
      .child(div().w(56).flex_none().text_right().text_size(12).text_color(t.muted).child(tok(v[5])))
      .when(this.width >= 760, (el) => el.child(div().flex_none().tooltip("Last 14 days").id(`sp-${depth}-${g.key}`).child(spark(t, last14, color))))
      .when(this.width >= 860, (el) => el.child(div().w(64).flex_none().text_right().text_size(11).text_color(t.dim).child(g.last ? ago(Date.now() / 1000 - g.last) : "")));
  }

  projects(t, keys) {
    const r = this.report;
    const list = r[this.group].map((g) => ({ g, v: sum(g.days, keys) })).filter((x) => x.v[5] > 0).sort((a, b) => b.v[0] - a.v[0]);
    const total = sum(r.days, keys);
    const maxCost = list[0]?.v[0] ?? 0;
    const head = h_flex().gap(12).px(12).py(6).text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().w(14).flex_none())
      .child(div().flex_1().min_w(120).child(GROUPS.find((x) => x.key === this.group).label))
      .child(div().w(120).flex_none().child("Share"))
      .child(div().w(72).flex_none().text_right().child("Cost"))
      .child(div().w(70).flex_none().text_right().child("Tokens"))
      .child(div().w(56).flex_none().text_right().child("Msgs"))
      .when(this.width >= 760, (el) => el.child(div().w(84).flex_none().child("14 days")))
      .when(this.width >= 860, (el) => el.child(div().w(64).flex_none().text_right().child("Last")));

    const rows = [];
    for (const { g, v } of list) {
      const isRepo = this.group === "repo";
      const expanded = isRepo && this.open[g.key];
      let sub = null;
      if (this.group === "folder" || this.group === "branch") sub = g.repo;
      else if (isRepo && g.path !== g.label) sub = g.path;
      rows.push(this.row(t, keys, g, v, maxCost, 0, {
        expandable: isRepo,
        expanded,
        sub,
        onClick: isRepo ? (_e, cx) => { this.open[g.key] = !this.open[g.key]; cx.notify(); } : null,
      }));
      if (expanded) rows.push(this.repoDetail(t, keys, g));
    }
    // Branch/folder rows in the totals: no double counting, just a footer.
    const foot = h_flex().gap(12).px(12).py(8).text_size(12).text_color(t.muted)
      .child(div().w(14).flex_none())
      .child(div().flex_1().child(`${list.length} ${GROUPS.find((x) => x.key === this.group).label.toLowerCase()}s`))
      .child(div().w(120).flex_none())
      .child(div().w(72).flex_none().text_right().font_semibold().text_color(t.foreground).child(usd(total[0])))
      .child(div().w(70).flex_none().text_right().child(tok(tokens(total))))
      .child(div().w(56).flex_none().text_right().child(tok(total[5])))
      .when(this.width >= 760, (el) => el.child(div().w(84).flex_none()))
      .when(this.width >= 860, (el) => el.child(div().w(64).flex_none()));

    return v_flex().gap(12)
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(12).text_color(t.muted).child("Group by"))
        .child(this.segmented(t, "group", GROUPS, this.group, (k, cx) => this.set("group", k, cx))))
      .child(v_flex().rounded(10).bg(t.background).border(1).border_color(t.border).overflow_hidden()
        .child(head).children(rows).child(foot));
  }

  // A repo row, opened: its daily bars, its folders and branches, a sessions link.
  repoDetail(t, keys, g) {
    const r = this.report;
    const blue = series(settings().dark !== false)[0];
    const n = Math.min(keys.length, 60);
    const ks = keys.slice(-n);
    const cols = ks.map((k) => {
      const v = g.days[k] ?? [0, 0, 0, 0, 0, 0];
      return { key: k, segs: [{ v: v[0], color: blue }], tip: `${shortDay(k)} · ${usd(v[0])} · ${tok(tokens(v))} tokens` };
    });
    const children = (dim) =>
      r[dim].filter((x) => x.repo === g.label).map((x) => ({ x, v: sum(x.days, keys) })).filter((y) => y.v[5] > 0).sort((a, b) => b.v[0] - a.v[0]).slice(0, 8);
    const folders = children("folder");
    const branches = children("branch");
    const max = Math.max(folders[0]?.v[0] ?? 0, branches[0]?.v[0] ?? 0);
    const list = (title, items, labelOf) =>
      v_flex().flex_1().min_w(240).gap(4)
        .child(div().text_size(11).text_color(t.dim).child(title))
        .children(items.map(({ x, v }) =>
          h_flex().id(`d-${title}-${x.key}`).gap(8).items_center().tooltip(`${x.label} · ${tok(tokens(v))} tokens · ${v[5]} msgs`)
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(labelOf(x)))
            .child(div().w(70).flex_none().h(6).rounded(3).bg(alpha(t.foreground, 0.06))
              .child(div().h_full().rounded(3).bg(blue).w(`${max ? Math.max(2, (v[0] / max) * 100) : 0}%`)))
            .child(div().w(60).flex_none().text_right().text_size(12).text_color(t.foreground).child(usd(v[0])))));
    // Inside the repo: a relative path. Elsewhere (a worktree): its last folder.
    const short = (p) => {
      if (g.path && p === g.path) return ".";
      if (g.path && p.startsWith(g.path + "/")) return "." + p.slice(g.path.length);
      return `⎇ ${p.split("/").filter(Boolean).pop()}`;
    };
    return v_flex().px(42).py(12).gap(12).bg(alpha(t.foreground, 0.025)).border_b(1).border_color(alpha(t.border, 0.6))
      .child(bars(t, `rd-${g.key}`, cols, { height: 70, labels: ks.map((k, i) => (i % Math.max(1, Math.ceil(n / 6)) === 0 ? shortDay(k) : "")) }))
      .child(h_flex().gap(24).flex_wrap()
        .child(list("Folders / worktrees", folders, (x) => short(x.label)))
        .child(list("Branches", branches, (x) => x.label)))
      .child(div().id(`sess-${g.key}`).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.repoFilter = g.label; this.set("tab", "Sessions", cx); })
        .child(`Sessions in ${g.label} →`));
  }

  // ---- sessions

  sessions(t, keys) {
    const from = keys[0];
    let list = this.report.sessions.filter((s) => dayKey(new Date(s.end * 1000)) >= from);
    if (this.repoFilter) list = list.filter((s) => s.repo === this.repoFilter);
    const count = list.length;
    list = list.slice(0, 150);
    const max = Math.max(1e-9, ...list.map((s) => s.cost));
    const blue = series(settings().dark !== false)[0];
    const head = h_flex().gap(12).px(12).py(6).text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().w(96).flex_none().child("Last active"))
      .child(div().flex_1().min_w(140).child("Repo · branch"))
      .child(div().w(110).flex_none().child("Model"))
      .child(div().w(64).flex_none().text_right().child("Length"))
      .child(div().w(72).flex_none().text_right().child("Cost"))
      .child(div().w(70).flex_none().text_right().child("Tokens"))
      .child(div().w(60).flex_none());
    const rows = list.map((s) =>
      h_flex().id(`s-${s.id}`).gap(12).items_center().px(12).py(7).border_b(1).border_color(alpha(t.border, 0.6))
        .hover((st) => st.bg(t.hover))
        .tooltip(`${s.folder}\n${s.id} · ${s.msgs} msgs`)
        .child(div().w(96).flex_none().text_size(12).text_color(t.muted).child(when(s.end)))
        .child(v_flex().flex_1().min_w(140)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(s.repo))
          .child(div().truncate().text_size(11).text_color(t.dim).child(s.branch || s.folder)))
        .child(h_flex().w(110).flex_none().gap(6).items_center()
          .child(div().w(8).h(8).rounded(2).flex_none().bg(this.modelColor(s.model)))
          .child(div().truncate().text_size(12).text_color(t.muted).child(s.model.replace("claude-", ""))))
        .child(div().w(64).flex_none().text_right().text_size(12).text_color(t.muted).child(dur((s.end - s.start) / 60)))
        .child(v_flex().w(72).flex_none().items_end().gap(2)
          .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(usd(s.cost)))
          .child(div().w_full().h(3).rounded(2).child(div().h_full().rounded(2).bg(blue).w(`${(s.cost / max) * 100}%`))))
        .child(div().w(70).flex_none().text_right().text_size(12).text_color(t.muted).child(tok(s.tokens)))
        .child(div().id(`resume-${s.id}`).w(60).flex_none().text_right().text_size(11.5).text_color(t.accent).cursor_pointer()
          .tooltip("Resume this session in a new tab")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.dismiss();
            const folder = s.folder.startsWith("~") ? home() + s.folder.slice(1) : s.folder;
            run("tab.new", { folder, argv: ["claude", "--resume", s.id] });
          })
          .child("Resume")));
    return v_flex().gap(12)
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(12).text_color(t.muted).child(count > list.length ? `${count} sessions · newest ${list.length} shown` : `${count} sessions`))
        .when(Boolean(this.repoFilter), (el) => el.child(
          h_flex().id("clear-filter").gap(6).px(8).py(2).rounded(6).bg(t.raised).cursor_pointer().items_center()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.repoFilter = null; cx.notify(); })
            .child(div().text_size(12).text_color(t.foreground).child(this.repoFilter))
            .child(div().text_size(11).text_color(t.dim).child("✕")))))
      .child(v_flex().rounded(10).bg(t.background).border(1).border_color(t.border).overflow_hidden().child(head).children(rows));
  }

  render(cx) {
    const t = theme();
    let body;
    if (!this.report) {
      body = v_flex().size_full().items_center().justify_center().gap(8)
        .child(div().text_size(13).text_color(t.muted).child(this.error ? "Couldn't read Claude usage" : "Reading Claude transcripts…"))
        .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(this.error)));
    } else {
      const range = RANGES.find((x) => x.key === this.range) ?? RANGES[2];
      const keys = dayRange(range.days, this.report.first);
      const page = this.tab === "Projects" ? this.projects(t, keys) : this.tab === "Sessions" ? this.sessions(t, keys) : this.overview(t, keys);
      body = div().id("body").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().p(16).gap(12).child(page)
          .child(div().text_size(10.5).text_color(t.dim).child(
            `Estimated at Anthropic list prices · ${this.report.messages.toLocaleString("en-US")} messages in ${this.report.files} transcripts · ~/.claude/projects`)));
    }
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.canvas ?? t.surface)
      .text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 4) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(this.header(t))
      .child(this.limitsRow(t))
      .child(body);
  }
}
