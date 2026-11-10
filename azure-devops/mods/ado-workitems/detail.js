// One work item, in full: the fields, its rich-text fields rendered (Markdown
// or HTML, whichever ADO stores each field as), and the discussion. Edit turns
// the fields into inputs; Save sends a JSON patch guarded by the revision, so
// a change someone made meanwhile is refused instead of overwritten.
//
// Rich fields: Markdown fields edit as Markdown. HTML fields edit as their
// HTML source (lossless), or "Convert to Markdown" turns the source into
// Markdown and saves the field as Markdown from then on (ADO's switch is one
// way). An empty field with no format yet is written as Markdown.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, notify, openOverlay, appHome } from "herdr";
import { az, get, patch, ago, lastSegment, typeColor, stateColor, ADO_RESOURCE } from "./ado.js";

const ICON = (n) => `mods/ado-workitems/${n}.svg`;
// Rich fields shown first, in this order; other HTML fields of the type follow.
const RICH_ORDER = ["System.Description", "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.Common.AcceptanceCriteria", "Microsoft.VSTS.TCM.SystemInfo"];
// Shown even when empty (if the type has them).
const RICH_ALWAYS = new Set(["System.Description", "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.Common.AcceptanceCriteria"]);
const RICH_SKIP = new Set(["System.History"]);
const POINTS = ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.Size"];
const PRIORITIES = [1, 2, 3, 4];

// Per org: the HTML field reference names. Per project+type: fields and states.
const htmlFields = new Map();
const typeMeta = new Map();

async function loadHtmlFields(org) {
  if (!htmlFields.has(org)) {
    const refs = await get(`https://dev.azure.com/${org}/_apis/wit/fields?api-version=7.1`, "value[?type=='html'].[referenceName,name]");
    htmlFields.set(org, new Map(refs ?? []));
  }
  return htmlFields.get(org);
}

async function loadTypeMeta(org, project, type) {
  const k = `${org}/${project}/${type}`;
  if (!typeMeta.has(k)) {
    const base = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}`;
    const [fields, states] = await Promise.all([
      get(`${base}/fields?api-version=7.1`, "value[].{ref:referenceName,name:name}"),
      get(`${base}/states?api-version=7.1`, "value[].{name:name,category:category,color:color}"),
    ]);
    typeMeta.set(k, { fields: fields ?? [], states: states ?? [] });
  }
  return typeMeta.get(k);
}

// ---- images
// TextView can't load ADO attachments (they need the az login), so rich text
// is split at its images: text runs go to TextView, each image is downloaded
// once (az for ADO, curl otherwise) into the app's cache and drawn with
// image(). Big pictures get a display copy at most VIEW_PX on a side; the
// original is what "Open in Preview" opens. Click one for the full viewer.

const IMG_DIR = "cache/ado-workitems";
const VIEW_PX = 3000;
const INLINE_MAX_H = 420;
const INLINE_MAX_W = 640;
// Cached files not used for this many days are deleted (pruneImages, once
// per session); every use refreshes a file's date.
const IMG_KEEP_DAYS = 14;
const images = new Map(); // url → { state: "loading" | "ok" | "error", rel, abs, w, h, error }

const MD_IMG = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMG = /<img\b[^>]*>/gi;
const FENCE = /(^|\n)((?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)|$))/;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
function imgFile(url) {
  const id = (url.match(/attachments\/([0-9a-f-]{36})/i) ?? [])[1] ?? hash(url);
  const name = decodeURIComponent((url.match(/[?&]fileName=([^&]+)/i) ?? [])[1] ?? url.split(/[?#]/)[0]);
  const ext = (name.match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i) ?? [, "png"])[1].toLowerCase();
  return { base: id, ext };
}

async function fetchImage(url) {
  const { base, ext } = imgFile(url);
  const dir = `${appHome()}/${IMG_DIR}`;
  const abs = `${dir}/${base}.${ext}`;
  await exec("mkdir", ["-p", dir]);
  if ((await exec("test", ["-s", abs])).code !== 0) {
    if (/^https:\/\/([^/]+\.)?(dev\.azure\.com|visualstudio\.com)\//i.test(url)) {
      await az(["rest", "--resource", ADO_RESOURCE, "-u", url, "--output-file", abs]);
    } else {
      const r = await exec("curl", ["-q", "-sSfL", "-m", "30", "-o", abs, url]);
      if (r.code !== 0) throw new Error((r.stderr || "download failed").trim());
    }
  }
  else await exec("touch", [abs]);
  let w = 0, h = 0, rel = `${IMG_DIR}/${base}.${ext}`;
  if (ext !== "svg") {
    const dims = (await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs])).stdout ?? "";
    w = Number((dims.match(/pixelWidth:\s*(\d+)/) ?? [])[1]) || 0;
    h = Number((dims.match(/pixelHeight:\s*(\d+)/) ?? [])[1]) || 0;
    if (Math.max(w, h) > VIEW_PX && ext !== "gif") {
      const view = `${dir}/${base}.view.png`;
      if ((await exec("test", ["-s", view])).code !== 0) {
        const r = await exec("sips", ["-s", "format", "png", "-Z", String(VIEW_PX), abs, "--out", view]);
        if (r.code !== 0) throw new Error("couldn't shrink the image");
      } else await exec("touch", [view]);
      rel = `${IMG_DIR}/${base}.view.png`;
    }
  }
  return { rel, abs, w: w || 800, h: h || 450 };
}

// Deletes cached images unused for IMG_KEEP_DAYS. Once per session.
let pruned = false;
export function pruneImages() {
  if (pruned) return;
  pruned = true;
  exec("find", [`${appHome()}/${IMG_DIR}`, "-type", "f", "-mtime", `+${IMG_KEEP_DAYS}`, "-delete"]).catch(() => {});
}

// Rich text → [{ text } | { img, alt }], images only outside code.
function segments(value, fmt) {
  const out = [];
  let buf = "";
  const take = (part, re, pick) => {
    let last = 0;
    for (const m of part.matchAll(re)) {
      const { url, alt } = pick(m);
      if (!url || /^data:/i.test(url)) continue;
      buf += part.slice(last, m.index);
      if (buf.trim()) out.push({ text: buf });
      buf = "";
      out.push({ img: url, alt });
      last = m.index + m[0].length;
    }
    buf += part.slice(last);
  };
  if (fmt === "markdown") {
    unescapeCode(value).split(FENCE).forEach((part, i) => {
      if (i % 3 === 2) buf += part;
      else take(part, MD_IMG, (m) => ({ url: decode(m[2]), alt: decode(m[1]) }));
    });
  } else {
    const attr = (tag, n) => decode((tag.match(new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")) ?? [])[2] ?? "");
    take(value ?? "", HTML_IMG, (m) => ({ url: attr(m[0], "src"), alt: attr(m[0], "alt") }));
  }
  if (buf.trim()) out.push({ text: buf });
  return out;
}

// ---- HTML → Markdown, for "Convert to Markdown". Covers what ADO's editor
// produces: headings, paragraphs, emphasis, links, images, code, lists, tables.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);

// ADO stores Markdown HTML-escaped (`"` as `&quot;`). A Markdown renderer
// decodes entities in prose but shows them literally in code, so decode the
// code: fenced blocks and inline spans.
export function unescapeCode(md) {
  return (md ?? "").split(FENCE).map((part, i) =>
    i % 3 === 2 ? decode(part) : part.replace(/`[^`\n]+`/g, decode)).join("");
}

export function htmlToMarkdown(html) {
  const out = [];
  const lists = [];
  const tables = [];
  let pre = 0;
  let href = null;
  const attr = (a, n) => (a.match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, "i")) ?? a.match(new RegExp(`\\b${n}\\s*=\\s*'([^']*)'`, "i")) ?? [])[1] ?? "";
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html ?? ""))) {
    if (m[4] != null) {
      let s = decode(m[4]);
      if (!pre) s = s.replace(/\s+/g, " ");
      if (tables.length) s = s.replace(/\|/g, "\\|");
      out.push(s);
      continue;
    }
    if (!m[2]) continue; // comment
    const close = Boolean(m[1]);
    const tag = m[2].toLowerCase();
    const a = m[3];
    const h = /^h([1-6])$/.exec(tag);
    if (h) { out.push(close ? "\n\n" : `\n\n${"#".repeat(Number(h[1]))} `); continue; }
    switch (tag) {
      case "br": out.push(pre ? "\n" : tables.length ? " " : "\\\n"); break;
      case "p": case "div": if (!tables.length) out.push("\n\n"); break;
      case "strong": case "b": out.push("**"); break;
      case "em": case "i": out.push("_"); break;
      case "s": case "del": case "strike": out.push("~~"); break;
      case "code": if (!pre) out.push("`"); break;
      case "pre": pre += close ? -1 : 1; out.push(close ? "\n```\n\n" : "\n\n```\n"); break;
      case "blockquote": out.push(close ? "\n\n" : "\n\n> "); break;
      case "hr": out.push("\n\n---\n\n"); break;
      case "ul": case "ol":
        if (close) lists.pop(); else lists.push({ ol: tag === "ol", n: 0 });
        out.push(lists.length || close ? "\n" : "\n\n");
        if (close && !lists.length) out.push("\n");
        break;
      case "li":
        if (!close) {
          const l = lists.at(-1) ?? { ol: false, n: 0 };
          l.n++;
          out.push(`\n${"   ".repeat(Math.max(0, lists.length - 1))}${l.ol ? `${l.n}. ` : "- "}`);
        }
        break;
      case "a":
        if (!close) { href = attr(a, "href"); out.push("["); } else { out.push(`](${href ?? ""})`); href = null; }
        break;
      case "img": out.push(`![${attr(a, "alt")}](${attr(a, "src")})`); break;
      case "table": if (close) { tables.pop(); out.push("\n\n"); } else { tables.push({ rows: 0, cells: 0 }); out.push("\n\n"); } break;
      case "tr": {
        const tb = tables.at(-1);
        if (!tb) break;
        if (!close) { tb.cells = 0; out.push("\n|"); } else {
          if (tb.rows++ === 0) out.push(`\n|${" --- |".repeat(Math.max(1, tb.cells))}`);
        }
        break;
      }
      case "td": case "th": {
        const tb = tables.at(-1);
        if (!tb) break;
        if (!close) { tb.cells++; out.push(" "); } else out.push(" |");
        break;
      }
      default: break;
    }
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// One pull request, trimmed to what the Pull requests section shows.
const PR_QUERY = "{id:pullRequestId,title:title,status:status,draft:isDraft,source:sourceRefName,target:targetRefName," +
  "repo:repository.name,project:repository.project.name,author:createdBy.displayName,votes:reviewers[].vote}";

// ---- the view

export class Detail {
  // host: { org, back(cx), refine(item), open(item), updated(item), notify }
  constructor(host, id, cx) {
    this.host = host;
    this.id = id;
    this.wi = null;
    this.meta = null;
    this.comments = null;
    this.prs = null; // linked pull requests: [{ id, pr? , error? }]
    this.error = null;
    this.edit = null;
    this.saving = false;
    this.saveError = null;
    this.confirmDiscard = false;
    this.load(cx);
  }

  get org() { return this.host.org; }
  get f() { return this.wi?.fields ?? {}; }
  get project() { return this.f["System.TeamProject"]; }
  get type() { return this.f["System.WorkItemType"]; }
  url() { return `https://dev.azure.com/${this.org}/${encodeURIComponent(this.project ?? "")}/_workitems/edit/${this.id}`; }
  summary() {
    const f = this.f;
    return { id: this.id, project: this.project, type: this.type, title: f["System.Title"], state: f["System.State"],
      assignee: f["System.AssignedTo"]?.displayName ?? null, area: f["System.AreaPath"], iteration: f["System.IterationPath"] };
  }
  format(ref) { return (this.wi?.multilineFieldsFormat?.[ref] ?? "").toLowerCase(); }

  load(cx) {
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const wi = await get(`https://dev.azure.com/${this.org}/_apis/wit/workitems/${this.id}?$expand=relations&api-version=7.1`);
        const project = wi.fields["System.TeamProject"];
        const [meta, html, comments] = await Promise.all([
          loadTypeMeta(this.org, project, wi.fields["System.WorkItemType"]),
          loadHtmlFields(this.org),
          get(`https://dev.azure.com/${this.org}/${encodeURIComponent(project)}/_apis/wit/workItems/${this.id}/comments?api-version=7.1-preview.4&$top=100&order=desc`, "comments")
            .catch(() => null),
        ]);
        this.wi = wi;
        this.setMeta(meta, html);
        this.comments = comments ?? [];
        this.loadImages(cx);
        this.loadPrs(wi.relations, cx);
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.error = /TF401232/.test(msg) ? `#${this.id} doesn't exist, or you can't read it` : msg;
      } finally {
        cx.notify();
      }
    });
  }

  // Pull requests linked from this item ("Pull Request" artifact links:
  // vstfs:///Git/PullRequestId/<project>%2F<repo>%2F<id>), fetched by id.
  loadPrs(relations, cx) {
    const ids = [...new Set((relations ?? [])
      .filter((r) => r.rel === "ArtifactLink")
      .map((r) => /^vstfs:\/\/\/Git\/PullRequestId\/.*%2f(\d+)$/i.exec(r.url ?? "")?.[1])
      .filter(Boolean).map(Number))];
    this.prs = ids.map((id) => ({ id }));
    cx.notify();
    for (const entry of this.prs) {
      cx.spawn(async (cx) => {
        try {
          entry.pr = await get(`https://dev.azure.com/${this.org}/_apis/git/pullrequests/${entry.id}?api-version=7.1`, PR_QUERY);
        } catch (e) {
          const msg = String(e?.message ?? e);
          entry.error = /TF401180/.test(msg) ? "deleted, or you can't read it" : msg;
        } finally {
          cx.notify();
        }
      });
    }
  }

  // Every picture in the rich fields and comments, fetched in the background.
  loadImages(cx) {
    const sources = [
      ...(this.meta?.rich ?? []).map((ref) => [this.f[ref], this.format(ref) || "html"]),
      ...(this.comments ?? []).map((c) => (c.renderedText ? [c.renderedText, "html"] : [c.text, (c.format ?? "html").toLowerCase()])),
    ];
    for (const [value, fmt] of sources) {
      if (!value) continue;
      for (const seg of segments(value, fmt)) {
        if (!seg.img || images.has(seg.img)) continue;
        images.set(seg.img, { state: "loading" });
        cx.spawn(async (cx) => {
          try {
            images.set(seg.img, { state: "ok", ...(await fetchImage(seg.img)) });
          } catch (e) {
            images.set(seg.img, { state: "error", error: String(e?.message ?? e) });
          }
          cx.notify();
        });
      }
    }
  }

  zoom(url, alt) {
    const im = images.get(url);
    if (im?.state !== "ok") return;
    openOverlay({ mod: "ado-workitems", kind: "dialog", width: 0.97, height: 0.95,
      props: { image: im.rel, original: im.abs, title: alt || `#${this.id} image`, w: im.w, h: im.h } });
  }

  imageBlock(t, id, url, alt) {
    const im = images.get(url);
    const note = (text, color) => h_flex().id(id).gap(8).px(10).py(8).rounded(6).border(1).border_color(t.border)
      .text_size(11.5).text_color(color).cursor_pointer().tooltip(url)
      .on_click(() => exec("open", [url]).catch(() => {}))
      .child(svg(ICON("external")).size(12).text_color(color))
      .child(div().min_w(0).truncate().child(text));
    if (!im) return note(`${alt || "Image"}: opens in browser (shows here after saving)`, t.muted);
    if (im.state === "loading") return note(`Loading ${alt || "image"}…`, t.dim);
    if (im.state === "error") return note(`Couldn't load ${alt || "image"} (${im.error}). Click to open it in the browser.`, t.blocked);
    // A fixed box in the image's proportions, at most INLINE_MAX_W wide and
    // INLINE_MAX_H tall (images don't size from their aspect ratio, and the
    // pane's width can't be measured). Click for the full view.
    const scale = Math.min(1, INLINE_MAX_W / im.w, INLINE_MAX_H / im.h);
    const w = Math.round(im.w * scale);
    const h = Math.round(im.h * scale);
    return v_flex().id(id).max_w_full().gap(4).cursor_pointer().tooltip("Click to view full screen")
      .on_click(() => this.zoom(url, alt))
      .child(div().w(w).max_w_full().h(h).rounded(6).overflow_hidden().border(1).border_color(t.border)
        .hover((s) => s.border_color(t.accent))
        .child(image(im.rel).size_full()))
      .when(Boolean(alt), (el) => el.child(div().text_size(11).text_color(t.dim).child(alt)));
  }

  setMeta(meta, html) {
    const has = new Set(meta.fields.map((x) => x.ref));
    const names = new Map(meta.fields.map((x) => [x.ref, x.name]));
    const rich = meta.fields.filter((x) => html.has(x.ref) && !RICH_SKIP.has(x.ref)).map((x) => x.ref);
    const rank = (r) => (RICH_ORDER.indexOf(r) + 1 || 99);
    rich.sort((a, b) => rank(a) - rank(b) || (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
    this.meta = { states: meta.states, rich, names, points: POINTS.find((p) => has.has(p)) ?? null, hasPriority: has.has("Microsoft.VSTS.Common.Priority") };
  }

  // ---- editing

  startEdit(cx) {
    const f = this.f;
    const mk = (value, placeholder) => InputState.new({ value: value == null ? "" : String(value), placeholder });
    const rich = {};
    for (const ref of this.meta.rich) {
      const raw = f[ref] ?? "";
      const value = this.format(ref) === "markdown" ? unescapeCode(raw) : raw;
      const state = TextareaState.new({ value, placeholder: "Markdown…" });
      state.set_auto_grow(5, 28);
      // Empty with no format yet: written as Markdown.
      const fmt = this.format(ref) || (value ? "html" : "markdown");
      rich[ref] = { state, orig: value, fmt, origFmt: this.format(ref) || null, tab: "write" };
    }
    this.edit = {
      title: mk(f["System.Title"]),
      state: f["System.State"],
      assigned: mk(f["System.AssignedTo"]?.uniqueName ?? "", "Email, or blank for unassigned"),
      priority: f["Microsoft.VSTS.Common.Priority"] ?? null,
      points: mk(this.meta.points ? f[this.meta.points] : ""),
      iteration: mk(f["System.IterationPath"]),
      area: mk(f["System.AreaPath"]),
      tags: mk((f["System.Tags"] ?? "").split(";").map((x) => x.trim()).filter(Boolean).join("; "), "tag; tag"),
      rich,
    };
    this.saveError = null;
    this.confirmDiscard = false;
    cx.notify();
  }

  ops() {
    const f = this.f;
    const e = this.edit;
    const ops = [];
    const set = (ref, value) => ops.push({ op: "add", path: `/fields/${ref}`, value });
    const title = e.title.value().trim();
    if (title !== (f["System.Title"] ?? "")) set("System.Title", title);
    if (e.state !== f["System.State"]) set("System.State", e.state);
    const who = e.assigned.value().trim();
    if (who !== (f["System.AssignedTo"]?.uniqueName ?? "")) set("System.AssignedTo", who);
    if (this.meta.hasPriority && e.priority !== (f["Microsoft.VSTS.Common.Priority"] ?? null)) set("Microsoft.VSTS.Common.Priority", e.priority);
    if (this.meta.points) {
      const p = e.points.value().trim();
      const cur = f[this.meta.points];
      if (p !== (cur == null ? "" : String(cur))) {
        if (p === "") { if (cur != null) ops.push({ op: "remove", path: `/fields/${this.meta.points}` }); }
        else set(this.meta.points, Number(p));
      }
    }
    if (e.iteration.value().trim() !== (f["System.IterationPath"] ?? "")) set("System.IterationPath", e.iteration.value().trim());
    if (e.area.value().trim() !== (f["System.AreaPath"] ?? "")) set("System.AreaPath", e.area.value().trim());
    const norm = (s) => s.split(";").map((x) => x.trim()).filter(Boolean).join("; ");
    const tags = norm(e.tags.value());
    if (tags !== norm(f["System.Tags"] ?? "")) set("System.Tags", tags);
    for (const [ref, r] of Object.entries(e.rich)) {
      const v = r.state.value();
      const fmtChanged = r.fmt === "markdown" && r.origFmt !== "markdown";
      if (v !== r.orig || (fmtChanged && v)) {
        set(ref, v);
        if (fmtChanged) ops.push({ op: "add", path: `/multilineFieldsFormat/${ref}`, value: "Markdown" });
      }
    }
    return ops;
  }

  validate() {
    if (!this.edit.title.value().trim()) return "Title can't be empty";
    if (this.meta.points) {
      const p = this.edit.points.value().trim();
      if (p && !Number.isFinite(Number(p))) return "Points must be a number";
    }
    return null;
  }

  save(cx) {
    if (this.saving) return;
    const bad = this.validate();
    if (bad) { this.saveError = bad; cx.notify(); return; }
    const ops = this.ops();
    if (!ops.length) { this.edit = null; cx.notify(); return; }
    this.saving = true;
    this.saveError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const wi = await patch(`https://dev.azure.com/${this.org}/_apis/wit/workitems/${this.id}?api-version=7.1`,
          [{ op: "test", path: "/rev", value: this.wi.rev }, ...ops]);
        this.wi = wi;
        this.edit = null;
        this.host.updated?.({ ...this.wi.fields, "System.Id": this.wi.id });
        this.loadImages(cx);
        notify({ title: `Saved #${this.id}`, body: wi.fields["System.Title"], level: "info", timeout: 2500 });
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.saveError = /VS403351|Test Operation for path \/rev/.test(msg)
          ? "Someone changed this work item since you opened it. Copy your edits, Reload, and edit again."
          : msg;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  dirty() { return Boolean(this.edit) && this.ops().length > 0; }

  // Back / Cancel with unsaved edits: ask once.
  leave(cx, then) {
    if (this.dirty() && !this.confirmDiscard) {
      this.confirmDiscard = true;
      cx.notify();
      cx.timer.after(4000, (cx) => { this.confirmDiscard = false; cx.notify(); });
      return;
    }
    this.confirmDiscard = false;
    then(cx);
  }

  // ---- pieces

  button(t, id, label, onClick, { primary = false, icon, tip, disabled = false, danger = false } = {}) {
    const fg = primary ? t.background : danger ? t.blocked : t.foreground;
    let el = h_flex().id(id).gap(6).px(10).py(4).rounded(6).items_center().text_size(12)
      .text_color(fg)
      .when(primary, (el) => el.bg(t.accent))
      .when(!primary, (el) => el.border(1).border_color(danger ? t.blocked : t.border))
      .when(disabled, (el) => el.opacity(0.5))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(onClick))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (icon) el = el.child(svg(ICON(icon)).size(13).text_color(fg));
    if (tip) el = el.tooltip(tip);
    return el.child(label);
  }

  icon(t, id, icon, tip, onClick) {
    return div().id(id).p(5).rounded(6).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(svg(ICON(icon)).size(14).text_color(t.muted));
  }

  pill(t, id, label, active, onClick, color) {
    return div().id(id).px(8).py(2).rounded(10).text_size(11.5).cursor_pointer()
      .border(1).border_color(active ? color ?? t.accent : t.border)
      .text_color(active ? color ?? t.foreground : t.muted)
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  rich(id, value, fmt) {
    const open = (url) => exec("open", [url]).catch(() => {});
    const text = (key, v) => (fmt === "markdown" ? TextView.markdown(key, v) : TextView.html(key, v))
      .w_full().text_size(13).selectable(true).on_link_click((url) => open(url));
    const segs = segments(value, fmt);
    if (segs.length === 1 && segs[0].text != null) return text(id, segs[0].text);
    return v_flex().w_full().gap(10).children(segs.map((sg, i) =>
      sg.img ? this.imageBlock(this.t, `${id}-img${i}`, sg.img, sg.alt) : text(`${id}-${i}`, sg.text)));
  }

  field(t, label, value) {
    return v_flex().gap(3).min_w(0)
      .child(div().text_size(10.5).text_color(t.dim).child(label))
      .child(typeof value === "string" || value == null
        ? div().text_size(12.5).text_color(value ? t.foreground : t.dim).truncate().child(value || "—")
        : value);
  }

  input(t, state, w) {
    let box = h_flex().h(28).px(8).rounded(6).bg(t.background).border(1).border_color(t.input).items_center();
    box = w ? box.w(w) : box.w_full();
    return box.child(Input.new(state).h_full().w_full().text_size(12.5).text_color(t.foreground));
  }

  header(t) {
    const s = this.wi ? this.summary() : null;
    const tc = typeColor(t, this.type);
    const e = this.edit;
    const back = this.icon(t, "d-back", "back", "Back to the list", (_ev, cx) => this.leave(cx, (cx) => this.host.back(cx)));
    let row = h_flex().flex_none().px(16).py(10).gap(10).items_center().border_b(1).border_color(t.border)
      .child(back)
      .child(div().flex_none().text_size(12.5).text_color(t.dim).child(`#${this.id}`))
      .when(Boolean(this.type), (el) => el.child(div().flex_none().text_size(12).text_color(tc).child(this.type)))
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground)
        .child(e ? (e.title.value() || " ") : s?.title ?? (this.error ? "" : "Loading…")));
    if (this.wi) {
      if (e) {
        row = row
          .when(this.confirmDiscard, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child("Unsaved changes. Click again to discard.")))
          .child(this.button(t, "d-cancel", "Cancel", (_ev, cx) => this.leave(cx, (cx) => { this.edit = null; this.saveError = null; cx.notify(); }), { danger: this.confirmDiscard }))
          .child(this.button(t, "d-save", this.saving ? "Saving…" : "Save", (_ev, cx) => this.save(cx), { primary: true, icon: "save", disabled: this.saving }));
      } else {
        row = row.child(this.button(t, "d-edit", "Edit", (_ev, cx) => this.startEdit(cx), { icon: "edit" }))
          .child(this.icon(t, "d-reload", "refresh", "Reload", (_ev, cx) => this.load(cx)));
      }
      row = row
        .child(this.icon(t, "d-refine", "refine", "Refine with Claude Code", () => this.host.refine(this.summary())))
        .child(this.icon(t, "d-open", "external", "Open in browser", () => exec("open", [this.url()]).catch(() => {})));
    }
    return row.children(this.host.chrome?.(t) ?? []);
  }

  facts(t) {
    const f = this.f;
    const e = this.edit;
    const m = this.meta;
    const st = f["System.State"];
    const sc = stateColor(t, st);
    const who = f["System.AssignedTo"];
    const by = (k) => f[k]?.displayName ?? "?";
    const parent = f["System.Parent"];
    if (!e) {
      const cells = [
        this.field(t, "State", div().flex_none().px(7).py(1).rounded(10).border(1).border_color(sc).text_size(11.5).text_color(sc).child(st ?? "")),
        this.field(t, "Assigned to", who?.displayName ?? "Unassigned"),
        m.hasPriority && this.field(t, "Priority", f["Microsoft.VSTS.Common.Priority"] != null ? `P${f["Microsoft.VSTS.Common.Priority"]}` : null),
        m.points && this.field(t, m.names.get(m.points) ?? "Points", f[m.points] != null ? String(f[m.points]) : null),
        this.field(t, "Iteration", lastSegment(f["System.IterationPath"])),
        this.field(t, "Area", lastSegment(f["System.AreaPath"])),
        parent && this.field(t, "Parent", div().id("d-parent").text_size(12.5).text_color(t.accent).cursor_pointer()
          .hover((s) => s.opacity(0.8)).on_click((_ev, cx) => this.host.openDetail(parent, cx)).child(`#${parent}`)),
        this.field(t, "Created", `${by("System.CreatedBy")} · ${ago(f["System.CreatedDate"])} ago`),
        this.field(t, "Updated", `${by("System.ChangedBy")} · ${ago(f["System.ChangedDate"])} ago`),
      ].filter(Boolean);
      const tags = (f["System.Tags"] ?? "").split(";").map((x) => x.trim()).filter(Boolean);
      return v_flex().gap(10)
        .child(h_flex().flex_wrap().gap(22).children(cells))
        .when(tags.length > 0, (el) => el.child(h_flex().flex_wrap().gap(5).children(
          tags.map((tag) => div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(tag)))));
    }
    const states = m.states.length ? m.states : [{ name: st }];
    return v_flex().gap(12)
      .child(this.field(t, "Title", this.input(t, e.title)))
      .child(this.field(t, "State", h_flex().flex_wrap().gap(5).children(states.map((s) =>
        this.pill(t, `st-${s.name}`, s.name, e.state === s.name, (_ev, cx) => { e.state = s.name; cx.notify(); }, stateColor(t, s.name))))))
      .child(h_flex().gap(16).flex_wrap()
        .child(v_flex().w(320).child(this.field(t, "Assigned to", this.input(t, e.assigned))))
        .when(m.hasPriority, (el) => el.child(this.field(t, "Priority", h_flex().gap(4).children(PRIORITIES.map((p) =>
          this.pill(t, `pr-${p}`, `P${p}`, e.priority === p, (_ev, cx) => { e.priority = e.priority === p ? null : p; cx.notify(); }))))))
        .when(Boolean(m.points), (el) => el.child(v_flex().w(90).child(this.field(t, m.names.get(m.points) ?? "Points", this.input(t, e.points))))))
      .child(h_flex().gap(16)
        .child(v_flex().flex_1().min_w(0).child(this.field(t, "Iteration", this.input(t, e.iteration))))
        .child(v_flex().flex_1().min_w(0).child(this.field(t, "Area", this.input(t, e.area)))))
      .child(this.field(t, "Tags", this.input(t, e.tags)));
  }

  richSection(t, ref) {
    const name = this.meta.names.get(ref) ?? ref;
    const value = this.f[ref] ?? "";
    const r = this.edit?.rich[ref];
    if (!r && !value && !RICH_ALWAYS.has(ref)) return null;
    const fmt = r ? r.fmt : this.format(ref) || "html";
    const badge = div().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(fmt === "markdown" ? "Markdown" : "HTML");
    let head = h_flex().gap(8).items_center()
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(name))
      .child(badge);
    let body;
    if (!r) {
      body = value
        ? this.rich(`rv-${ref}`, value, fmt)
        : div().text_size(12).text_color(t.dim).child("Empty");
    } else {
      const tab = (k, label) => this.pill(t, `tab-${ref}-${k}`, label, r.tab === k, (_ev, cx) => { r.tab = k; cx.notify(); });
      head = head.child(div().flex_1())
        .when(r.fmt === "html", (el) => el.child(this.button(t, `md-${ref}`, "Convert to Markdown", (_ev, cx) => {
          r.state.set_value(htmlToMarkdown(r.state.value()));
          r.fmt = "markdown";
          cx.notify();
        }, { tip: "Rewrite this field as Markdown and save it as Markdown from now on (ADO can't switch it back)" })))
        .child(h_flex().gap(4).child(tab("write", "Write")).child(tab("preview", "Preview")));
      body = r.tab === "preview"
        ? (r.state.value() ? this.rich(`rp-${ref}`, r.state.value(), r.fmt) : div().text_size(12).text_color(t.dim).child("Empty"))
        : div().w_full().rounded(6).border(1).border_color(t.input).bg(t.background).p(2)
          .child(Textarea.new(r.state).w_full().text_size(12.5).text_color(t.foreground));
    }
    return v_flex().gap(6).child(head)
      .child(div().w_full().min_w(0).p(12).rounded(8).bg(t.raised).child(body));
  }

  prUrl(pr) {
    const enc = encodeURIComponent;
    return `https://dev.azure.com/${this.org}/${enc(pr.project)}/_git/${enc(pr.repo)}/pullrequest/${pr.id}`;
  }

  prsSection(t) {
    const list = this.prs ?? [];
    if (!list.length) return null;
    const branch = (ref) => (ref ?? "").replace(/^refs\/heads\//, "");
    const row = ({ id, pr, error }) => {
      if (!pr) {
        return h_flex().id(`lp-${id}`).px(10).py(7).gap(8).rounded(8).border(1).border_color(t.border).text_size(12)
          .child(div().text_color(t.dim).child(`!${id}`))
          .child(div().text_color(error ? t.blocked : t.dim).child(error ?? "Loading…"));
      }
      const status = pr.draft && pr.status === "active" ? "draft" : pr.status;
      const sc = { active: t.accent, completed: t.working, abandoned: t.dim, draft: t.dim }[status] ?? t.dim;
      const voted = (pr.votes ?? []).filter((v) => v);
      const approved = voted.filter((v) => v > 0).length;
      const waiting = voted.filter((v) => v < 0).length;
      return h_flex().id(`lp-${id}`).px(10).py(7).gap(10).items_center().rounded(8).border(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip("Open in browser")
        .on_click(() => exec("open", [this.prUrl(pr)]).catch(() => {}))
        .child(div().flex_none().px(6).rounded(4).border(1).border_color(sc).text_size(10.5).font_semibold().text_color(sc)
          .child(String(status ?? "?").toUpperCase()))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(`!${pr.id} ${pr.title ?? ""}`))
          .child(div().truncate().text_size(11).text_color(t.dim)
            .child(`${pr.repo} · ${branch(pr.source)} → ${branch(pr.target)} · ${pr.author ?? "?"}`)))
        .when(approved > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.working).child(`✓${approved}`)))
        .when(waiting > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.done).child(`…${waiting}`)))
        .child(svg(ICON("external")).size(12).flex_none().text_color(t.dim));
    };
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("Pull requests"))
        .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
      .children(list.map(row));
  }

  commentsSection(t) {
    const list = this.comments ?? [];
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("Discussion"))
        .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
      .when(!list.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No comments.")))
      .children(list.map((c) => v_flex().gap(4).p(10).rounded(8).border(1).border_color(t.border)
        .child(h_flex().gap(8)
          .child(div().text_size(12).text_color(t.foreground).child(c.createdBy?.displayName ?? "?"))
          .child(div().text_size(11).text_color(t.dim).child(`${ago(c.createdDate)} ago`)))
        .child(this.rich(`c-${c.id}`, c.renderedText || c.text || "", c.renderedText ? "html" : (c.format ?? "html").toLowerCase()))));
  }

  render(t) {
    this.t = t;
    const center = (...kids) => v_flex().flex_1().items_center().justify_center().gap(6).p(24).children(kids);
    let body;
    if (this.error && !this.wi) {
      body = center(div().text_size(13).text_color(t.blocked).child("Couldn't load this work item"),
        div().text_size(12).text_color(t.muted).child(this.error));
    } else if (!this.wi || !this.meta) {
      body = center(div().text_size(12).text_color(t.dim).child(`Loading #${this.id}…`));
    } else {
      body = div().id(`detail-${this.id}`).flex_1().min_h(0).overflow_y_scrollbar().child(v_flex().px(20).py(16).gap(18)
        .when(Boolean(this.saveError), (el) => el.child(div().p(10).rounded(8).border(1).border_color(t.blocked)
          .text_size(12).text_color(t.blocked).child(this.saveError)))
        .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
        .child(this.facts(t))
        .when(!this.edit && Boolean(this.prs?.length), (el) => el.child(this.prsSection(t)))
        .children(this.meta.rich.map((ref) => this.richSection(t, ref)).filter(Boolean))
        .when(!this.edit, (el) => el.child(this.commentsSection(t))));
    }
    return v_flex().size_full().min_h(0).child(this.header(t)).child(body);
  }
}
