// Pure display helpers for the review view: vote/gate/change looks, thread
// counts, relative ages. Colors are theme token names (resolved by the view).
import { voteName } from "./model.js";

/** My current vote key from the reviewer list, or null when I'm not a reviewer. */
export function myVote(reviewers, meId) {
  const r = (reviewers ?? []).find((x) => x.id === meId);
  return r ? voteName(r.vote ?? 0) ?? null : null;
}

const VOTE_LOOK = {
  10: { glyph: "✓", color: "ansi2", label: "Approved" },
  5: { glyph: "✓", color: "ansi2", label: "Approved with suggestions" },
  0: { glyph: "○", color: "dim", label: "No vote" },
  [-5]: { glyph: "…", color: "working", label: "Waiting for author" },
  [-10]: { glyph: "✗", color: "blocked", label: "Rejected" },
};
/** Reviewer chip look for a vote value. */
export function voteLook(vote) {
  return VOTE_LOOK[vote ?? 0] ?? VOTE_LOOK[0];
}

const GATE_LOOK = {
  pass: { glyph: "✓", color: "ansi2" },
  fail: { glyph: "✗", color: "blocked" },
  running: { glyph: "●", color: "working" },
  pending: { glyph: "!", color: "muted" },
  notApplicable: { glyph: "–", color: "dim" },
};
/** Gate chip look: glyph, color token, and whether the chip is dimmed (optional or n/a). */
export function gateLook(gate) {
  const l = GATE_LOOK[gate.state] ?? GATE_LOOK.pending;
  return { ...l, dim: !!gate.optional || gate.state === "notApplicable" };
}

/** What clicking a gate does: open a build, open a url, or just show the reason. */
export function gateAction(gate) {
  if (gate.kind === "build" && gate.link?.build != null) return { kind: "build", project: gate.link.project, build: gate.link.build };
  if (gate.link?.url) return { kind: "url", url: gate.link.url };
  return { kind: "info" };
}

export const anyRunning = (gates) => (gates ?? []).some((g) => g.state === "running");

const CHANGE_LOOK = {
  add: { letter: "A", color: "ansi2" },
  edit: { letter: "M", color: "foreground" },
  delete: { letter: "D", color: "blocked" },
  rename: { letter: "R", color: "working" },
};
export function changeLook(change) {
  return CHANGE_LOOK[change] ?? CHANGE_LOOK.edit;
}

/**
 * Thread counts: total and open overall, open general threads, and per file
 * path {total, open}. "Open" = status active or pending.
 */
export function threadSummary(threads) {
  const out = { total: 0, open: 0, generalOpen: 0, general: 0, byFile: new Map() };
  for (const t of threads ?? []) {
    const open = t.status !== "resolved";
    out.total++;
    if (open) out.open++;
    if (t.file) {
      const f = out.byFile.get(t.file.path) ?? { total: 0, open: 0 };
      f.total++;
      if (open) f.open++;
      out.byFile.set(t.file.path, f);
    } else {
      out.general++;
      if (open) out.generalOpen++;
    }
  }
  return out;
}

/** Drafts on files (not general, not replies), sorted by file then line, flagged when the file left the PR. */
export function fileDrafts(drafts, files) {
  const paths = new Set((files ?? []).map((f) => f.path));
  return (drafts ?? [])
    .filter((d) => d.target && d.target.file != null)
    .map((d) => ({ ...d, gone: files != null && !paths.has(d.target.file) }))
    .sort((a, b) => a.target.file.localeCompare(b.target.file) || a.target.line - b.target.line);
}

/** "file.cs:12" / "file.cs:12-14 (old)" for a file draft target. */
export function targetLabel(t) {
  const lines = t.endLine != null && t.endLine !== t.line ? `${t.line}-${t.endLine}` : `${t.line}`;
  return `${t.file}:${lines}${t.side === "left" ? " (old)" : ""}`;
}

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Strip an ADO group prefix: "[Project]\\Team" → "Team". */
export const displayName = (name) => String(name ?? "").replace(/^\[.*?\]\\/, "");
