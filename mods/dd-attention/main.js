// Datadog: what needs attention in one env. Triggered monitors, Error Tracking
// issues, error logs (clustered by service + message shape) and APM error
// spans. Data comes from ./dd.py, run through the login shell so DD_API_KEY /
// DD_APP_KEY from ~/.zshenv or ~/.zshrc reach it; the keys never enter this
// script.
//
// Opens as a dialog (mod.open:dd-attention), or as a pane beside a shell.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, settings, props, closeOverlay, run, notify, appHome } from "herdr";
import { readFile } from "fs/promises";

// datadog.env in addons.json (herdr-addons README); re-read on each refresh.
// Keys stay in env vars (DD_API_KEY / DD_APP_KEY), never in that file.
let ENV = "prod";
async function loadEnv() {
  try {
    const e = JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8"))?.datadog?.env;
    if (e != null) ENV = String(e).replace(/[^\w.:-]/g, "") || "prod";
  } catch { /* defaults */ }
}
const REFRESH_MS = 120000;
const MARKER = "@@DD-ATTENTION@@";
const WINDOWS = [
  { key: "1", label: "1h" },
  { key: "4", label: "4h" },
  { key: "24", label: "24h" },
  { key: "168", label: "7d" },
];
const TABS = [
  { key: "monitors", label: "Monitors" },
  { key: "issues", label: "Issues" },
  { key: "logs", label: "Error logs" },
  { key: "apm", label: "APM errors" },
];

function ago(v) {
  if (v == null) return "";
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function num(n) {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
const appHost = (site) => (site === "datadoghq.com" || site === "datadoghq.eu" ? `https://app.${site}` : `https://${site}`);

export default class DdAttention extends View {
  init(_props, cx) {
    this.report = null;
    this.error = null;
    this.loading = false;
    this.hours = localStorage.getItem("hours") ?? "24";
    this.tab = localStorage.getItem("tab") ?? null;
    this.expanded = {};
    this.search = InputState.new({ placeholder: "Filter by service, message, monitor…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.script = `${appHome()}/mods/dd-attention/dd.py`;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    const hours = this.hours;
    cx.spawn(async (cx) => {
      try {
        await loadEnv();
        // A login + interactive zsh, so exports in ~/.zshrc count too.
        const cmd = `exec python3 -I '${this.script}' --env '${ENV}' --hours ${Number(hours)}`;
        const r = await exec("/bin/zsh", ["-lic", cmd]);
        const at = r.stdout.lastIndexOf(MARKER);
        if (at < 0) throw new Error((r.stderr || "dd.py printed nothing").trim().split("\n").pop());
        const report = JSON.parse(r.stdout.slice(at + MARKER.length));
        if (hours !== this.hours) return;
        this.report = report;
        this.error = null;
        if (!this.tab) this.tab = TABS.find((t) => this.count(t.key) > 0)?.key ?? "monitors";
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  section(key) {
    return this.report?.[key] ?? null;
  }

  rows(key) {
    const s = this.section(key);
    if (!s?.ok) return [];
    return key === "logs" ? s.data.clusters ?? [] : s.data ?? [];
  }

  count(key) {
    const rows = this.rows(key);
    return key === "monitors" ? rows.filter((m) => !m.muted).length : rows.length;
  }

  browse(path) {
    const url = appHost(this.report?.site ?? "datadoghq.com") + path;
    exec("open", [url]).catch((e) => notify({ title: "Couldn't open Datadog", body: String(e?.message ?? e), level: "error" }));
  }

  range() {
    const to = Date.now();
    return `from_ts=${to - Number(this.hours) * 3600000}&to_ts=${to}&live=true`;
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  match(...fields) {
    const q = this.search.value().trim().toLowerCase();
    return !q || fields.some((f) => (f ?? "").toString().toLowerCase().includes(q));
  }

  // ---- pieces

  pill(t, id, label, active, onClick) {
    return div().id(id).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
      .text_color(active ? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(label);
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

  badge(t, text, color, solid = false) {
    return div().flex_none().px(6).rounded(4).text_size(10.5).font_semibold()
      .when(solid, (el) => el.bg(color).text_color(t.background))
      .when(!solid, (el) => el.text_color(color).border(1).border_color(color))
      .child(text);
  }

  linkButton(t, id, label, onClick) {
    return div().id(id).flex_none().px(8).py(2).rounded(5).text_size(11.5).text_color(t.accent).cursor_pointer()
      .border(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick).child(label);
  }

  // A row: summary line(s), click to expand details.
  item(t, key, accent, main, right, details) {
    const open = Boolean(this.expanded[key]);
    return v_flex().id(`row-${key}`).rounded(6).when(open, (el) => el.bg(t.raised))
      .child(h_flex().id(`head-${key}`).px(12).py(7).gap(12).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(open ? t.raised : t.hover))
        .on_click((_e, cx) => { this.expanded[key] = !open; cx.notify(); })
        .child(div().flex_none().w(3).h(30).rounded(2).bg(accent))
        .child(v_flex().flex_1().min_w(0).gap(2).children(main))
        .children(right))
      .when(open, (el) => el.child(v_flex().pl(27).pr(12).pb(10).gap(6).children(details())));
  }

  mono(t, text) {
    return div().font_family(settings().font_family).text_size(11.5).text_color(t.muted).child(text);
  }

  // ---- monitors

  monitorRows(t) {
    const color = { Alert: t.ansi1, Warn: t.ansi3, "No Data": t.dim };
    return this.rows("monitors").filter((m) => this.match(m.name, m.type, ...(m.tags ?? []), ...(m.groups ?? []).map((g) => g.name)))
      .map((m) => {
        const c = color[m.state] ?? t.dim;
        return this.item(t, `m-${m.id}`, m.muted ? t.dim : c,
          [
            h_flex().gap(8).items_center().min_w(0)
              .child(this.badge(t, m.state.toUpperCase(), c, !m.muted))
              .when(m.muted, (el) => el.child(this.badge(t, "MUTED", t.dim)))
              .when(m.priority != null, (el) => el.child(div().flex_none().text_size(11.5).text_color(m.priority <= 2 ? t.ansi1 : t.dim).child(`P${m.priority}`)))
              .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(m.muted ? t.muted : t.foreground).child(m.name ?? "")),
            div().truncate().text_size(11.5).text_color(t.dim).child(
              `${m.type ?? ""}${m.group_count ? ` · ${m.group_count} group${m.group_count === 1 ? "" : "s"} triggered: ${m.groups.slice(0, 3).map((g) => g.name).join(", ")}` : ""}`),
          ],
          [div().flex_none().w(40).text_size(11.5).text_color(t.dim).child(ago(m.since))],
          () => [
            ...m.groups.slice(0, 12).map((g) => h_flex().gap(8).items_center()
              .child(this.badge(t, g.status, color[g.status] ?? t.dim))
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(g.name))
              .child(div().text_size(11).text_color(t.dim).child(ago(g.since)))),
            h_flex().gap(8).pt(2)
              .child(this.linkButton(t, `mo-${m.id}`, "Open monitor", () => this.browse(`/monitors/${m.id}`))),
          ]);
      });
  }

  // ---- error tracking

  issueRows(t) {
    const stateColor = (s) => ({ OPEN: t.ansi1, FOR_REVIEW: t.ansi3, REVIEWED: t.ansi4, IGNORED: t.dim, RESOLVED: t.ansi2 })[s] ?? t.ansi1;
    return this.rows("issues").filter((i) => this.match(i.type, i.message, i.service, i.file, i.function))
      .map((i) => {
        const fresh = i.first_seen && Date.now() - (i.first_seen < 1e12 ? i.first_seen * 1000 : i.first_seen) < Number(this.hours) * 3600000;
        return this.item(t, `i-${i.id}`, stateColor(i.state),
          [
            h_flex().gap(8).items_center().min_w(0)
              .when(fresh, (el) => el.child(this.badge(t, "NEW", t.ansi1, true)))
              .when(Boolean(i.state), (el) => el.child(this.badge(t, i.state.replace("_", " "), stateColor(i.state))))
              .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.ansi1).child(i.type ?? "Error"))
              .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(i.message ?? "")),
            div().truncate().text_size(11.5).text_color(t.dim).child(
              [i.service, i.file && `${i.file}${i.function ? ` · ${i.function}` : ""}`].filter(Boolean).join(" · ")),
          ],
          [
            div().flex_none().w(70).text_size(12).text_color(t.foreground).text_right().child(`${num(i.count)}×`),
            div().flex_none().w(70).text_size(11.5).text_color(t.dim).text_right().child(i.users ? `${num(i.users)} users` : ""),
            div().flex_none().w(40).text_size(11.5).text_color(t.dim).child(ago(i.last_seen)),
          ],
          () => [
            this.mono(t, i.message ?? ""),
            div().text_size(11.5).text_color(t.dim).child(`first seen ${ago(i.first_seen)} ago · last seen ${ago(i.last_seen)} ago${i.languages?.length ? ` · ${i.languages.join(", ")}` : ""}`),
            h_flex().gap(8).pt(2).child(this.linkButton(t, `io-${i.id}`, "Open issue", () => this.browse(`/error-tracking/issue/${i.id}`))),
          ]);
      });
  }

  // ---- logs

  logRows(t) {
    return this.rows("logs").filter((c) => this.match(c.service, c.message, c.kind, c.host))
      .map((c, n) => {
        const q = `service:${c.service} status:error env:${ENV} "${(c.shape.split(/<uuid>|<hex>|#/)[0] || c.message).replace(/["\\]/g, " ").trim().slice(0, 60)}"`;
        return this.item(t, `l-${n}-${c.service}`, c.status === "critical" || c.status === "emergency" ? t.ansi5 : t.ansi1,
          [
            h_flex().gap(8).items_center().min_w(0)
              .child(div().flex_none().text_size(12).font_semibold().text_color(t.ansi4).child(c.service))
              .when(Boolean(c.kind), (el) => el.child(div().flex_none().text_size(12).text_color(t.ansi1).child(c.kind)))
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(c.message || "(no message)")),
            div().truncate().text_size(11.5).text_color(t.dim).child(`${c.status ?? "error"}${c.host ? ` · ${c.host}` : ""} · first in sample ${ago(c.first)} ago`),
          ],
          [
            div().flex_none().w(60).text_size(12).text_color(t.foreground).text_right().child(`${num(c.count)}×`),
            div().flex_none().w(40).text_size(11.5).text_color(t.dim).child(ago(c.last)),
          ],
          () => [
            this.mono(t, c.message || "(no message)"),
            h_flex().gap(8).pt(2)
              .child(this.linkButton(t, `lo-${n}`, "Open in Log Explorer", () => this.browse(`/logs?query=${encodeURIComponent(q)}&${this.range()}`))),
          ]);
      });
  }

  // ---- apm

  apmRows(t) {
    return this.rows("apm").filter((r) => this.match(r.service, r.resource, r.sample?.type, r.sample?.message))
      .map((r, n) => {
        const rate = r.service_total ? (r.errors / r.service_total) * 100 : null;
        const s = r.sample;
        return this.item(t, `a-${n}-${r.service}`, t.ansi1,
          [
            h_flex().gap(8).items_center().min_w(0)
              .child(div().flex_none().text_size(12).font_semibold().text_color(t.ansi4).child(r.service ?? "?"))
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.resource ?? "")),
            div().truncate().text_size(11.5).text_color(t.dim).child(s ? `${s.type ? `${s.type}: ` : ""}${s.message || "(no message)"}` : "no indexed sample span"),
          ],
          [
            div().flex_none().w(70).text_size(12).text_color(t.foreground).text_right().child(`${num(r.errors)} err`),
            div().id(`rate-${n}`).flex_none().w(70).text_size(11.5).text_right()
              .text_color(rate == null ? t.dim : rate >= 5 ? t.ansi1 : rate >= 1 ? t.ansi3 : t.dim)
              .tooltip("Errors on this resource ÷ all spans of the service")
              .child(rate == null ? "" : `${rate < 0.1 ? "<0.1" : rate.toFixed(1)}%`),
          ],
          () => [
            ...(s?.message ? [this.mono(t, `${s.type ? `${s.type}: ` : ""}${s.message}`)] : []),
            ...(s?.stack ? [div().id(`stack-${n}`).max_h(260).overflow_y_scrollbar().p(8).rounded(5).bg(t.background).child(this.mono(t, s.stack))] : []),
            h_flex().gap(8).pt(2)
              .when(Boolean(s?.trace), (el) => el.child(this.linkButton(t, `at-${n}`, "Open sample trace", () => this.browse(`/apm/trace/${s.trace}`))))
              .child(this.linkButton(t, `as-${n}`, "Open service", () => this.browse(`/apm/services/${encodeURIComponent(r.service)}?env=${ENV}&${this.range()}`))),
          ]);
      });
  }

  // ---- layout

  header(t) {
    const r = this.report;
    const status = this.error ? "fetch failed" : this.loading ? "loading…" : r ? (Date.now() / 1000 - r.generated < 60 ? "updated just now" : `updated ${ago(r.generated)} ago`) : "";
    return h_flex().flex_none().px(16).py(10).gap(12).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/dd-attention/datadog.svg").size(17).text_color(t.ansi5))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Datadog"))
        .child(div().text_size(12).text_color(t.dim).child(`env:${ENV}`)))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
        TABS.map((x) => {
          const s = this.section(x.key);
          const n = this.count(x.key);
          const label = s && !s.ok ? `${x.label} !` : `${x.label} ${r && !r.fatal ? n : ""}`.trim();
          return this.pill(t, `tab-${x.key}`, label, this.tab === x.key, (_e, cx) => {
            this.tab = x.key;
            localStorage.setItem("tab", x.key);
            cx.notify();
          });
        })))
      .child(h_flex().flex_1().min_w(160).h(26).px(8).rounded(6).bg(t.background).border(1).border_color(t.input)
        .child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
        WINDOWS.map((w) => this.pill(t, `win-${w.key}`, w.label, this.hours === w.key, (_e, cx) => {
          this.hours = w.key;
          localStorage.setItem("hours", w.key);
          this.refresh(cx);
        }))))
      .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).child(status))
      .child(this.iconButton(t, "refresh", "mods/dd-attention/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx), this.loading))
      .when(Boolean(props()?.overlay), (el) => el
        .child(this.iconButton(t, "as-pane", "mods/dd-attention/panel-right.svg", "Open beside this pane", () => {
          this.dismiss();
          run("pane.split", { direction: "right", mod: "dd-attention" });
        }))
        .child(this.iconButton(t, "close", "mods/dd-attention/x.svg", "Close", () => this.dismiss())));
  }

  setupHelp(t, missing) {
    const line = (s) => this.mono(t, s);
    return v_flex().flex_1().items_center().justify_center().p(24).child(
      v_flex().max_w(620).gap(10).p(18).rounded(10).bg(t.background).border(1).border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Connect Datadog"))
        .child(div().text_size(12.5).text_color(t.muted).child(
          `This panel calls the Datadog API with your own keys. ${missing?.length ? `Missing: ${missing.join(", ")}.` : ""} Create an API key and an Application key (Organization Settings → API Keys / Application Keys), then add them to ~/.zshenv:`))
        .child(v_flex().p(10).rounded(6).bg(t.raised).gap(2)
          .child(line("export DD_API_KEY=…"))
          .child(line("export DD_APP_KEY=…"))
          .child(line("# optional, default datadoghq.com"))
          .child(line("export DD_SITE=datadoghq.com")))
        .child(div().text_size(12).text_color(t.dim).child(
          "The Application key needs read access to monitors, Error Tracking, logs and APM (scopes: monitors_read, error_tracking_read, logs_read_data, apm_read). Then press refresh."))
        .child(h_flex().child(this.linkButton(t, "keys-link", "Open API keys page", () => this.browse("/organization-settings/api-keys")))));
  }

  body(t) {
    const center = (...kids) => v_flex().flex_1().items_center().justify_center().gap(6).p(24).children(kids);
    const r = this.report;
    if (this.error && !r) {
      return center(
        div().text_size(13).text_color(t.blocked).child("Couldn't run the Datadog helper"),
        div().text_size(12).text_color(t.muted).child(this.error));
    }
    if (!r) return center(div().text_size(12).text_color(t.dim).child("Asking Datadog…"));
    if (r.fatal === "missing_keys") return this.setupHelp(t, r.missing);
    if (r.fatal === "auth") {
      return center(
        div().text_size(13).text_color(t.blocked).child("Datadog rejected the keys"),
        div().text_size(12).text_color(t.muted).child(this.section("monitors")?.error ?? ""),
        div().text_size(12).text_color(t.dim).child(`Check DD_API_KEY / DD_APP_KEY and DD_SITE (now ${r.site}).`));
    }
    const s = this.section(this.tab);
    if (s && !s.ok) {
      return center(
        div().text_size(13).text_color(t.blocked).child(`Couldn't load ${TABS.find((x) => x.key === this.tab)?.label ?? this.tab}`),
        div().max_w(700).text_size(12).text_color(t.muted).child(s.error),
        div().text_size(12).text_color(t.dim).child("A 403 usually means the Application key lacks that scope."));
    }
    const rows = { monitors: () => this.monitorRows(t), issues: () => this.issueRows(t), logs: () => this.logRows(t), apm: () => this.apmRows(t) }[this.tab]?.() ?? [];
    const note = this.tab === "logs" && s?.data
      ? `${num(Object.values(s.data.per_service ?? {}).reduce((a, b) => a + (b || 0), 0))} error logs in ${WINDOWS.find((w) => w.key === this.hours)?.label}; clusters from the newest ${num(s.data.sampled)}`
      : null;
    if (!rows.length) {
      const what = { monitors: "No monitors alerting", issues: "No Error Tracking issues", logs: "No error logs", apm: "No APM errors" }[this.tab];
      return center(div().text_size(12.5).text_color(t.ansi2).child(`✓ ${what} in env:${ENV}.`));
    }
    return div().id(`list-${this.tab}`).flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().p(8).gap(1)
        .when(Boolean(note), (el) => el.child(div().px(12).py(4).text_size(11.5).text_color(t.dim).child(note)))
        .children(rows));
  }

  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground)
      .child(this.header(t))
      .child(this.body(t));
  }
}
