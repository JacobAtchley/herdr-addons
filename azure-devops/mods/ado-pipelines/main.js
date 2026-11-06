// Azure DevOps pipelines: recent runs across every project, and each run's
// stages, jobs, tasks and logs. Builds are per-project in the REST API, so
// this asks every project in parallel (`az rest`, using the az login).
//
// Opens as a dialog (mod.open:ado-pipelines), or as a pane beside a shell.

import { View, div, svg, list } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, theme, settings, props, closeOverlay, run, notify, appHome } from "herdr";
import { readFile } from "fs/promises";
import { parseLog, isProblem, plainText } from "./loglines.js";

// Settings from addons.json in the herdr-app folder (see the herdr-addons
// README). Read on each use, so edits apply without reloading the mod.
async function addonSettings() {
  try {
    return JSON.parse(await readFile(`${appHome()}/addons.json`, "utf8")) ?? {};
  } catch {
    return {};
  }
}

const MAX_LINES = 50000; // newest lines kept for very long logs

const PER_PROJECT = 25; // newest runs asked of each project
const KEEP = 200; // runs kept after merging
const LIST_MS = 30000; // list poll; runs only while something is running or it's stale
const STALE_MS = 120000;
const DETAIL_MS = 8000; // an unfinished run's timeline and log
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const FILTERS = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "failed", label: "Failed" },
  { key: "running", label: "Running" },
];
const BUILD_QUERY =
  "value[].{id:id,num:buildNumber,status:status,result:result,def:definition.name,branch:sourceBranch,reason:reason," +
  "by:requestedFor.displayName,byMail:requestedFor.uniqueName,queued:queueTime,start:startTime,finish:finishTime,repo:repository.name}";
const TIMELINE_QUERY =
  "records[].{id:id,parent:parentId,type:type,name:name,state:state,result:result,order:order,log:log.id," +
  "start:startTime,finish:finishTime,errors:errorCount,warnings:warningCount,issues:issues[].{type:type,message:message}}";

const AZ = ["az", "/opt/homebrew/bin/az", "/usr/local/bin/az"];
async function az(args) {
  let last;
  for (const bin of AZ) {
    try {
      const r = await exec(bin, args);
      if (r.code !== 0 && r.code != null) throw new Error((r.stderr || "az failed").trim().split("\n").filter((l) => !/^WARNING/.test(l)).pop() || "az failed");
      return r.stdout;
    } catch (e) {
      last = e;
      if (!/not found|No such file|ENOENT|cannot start/i.test(String(e?.message ?? e))) throw e;
    }
  }
  throw last;
}
const rest = (url, query) => az(["rest", "--resource", ADO_RESOURCE, "-u", url, ...(query ? ["--query", query, "-o", "json"] : [])]);

// ---- formatting

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function dur(a, b) {
  if (!a) return "";
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
function branchLabel(b) {
  const pr = (b ?? "").match(/^refs\/pull\/(\d+)\//);
  if (pr) return `PR !${pr[1]}`;
  return (b ?? "").replace(/^refs\/(heads|tags)\//, "");
}
const running = (x) => x.status === "inProgress" || x.status === "notStarted" || x.state === "inProgress" || x.state === "pending";

// One look for a run or timeline record: [glyph, color, label].
function look(t, x) {
  if (x.status === "notStarted" || x.state === "pending") return ["◌", t.dim, "queued"];
  if (running(x)) return ["●", t.ansi4, "running"];
  switch (x.result) {
    case "succeeded": return ["✓", t.ansi2, "succeeded"];
    case "succeededWithIssues":
    case "partiallySucceeded": return ["!", t.ansi3, "partially succeeded"];
    case "failed": return ["✗", t.ansi1, "failed"];
    case "canceled": return ["⊘", t.dim, "canceled"];
    case "skipped": return ["–", t.dim, "skipped"];
    case "abandoned": return ["⊘", t.dim, "abandoned"];
    default: return ["○", t.dim, x.result ?? x.status ?? ""];
  }
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/;
const cleanLog = (text) => text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.replace(STAMP, "")).join("\n");

// Stage → Job → Task, skipping Phase (a job's parent) and Checkpoint records.
function buildTree(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const kids = new Map();
  for (const r of records) {
    if (!kids.has(r.parent)) kids.set(r.parent, []);
    kids.get(r.parent).push(r);
  }
  const ord = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.start ?? "").localeCompare(String(b.start ?? ""));
  const stageOf = (job) => {
    let p = byId.get(job.parent);
    while (p && p.type !== "Stage") p = byId.get(p.parent);
    return p ?? null;
  };
  const jobs = records.filter((r) => r.type === "Job");
  const stages = records.filter((r) => r.type === "Stage").sort(ord);
  const tasks = (job) => (kids.get(job.id) ?? []).filter((r) => r.type === "Task").sort(ord);
  const out = stages.map((s) => ({ rec: s, jobs: jobs.filter((j) => stageOf(j) === s).sort(ord).map((j) => ({ rec: j, tasks: tasks(j) })) }));
  const loose = jobs.filter((j) => !stageOf(j)).sort(ord).map((j) => ({ rec: j, tasks: tasks(j) }));
  if (loose.length) out.push({ rec: null, jobs: loose }); // classic / single-stage pipelines
  return out;
}

export default class AdoPipelines extends View {
  init(_props, cx) {
    this.org = null;
    this.me = null;
    this.projects = null;
    this.runs = null;
    this.failedProjects = [];
    this.error = null;
    this.loading = false;
    this.fetched = 0;
    this.filter = localStorage.getItem("filter") ?? "all";
    this.search = InputState.new({ placeholder: "Filter by pipeline, branch, repo, person, project…" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.detail = null; // { run, records, tree, error, loading, sel, log, lines, shown, logError, errorsOnly, folded }
    // props {project, build} open straight to that run (another mod or a pane can ask).
    const p = props() ?? {};
    if (p.project && p.build) {
      this.openRun({ id: Number(p.build), project: p.project, def: `Run ${p.build}`, status: "inProgress" }, cx);
    }
    this.refresh(cx);
    cx.timer.every(LIST_MS, (cx) => {
      if (this.detail) return;
      if ((this.runs ?? []).some(running) || Date.now() - this.fetched > STALE_MS) this.refresh(cx);
    });
    cx.timer.every(DETAIL_MS, (cx) => {
      const d = this.detail;
      if (!d || d.loading) return;
      if (running(d.run) || d.records?.some(running)) this.loadDetail(cx, true);
    });
  }

  async ensureContext() {
    if (!this.org) this.org = (await addonSettings()).ado?.org || null;
    if (!this.org) {
      const cfg = await az(["devops", "configure", "-l"]);
      const m = cfg.match(/organization\s*=\s*(\S+)/);
      if (!m) throw new Error("no org: set ado.org in addons.json or run az devops configure -d organization=…");
      this.org = m[1].replace(/\/+$/, "").split("/").pop();
    }
    if (!this.me) this.me = (await az(["account", "show", "--query", "user.name", "-o", "tsv"])).trim().toLowerCase();
    if (!this.projects) {
      const out = await rest(`https://dev.azure.com/${this.org}/_apis/projects?$top=500&api-version=7.1`, "value[].name");
      this.projects = JSON.parse(out) ?? [];
    }
  }

  base(project) {
    return `https://dev.azure.com/${this.org}/${encodeURIComponent(project)}`;
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.ensureContext();
        const failed = [];
        const lists = await Promise.all(this.projects.map(async (project) => {
          try {
            const out = await rest(`${this.base(project)}/_apis/build/builds?$top=${PER_PROJECT}&queryOrder=queueTimeDescending&api-version=7.1`, BUILD_QUERY);
            return (JSON.parse(out) ?? []).map((r) => ({ ...r, project }));
          } catch {
            failed.push(project);
            return [];
          }
        }));
        if (failed.length === this.projects.length && this.projects.length) throw new Error("every project failed: try `az login`");
        this.runs = lists.flat().sort((a, b) => Date.parse(b.queued) - Date.parse(a.queued)).slice(0, KEEP);
        this.failedProjects = failed;
        this.fetched = Date.now();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // ---- detail

  openRun(run_, cx) {
    this.detail = { run: run_, records: null, tree: [], error: null, loading: false, sel: null, log: null, lines: null, shown: null, logError: null, errorsOnly: false, folded: {} };
    this.loadDetail(cx, false);
  }

  closeRun(cx) {
    this.detail = null;
    cx.notify();
    if (Date.now() - this.fetched > LIST_MS) this.refresh(cx);
  }

  loadDetail(cx, poll) {
    const d = this.detail;
    d.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.ensureContext();
        const base = this.base(d.run.project);
        const [tl, info] = await Promise.all([
          rest(`${base}/_apis/build/builds/${d.run.id}/timeline?api-version=7.1`, TIMELINE_QUERY),
          poll || !d.run.num ? rest(`${base}/_apis/build/builds/${d.run.id}?api-version=7.1`, BUILD_QUERY.slice("value[].".length)) : null,
        ]);
        if (this.detail !== d) return;
        if (info) Object.assign(d.run, JSON.parse(info));
        d.records = JSON.parse(tl) ?? [];
        d.tree = buildTree(d.records);
        d.error = null;
        // First open: the first failed task, else the running one, else the last with a log.
        if (!d.sel) {
          const tasks = d.tree.flatMap((s) => s.jobs.flatMap((j) => j.tasks));
          const pick = tasks.find((x) => x.result === "failed" && x.log) ?? tasks.find((x) => running(x) && x.log) ?? [...tasks].reverse().find((x) => x.log);
          if (pick) this.selectTask(pick, cx);
        } else {
          const cur = d.records.find((r) => r.id === d.sel);
          if (cur?.log && (running(cur) || !d.log)) this.loadLog(cur, cx);
        }
      } catch (e) {
        if (this.detail === d) d.error = String(e?.message ?? e);
      } finally {
        if (this.detail === d) d.loading = false;
        cx.notify();
      }
    });
  }

  selectTask(rec, cx) {
    const d = this.detail;
    d.sel = rec.id;
    d.log = null;
    d.lines = null;
    d.shown = null;
    d.logError = null;
    if (rec.log) this.loadLog(rec, cx);
    else d.logError = running(rec) ? "Waiting for this step to start…" : "This step has no log.";
    cx.notify();
  }

  loadLog(rec, cx) {
    const d = this.detail;
    const id = rec.id;
    cx.spawn(async (cx) => {
      try {
        const text = cleanLog(await rest(`${this.base(d.run.project)}/_apis/build/builds/${d.run.id}/logs/${rec.log}?api-version=7.1`));
        if (this.detail !== d || d.sel !== id) return;
        if (text === d.log && d.lines) return;
        d.log = text;
        this.showLog(d);
      } catch (e) {
        if (this.detail === d && d.sel === id) d.logError = String(e?.message ?? e);
      } finally {
        cx.notify();
      }
    });
  }

  showLog(d) {
    if (!d.lines || d.lines.raw !== d.log) {
      let lines = parseLog(d.log ?? "");
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      lines.raw = d.log;
      d.lines = lines;
    }
    d.shown = d.errorsOnly ? d.lines.filter(isProblem) : d.lines;
  }

  dismiss() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  browse(url) {
    exec("open", [url]).catch((e) => notify({ title: "Couldn't open browser", body: String(e?.message ?? e), level: "error" }));
  }

  // ---- list

  mine(r) {
    return (r.byMail ?? "").toLowerCase() === this.me;
  }

  visible() {
    const q = this.search.value().trim().toLowerCase();
    return (this.runs ?? []).filter((r) => {
      if (this.filter === "mine" && !this.mine(r)) return false;
      if (this.filter === "failed" && r.result !== "failed") return false;
      if (this.filter === "running" && !running(r)) return false;
      if (!q) return true;
      return [r.def, r.num, branchLabel(r.branch), r.repo, r.by, r.project, String(r.id)].some((s) => (s ?? "").toLowerCase().includes(q));
    });
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

  glyph(t, x, size = 13) {
    const [g, c, label] = look(t, x);
    let el = div().flex_none().w(16).text_size(size).font_semibold().text_color(c).child(g);
    if (running(x) && x.status !== "notStarted" && x.state !== "pending") el = el.loop("opacity", { from: 0.35, to: 1, period: 1200 });
    return el;
  }

  windowButtons(t, el) {
    return el.when(Boolean(props()?.overlay), (el) => el
      .child(this.iconButton(t, "as-pane", "mods/ado-pipelines/panel-right.svg", "Open beside this pane", () => {
        this.dismiss();
        run("pane.split", { direction: "right", mod: "ado-pipelines" });
      }))
      .child(this.iconButton(t, "close", "mods/ado-pipelines/x.svg", "Close", () => this.dismiss())));
  }

  listHeader(t, shown) {
    const all = this.runs ?? [];
    const counts = { all: all.length, mine: all.filter((r) => this.mine(r)).length, failed: all.filter((r) => r.result === "failed").length, running: all.filter(running).length };
    const status = this.error ? "fetch failed" : this.loading ? "loading…" : this.fetched ? (Date.now() - this.fetched < 60000 ? "updated just now" : `updated ${ago(new Date(this.fetched).toISOString())} ago`) : "";
    const head = h_flex().flex_none().px(16).py(10).gap(12).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/ado-pipelines/rocket.svg").size(16).text_color(t.accent))
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Pipelines"))
        .child(div().text_size(12).text_color(t.dim).child(this.org ? `${this.org} · ${shown}/${all.length}` : "")))
      .child(h_flex().gap(2).p(2).rounded(8).bg(t.raised).children(
        FILTERS.map((f) => this.pill(t, `f-${f.key}`, `${f.label} ${counts[f.key]}`, this.filter === f.key, (_e, cx) => {
          this.filter = f.key;
          localStorage.setItem("filter", f.key);
          cx.notify();
        }))))
      .child(h_flex().flex_1().min_w(180).h(26).px(8).rounded(6).bg(t.background).border(1).border_color(t.input)
        .child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim)
        .when(this.failedProjects.length > 0, (el) => el.id("partial").tooltip(`Couldn't read: ${this.failedProjects.join(", ")}`))
        .child(this.failedProjects.length && !this.error ? `${status} · ${this.failedProjects.length} skipped` : status))
      .child(this.iconButton(t, "refresh", "mods/ado-pipelines/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx), this.loading));
    return this.windowButtons(t, head);
  }

  runRow(t, r) {
    const [, color, label] = look(t, r);
    return h_flex().id(`run-${r.project}-${r.id}`).px(12).py(7).gap(12).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openRun(r, cx))
      .child(this.glyph(t, r, 14))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().flex_shrink_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(r.def ?? ""))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.num ?? "")))
        .child(div().truncate().text_size(11.5).text_color(t.dim)
          .child(`${r.project} · ${r.repo ?? ""} · ${branchLabel(r.branch)}${r.reason ? ` · ${r.reason}` : ""}`)))
      .child(div().flex_none().w(140).truncate().text_size(12).text_color(t.muted).child(r.by ?? ""))
      .child(div().flex_none().w(110).text_size(11.5).text_color(color).child(label))
      .child(div().flex_none().w(70).text_size(11.5).text_color(t.dim).child(dur(r.start, r.finish)))
      .child(div().flex_none().w(36).text_size(11.5).text_color(t.dim).child(ago(r.queued)));
  }

  listBody(t, list) {
    const center = (...kids) => v_flex().flex_1().items_center().justify_center().gap(6).p(24).children(kids);
    if (this.error && !this.runs) {
      return center(
        div().text_size(13).text_color(t.blocked).child("Couldn't load pipeline runs"),
        div().text_size(12).text_color(t.muted).child(this.error),
        div().text_size(12).text_color(t.dim).child("Try `az login` in a terminal, then refresh."));
    }
    if (!this.runs) return center(div().text_size(12).text_color(t.dim).child("Loading runs from every project…"));
    if (!list.length) return center(div().text_size(12).text_color(t.dim).child("No runs match."));
    return div().id("runs").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().p(8).gap(1).children(list.map((r) => this.runRow(t, r))));
  }

  // ---- detail view

  detailHeader(t) {
    const d = this.detail;
    const r = d.run;
    const [, color, label] = look(t, r);
    const url = `${this.base(r.project)}/_build/results?buildId=${r.id}&view=results`;
    const head = h_flex().flex_none().px(12).py(10).gap(10).items_center().border_b(1).border_color(t.border)
      .child(this.iconButton(t, "back", "mods/ado-pipelines/back.svg", "Back to runs", (_e, cx) => this.closeRun(cx)))
      .child(this.glyph(t, r, 15))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().truncate().text_size(14).font_semibold().text_color(t.foreground).child(r.def ?? ""))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(r.num ?? ""))
          .child(div().flex_none().text_size(12).text_color(color).child(label)))
        .child(div().truncate().text_size(11.5).text_color(t.dim)
          .child(`${r.project} · ${r.repo ?? ""} · ${branchLabel(r.branch)} · ${r.by ?? ""} · ${dur(r.start, r.finish)}${r.finish ? "" : " so far"}`)))
      .child(div().text_size(11).text_color(d.error ? t.blocked : t.dim).child(d.error ? "fetch failed" : d.loading ? "loading…" : running(r) ? "live" : ""))
      .child(this.iconButton(t, "reload", "mods/ado-pipelines/refresh.svg", "Reload", (_e, cx) => this.loadDetail(cx, true), d.loading))
      .child(this.iconButton(t, "web", "mods/ado-pipelines/external.svg", "Open in browser", () => this.browse(url)));
    return this.windowButtons(t, head);
  }

  recordRow(t, rec, depth, { fold } = {}) {
    const d = this.detail;
    const selected = d.sel === rec.id;
    const counts = [rec.errors ? `${rec.errors}✗` : "", rec.warnings ? `${rec.warnings}!` : ""].filter(Boolean).join(" ");
    const tip = (rec.issues ?? []).slice(0, 6).map((i) => `${i.type}: ${(i.message ?? "").slice(0, 200)}`).join("\n");
    let row = h_flex().id(`rec-${rec.id}`).pl(8 + depth * 14).pr(8).py(depth === 2 ? 4 : 5).gap(6).items_center().rounded(5).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => {
        if (fold) { d.folded[rec.id] = !d.folded[rec.id]; cx.notify(); }
        else this.selectTask(rec, cx);
      });
    if (tip) row = row.tooltip(tip);
    return row
      .when(Boolean(fold), (el) => el.child(svg(d.folded[rec.id] ? "mods/ado-pipelines/chev-right.svg" : "mods/ado-pipelines/chev-down.svg").size(11).flex_none().text_color(t.dim)))
      .child(this.glyph(t, rec, 12))
      .child(div().flex_1().min_w(0).truncate()
        .text_size(depth === 0 ? 12.5 : 12)
        .when(depth < 2, (el) => el.font_semibold())
        .text_color(rec.result === "skipped" ? t.dim : depth === 2 ? t.foreground : t.muted)
        .child(rec.name ?? ""))
      .when(Boolean(counts), (el) => el.child(div().flex_none().text_size(10.5).text_color(rec.errors ? t.blocked : t.done).child(counts)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(dur(rec.start, rec.finish)));
  }

  timeline(t) {
    const d = this.detail;
    if (!d.records) return v_flex().p(12).child(div().text_size(12).text_color(d.error ? t.blocked : t.dim).child(d.error ?? "Loading timeline…"));
    if (!d.tree.length) return v_flex().p(12).child(div().text_size(12).text_color(t.dim).child("No stages yet."));
    const rows = [];
    for (const stage of d.tree) {
      const multi = d.tree.length > 1 || stage.rec;
      if (stage.rec) rows.push(this.recordRow(t, stage.rec, 0, { fold: true }));
      if (stage.rec && d.folded[stage.rec.id]) continue;
      for (const job of stage.jobs) {
        rows.push(this.recordRow(t, job.rec, multi ? 1 : 0, { fold: true }));
        if (d.folded[job.rec.id]) continue;
        for (const task of job.tasks) rows.push(this.recordRow(t, task, 2));
      }
    }
    return v_flex().p(6).gap(1).children(rows);
  }

  // Theme name or hex → a color.
  color(t, c, fallback) {
    if (!c) return fallback;
    return c.startsWith("#") ? c : t[c] ?? fallback;
  }

  logLine(t, l, font) {
    const problem = l.kind === "error" ? t.ansi1 : l.kind === "warning" ? t.ansi3 : null;
    const tint = problem && /^#[0-9a-f]{6}$/i.test(problem) ? problem + "2e" : null;
    return h_flex().items_start().w_full().px(8).gap(10).font_family(font).text_size(12)
      .when(Boolean(tint), (el) => el.bg(tint))
      .when(l.kind === "section", (el) => el.pt(6))
      .child(div().flex_none().w(44).text_color(problem ?? t.dim).text_right().child(String(l.n)))
      .when(Boolean(problem), (el) => el.child(div().flex_none().px(5).rounded(3).text_size(10.5).font_semibold()
        .text_color(t.background).bg(problem).child(l.kind === "error" ? "ERROR" : "WARN")))
      .child(h_flex().flex_1().min_w(0).flex_wrap().items_start().children(
        l.segs.length
          ? l.segs.map((s) => {
              let el = div().flex_shrink_1().min_w(0).text_color(this.color(t, s.color, t.foreground)).child(s.text);
              if (s.bold) el = el.font_semibold();
              if (s.url) el = el.underline();
              return el;
            })
          : [div().child(" ")]));
  }

  logPane(t) {
    const d = this.detail;
    const rec = d.records?.find((r) => r.id === d.sel);
    const problems = d.lines ? d.lines.filter(isProblem).length : 0;
    const bar = h_flex().flex_none().px(12).py(7).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(rec?.name ?? "Log"))
      .when(Boolean(d.lines), (el) => el
        .child(div().text_size(11).text_color(t.dim).child(`${d.lines.length} lines`))
        .child(this.pill(t, "errors-only", `Errors only ${problems}`, d.errorsOnly, (_e, cx) => {
          d.errorsOnly = !d.errorsOnly;
          this.showLog(d);
          cx.notify();
        }))
        .child(this.pill(t, "copy-log", "Copy", false, (_e, cx) => {
          cx.write_to_clipboard(plainText(d.shown ?? d.lines));
          notify({ title: "Log copied", body: `${(d.shown ?? d.lines).length} lines`, level: "info", timeout: 2000 });
        })));
    let body;
    if (d.shown) {
      const lines = d.shown;
      const font = settings().font_family;
      const id = `log-${d.sel}-${d.errorsOnly ? "e" : "a"}`;
      body = lines.length
        ? v_flex().relative().flex_1().min_h(0).py(6)
          .child(list(id, lines.length, (i) => String(lines[i].n), (i) => this.logLine(t, lines[i], font)).size_full())
          .child(Scrollbar.vertical(id).absolute().inset_0())
        : v_flex().flex_1().p(14).child(div().text_size(12).text_color(t.dim).child(d.errorsOnly ? "No error or warning lines." : "This log is empty."));
    } else body = v_flex().flex_1().p(14).child(div().text_size(12).text_color(d.logError ? t.muted : t.dim)
      .child(d.logError ?? (d.sel ? "Loading log…" : "Pick a step to see its log.")));
    return v_flex().flex_1().h_full().min_w(0).min_h(0).bg(t.background).child(bar).child(body);
  }

  render() {
    const t = theme();
    const root = v_flex().size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground);
    if (this.detail) {
      return root.child(this.detailHeader(t))
        .child(h_flex().flex_1().min_h(0).items_stretch()
          .child(div().id("timeline").flex_none().w(340).h_full().overflow_y_scrollbar().border_r(1).border_color(t.border).child(this.timeline(t)))
          .child(this.logPane(t)));
    }
    const list = this.visible();
    return root.child(this.listHeader(t, list.length)).child(this.listBody(t, list));
  }
}
