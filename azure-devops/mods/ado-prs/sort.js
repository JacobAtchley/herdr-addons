// Column sorting for the PR list. Pure (no herdr imports) so it's unit-tested.

/** Sortable columns, in header order. `first` is the direction a first click picks. */
export const COLUMNS = [
  { key: "title", label: "Title", first: "asc" },
  { key: "author", label: "Author", first: "asc" },
  { key: "votes", label: "Votes", first: "desc" },
  { key: "feedback", label: "Feedback", first: "desc" },
  { key: "age", label: "Age", first: "asc" },
  { key: "ready", label: "Ready", first: "desc" },
];

export const DEFAULT_SORT = { key: "age", dir: "asc" };

/** "age:asc" → {key, dir}; anything unknown → the default. */
export function parseSort(s) {
  const [key, dir] = String(s ?? "").split(":");
  if (!COLUMNS.some((c) => c.key === key) || (dir !== "asc" && dir !== "desc")) return { ...DEFAULT_SORT };
  return { key, dir };
}

export const formatSort = (s) => `${s.key}:${s.dir}`;

/** Clicking a header: the same column flips, a new one starts at its `first` direction. */
export function nextSort(cur, key) {
  if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { key, dir: COLUMNS.find((c) => c.key === key)?.first ?? "asc" };
}

// Votes, worst to best: any reject, then any wait-for-author, then by approvals.
function voteScore(pr) {
  const people = (pr.reviewers ?? []).filter((r) => !r.group || r.vote !== 0);
  const band = people.some((r) => r.vote === -10) ? 0 : people.some((r) => r.vote === -5) ? 1 : 2;
  return [band, people.filter((r) => r.vote >= 5).length];
}

const READY_RANK = { blocked: 0, waiting: 1, ready: 2 };

/** Sort keys per column, compared element by element. null = unknown (always last). */
function keyOf(pr, key, { threads, ready } = {}) {
  switch (key) {
    case "title": return [String(pr.title ?? "").toLowerCase()];
    case "author": return [String(pr.author ?? "").toLowerCase()];
    case "votes": return voteScore(pr);
    case "feedback": {
      const c = threads?.[pr.id];
      if (!c || c.error) return null;
      return [c.open, c.open + c.resolved];
    }
    case "age": return [-Date.parse(pr.created)];
    case "ready": {
      const r = ready?.[pr.id];
      return r && r.state in READY_RANK ? [READY_RANK[r.state], -r.blockers.length] : null;
    }
    default: return [0];
  }
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === "string") return x.localeCompare(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * A sorted copy of `prs`. Ties (and unknown feedback, which always goes last)
 * fall back to newest first.
 * @param {object[]} prs list rows
 * @param {{key: string, dir: 'asc'|'desc'}} sort
 * @param {{threads?: Record<number, {open: number, resolved: number}|{error: string}>,
 *   ready?: Record<number, {state: string, blockers: string[]}>}} data loaded per-PR extras
 */
export function sortPrs(prs, sort, data = {}) {
  const sign = sort.dir === "desc" ? -1 : 1;
  const newest = (a, b) => Date.parse(b.created) - Date.parse(a.created);
  return [...(prs ?? [])].sort((a, b) => {
    const ka = keyOf(a, sort.key, data), kb = keyOf(b, sort.key, data);
    if (ka == null || kb == null) return ka == null && kb == null ? newest(a, b) : ka == null ? 1 : -1;
    return sign * cmp(ka, kb) || newest(a, b);
  });
}
