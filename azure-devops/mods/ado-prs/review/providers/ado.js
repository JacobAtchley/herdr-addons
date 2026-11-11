// Azure DevOps provider: maps ADO REST (api-version 7.1) to the neutral review
// model in ../model.js. Pure: `rest(method, url, body?)` is injected.
import { VOTES } from "../model.js";

const API = "7.1";
// Endpoints that reject plain 7.1 (VssInvalidPreviewVersionException).
const PREVIEW = "7.1-preview.1";
const enc = encodeURIComponent;
const stripRef = (r) => (r ?? "").replace(/^refs\/heads\//, "");

// ---- mappers ---------------------------------------------------------------

const GATE_STATE = { approved: "pass", rejected: "fail", broken: "fail", running: "running", queued: "running", notApplicable: "notApplicable" };

/**
 * Policy evaluation → Gate. `project` (name) is for the build link; evaluations
 * only carry the project GUID (in artifactId), which is the fallback.
 */
export function mapGate(ev, project) {
  const cfg = ev.configuration ?? {};
  const typeName = cfg.type?.displayName ?? "Policy";
  const isBuild = typeName === "Build";
  const gate = {
    id: ev.evaluationId,
    name: cfg.settings?.displayName || typeName,
    state: GATE_STATE[ev.status] ?? "pending",
    kind: isBuild ? "build" : "policy",
    reason: `${typeName}: ${ev.status}`,
    optional: !cfg.isBlocking,
  };
  if (isBuild && ev.context?.buildId != null) {
    const proj = project ?? (ev.artifactId ?? "").match(/CodeReviewId\/([^/]+)\//)?.[1];
    gate.link = { project: proj, build: ev.context.buildId };
  }
  return gate;
}

const STATUS_STATE = { succeeded: "pass", failed: "fail", error: "fail", pending: "running" };
const statusKey = (s) => `${s.context?.genre ?? ""}/${s.context?.name ?? ""}`;

/** PR status (external check) → Gate. */
export function mapStatus(s) {
  const genre = s.context?.genre;
  const name = s.context?.name ?? "status";
  const gate = {
    id: statusKey(s),
    name: genre ? `${genre}/${name}` : name,
    state: STATUS_STATE[s.state] ?? "pending",
    kind: "check",
    reason: s.description || s.state,
    optional: false,
  };
  if (s.targetUrl) gate.link = { url: s.targetUrl };
  return gate;
}

function latestStatuses(statuses) {
  const by = new Map();
  for (const s of statuses ?? []) {
    const k = statusKey(s);
    if (!by.has(k) || by.get(k).id < s.id) by.set(k, s);
  }
  return [...by.values()];
}

/**
 * @param {object} pr ADO GitPullRequest
 * @param {object[]} iterations
 * @param {object[]} evaluations policy evaluations
 * @param {object[]} statuses PR statuses
 * @param {{id:number,title:string|null,url:string}[]} workItems
 */
export function mapPullRequest(pr, iterations, evaluations, statuses, workItems) {
  const repo = pr.repository ?? {};
  const project = repo.project?.name;
  const org = orgFromUrl(pr.url);
  const ids = (iterations ?? []).map((i) => i.id).sort((a, b) => a - b);
  return {
    id: pr.pullRequestId,
    url: org && project ? `https://dev.azure.com/${org}/${enc(project)}/_git/${enc(repo.name)}/pullrequest/${pr.pullRequestId}` : pr.url,
    title: pr.title ?? "",
    description: pr.description ?? "",
    repo: repo.name,
    project,
    projectId: repo.project?.id,
    source: stripRef(pr.sourceRefName),
    target: stripRef(pr.targetRefName),
    author: { name: pr.createdBy?.displayName, id: pr.createdBy?.id },
    created: pr.creationDate,
    isDraft: !!pr.isDraft,
    status: pr.status,
    reviewers: (pr.reviewers ?? []).map((r) => ({
      id: r.id, name: r.displayName, vote: r.vote ?? 0, required: !!r.isRequired, isGroup: !!r.isContainer,
    })),
    gates: [
      ...(evaluations ?? []).map((e) => mapGate(e, project)),
      ...latestStatuses(statuses).map(mapStatus),
    ],
    workItems: workItems ?? [],
    versions: { latest: ids.length ? ids[ids.length - 1] : null, all: ids },
  };
}

function orgFromUrl(url) {
  const m = (url ?? "").match(/^https:\/\/dev\.azure\.com\/([^/]+)\//);
  return m ? m[1] : null;
}

const THREAD_STATUS = { active: "active", pending: "pending", unknown: "active", fixed: "resolved", wontFix: "resolved", closed: "resolved", byDesign: "resolved" };

function mapComment(c, meId) {
  return { id: c.id, author: c.author?.displayName, body: c.content ?? "", created: c.publishedDate, isMine: c.author?.id === meId };
}

function mapThread(t, meId) {
  const out = {
    id: t.id,
    status: THREAD_STATUS[t.status] ?? "active",
    rawStatus: t.status,
    comments: (t.comments ?? []).filter((c) => !c.isDeleted).map((c) => mapComment(c, meId)),
  };
  const ctx = t.threadContext;
  if (ctx?.filePath) {
    const side = ctx.rightFileStart ? "right" : ctx.leftFileStart ? "left" : null;
    if (side) {
      const start = ctx[`${side}FileStart`];
      const end = ctx[`${side}FileEnd`] ?? start;
      out.file = { path: ctx.filePath, side, startLine: start.line, endLine: end.line };
    }
  }
  return out;
}

/** Raw ADO threads → Thread[]; drops deleted and system threads. */
export function mapThreads(raw, meId) {
  return (raw ?? [])
    .filter((t) => !t.isDeleted && t.comments?.[0]?.commentType !== "system")
    .map((t) => mapThread(t, meId));
}

/** Iteration change entry → FileChange (null for folders). */
export function mapChange(entry) {
  const item = entry.item ?? {};
  if (item.isFolder) return null;
  const types = (entry.changeType ?? "").split(",").map((s) => s.trim());
  const change = types.includes("rename") ? "rename" : types.find((t) => t === "add" || t === "delete" || t === "edit") ?? "edit";
  const out = { path: item.path, change, changeTrackingId: entry.changeTrackingId };
  const old = entry.originalPath ?? entry.sourceServerItem;
  if (old && old !== item.path) out.oldPath = old;
  return out;
}

/** Inputs for a new file thread → {threadContext, pullRequestThreadContext}. */
export function buildThreadContext({ file, side, line, endLine, lineLength, endLineLength, range, changeTrackingId }) {
  const s = side === "left" ? "left" : "right";
  return {
    threadContext: {
      filePath: file,
      [`${s}FileStart`]: { line, offset: 1 },
      [`${s}FileEnd`]: { line: endLine ?? line, offset: (endLineLength ?? lineLength ?? 0) + 1 },
    },
    pullRequestThreadContext: {
      changeTrackingId,
      // first == second means "left side = the merge base (common commit) of
      // that iteration", which is exactly what All changes shows on the left.
      iterationContext: { firstComparingIteration: range.from ?? range.to, secondComparingIteration: range.to },
    },
  };
}

// ---- provider --------------------------------------------------------------

const THREAD_STATUS_OUT = { resolved: "fixed" };

/**
 * @param {{rest: (method: string, url: string, body?: any) => Promise<any>, org: string}} deps
 * @returns {import("../model.js").Provider}
 */
export function createAdoProvider({ rest, org }) {
  const root = `https://dev.azure.com/${enc(org)}`;
  const projectBase = (ref) => `${root}/${enc(ref.project)}/_apis`;
  const repoBase = (ref) => `${projectBase(ref)}/git/repositories/${enc(ref.repoId)}`;
  const prBase = (ref) => `${repoBase(ref)}/pullRequests/${ref.id}`;
  const q = (url, params = "", version = API) => `${url}?${params ? `${params}&` : ""}api-version=${version}`;

  let meP = null;
  const iterCache = new Map();

  function me() {
    if (!meP) {
      meP = rest("get", q(`${root}/_apis/connectionData`, "", PREVIEW)).then((r) => ({
        id: r.authenticatedUser.id, name: r.authenticatedUser.providerDisplayName,
      }));
      meP.catch(() => { meP = null; });
    }
    return meP;
  }

  // Iterations never change once pushed, so the list is cached per PR and only
  // refetched on a PR load or when a requested iteration is missing.
  async function iterations(ref, need = [], refresh = false) {
    const key = `${ref.repoId}/${ref.id}`;
    let list = iterCache.get(key);
    if (refresh || !list || need.some((id) => id != null && !list.some((i) => i.id === id))) {
      list = (await rest("get", q(`${prBase(ref)}/iterations`)))?.value ?? [];
      iterCache.set(key, list);
    }
    return list;
  }

  async function workItems(ref) {
    const refs = (await rest("get", q(`${prBase(ref)}/workitems`)))?.value ?? [];
    const ids = refs.map((w) => Number(w.id));
    const titles = new Map();
    if (ids.length) {
      try {
        const r = await rest("get", q(`${root}/_apis/wit/workitems`, `ids=${enc(ids.join(","))}&fields=System.Title`));
        for (const w of r?.value ?? []) titles.set(Number(w.id), w.fields?.["System.Title"] ?? null);
      } catch {
        // Titles are cosmetic; the PR still loads without them.
      }
    }
    return ids.map((id) => ({ id, title: titles.get(id) ?? null, url: `${root}/${enc(ref.project)}/_workitems/edit/${id}` }));
  }

  async function getPullRequest(ref) {
    const prP = rest("get", q(prBase(ref)));
    const evalP = prP.then((pr) => rest("get", q(`${projectBase(ref)}/policy/evaluations`,
      `artifactId=${enc(`vstfs:///CodeReview/CodeReviewId/${pr.repository.project.id}/${ref.id}`)}`, PREVIEW)));
    // Gates are informational: a failure here must not fail the PR load.
    const gatesP = Promise.all([evalP, rest("get", q(`${prBase(ref)}/statuses`, "", PREVIEW))])
      .then(([e, s]) => ({ evals: e?.value ?? [], statuses: s?.value ?? [] }))
      .catch((err) => ({ error: err?.message ?? String(err) }));
    const [pr, iters, gates, wis] = await Promise.all([prP, iterations(ref, [], true), gatesP, workItems(ref)]);
    if (gates.error) {
      const m = mapPullRequest(pr, iters, [], [], wis);
      return { ...m, gates: [], gatesError: gates.error };
    }
    return mapPullRequest(pr, iters, gates.evals, gates.statuses, wis);
  }

  async function listFiles(ref, range) {
    const out = [];
    let skip = 0;
    for (;;) {
      const r = await rest("get", q(`${prBase(ref)}/iterations/${range.to}/changes`, `$compareTo=${range.from ?? 0}&$top=2000&$skip=${skip}`));
      for (const e of r?.changeEntries ?? []) {
        const f = mapChange(e);
        if (f) out.push(f);
      }
      if (!r?.nextSkip) break;
      skip = r.nextSkip;
    }
    return out;
  }

  async function item(ref, path, sha) {
    const r = await rest("get", q(`${repoBase(ref)}/items`,
      `path=${enc(path)}&versionDescriptor.version=${enc(sha)}&versionDescriptor.versionType=commit&includeContent=true&includeContentMetadata=true&$format=json`));
    // Without $format=json ADO returns raw text. isBinary is absent for text files.
    // Strip one leading BOM so a BOM-only difference doesn't mark line 1 changed.
    return { content: (r?.content ?? "").replace(/^\uFEFF/, ""), binary: !!r?.contentMetadata?.isBinary };
  }

  async function getFileContents(ref, file, range) {
    const iters = await iterations(ref, [range.to, range.from]);
    const at = (id) => {
      const it = iters.find((i) => i.id === id);
      if (!it) throw new Error(`iteration ${id} not found`);
      return it;
    };
    const oldSha = range.from == null ? at(range.to).commonRefCommit.commitId : at(range.from).sourceRefCommit.commitId;
    const newSha = at(range.to).sourceRefCommit.commitId;
    const [o, n] = await Promise.all([
      file.change === "add" ? null : item(ref, file.oldPath ?? file.path, oldSha),
      file.change === "delete" ? null : item(ref, file.path, newSha),
    ]);
    return { old: o ? o.content : null, new: n ? n.content : null, binary: !!(o?.binary || n?.binary) };
  }

  async function listThreads(ref, range) {
    const [raw, who] = await Promise.all([
      rest("get", q(`${prBase(ref)}/threads`, `$iteration=${range.to}&$baseIteration=${range.from ?? 0}`)),
      me(),
    ]);
    return mapThreads(raw?.value ?? [], who.id);
  }

  async function addThread(ref, { target, body, range, file }) {
    const payload = { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: "active" };
    if (target && !target.general) {
      Object.assign(payload, buildThreadContext({
        file: target.file, side: target.side, line: target.line, endLine: target.endLine,
        lineLength: target.lineLength, endLineLength: target.endLineLength, range,
        changeTrackingId: file?.changeTrackingId,
      }));
    }
    const [t, who] = await Promise.all([rest("post", q(`${prBase(ref)}/threads`), payload), me()]);
    return mapThread(t, who.id);
  }

  async function reply(ref, threadId, body) {
    // ADO numbers comments per thread from 1, so the thread's first comment is id 1.
    const [c, who] = await Promise.all([
      rest("post", q(`${prBase(ref)}/threads/${threadId}/comments`), { parentCommentId: 1, content: body, commentType: 1 }),
      me(),
    ]);
    return mapComment(c, who.id);
  }

  async function setThreadStatus(ref, threadId, status) {
    const [t, who] = await Promise.all([
      rest("patch", q(`${prBase(ref)}/threads/${threadId}`), { status: THREAD_STATUS_OUT[status] ?? status }),
      me(),
    ]);
    return mapThread(t, who.id);
  }

  async function vote(ref, key) {
    if (!(key in VOTES)) throw new Error(`unknown vote: ${key}`);
    const who = await me();
    const r = await rest("put", q(`${prBase(ref)}/reviewers/${enc(who.id)}`), { vote: VOTES[key] });
    return r?.vote;
  }

  async function setDraft(ref, isDraft) {
    const r = await rest("patch", q(prBase(ref)), { isDraft });
    return !!r?.isDraft;
  }

  /** Web link to one file of a PR (as returned by getPullRequest); null without a PR link. */
  function fileUrl(pr, path) {
    return pr?.url ? `${pr.url}?_a=files&path=${enc(path)}` : null;
  }

  return {
    capabilities: { votes: Object.keys(VOTES), draft: true },
    fileUrl, me, getPullRequest, listFiles, getFileContents, listThreads, addThread, reply, setThreadStatus, vote, setDraft,
  };
}
