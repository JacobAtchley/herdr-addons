// Pure: maps threads / drafts onto diff row indices.

// Shared routine. `anchorOf(item)` returns {path, side, line} or null (ignored).
function place(rows, items, path, anchorOf) {
  const byRow = new Map();
  const outdated = [];
  for (const item of items) {
    const a = anchorOf(item);
    if (!a || a.path !== path) continue;
    const key = a.side === "left" ? "oldNo" : "newNo";
    const idx = rows.findIndex((r) => r[key] === a.line);
    if (idx < 0) {
      outdated.push(item);
      continue;
    }
    if (!byRow.has(idx)) byRow.set(idx, []);
    byRow.get(idx).push(item);
  }
  return { byRow, outdated };
}

export function placeThreads(rows, threads, path) {
  return place(rows, threads, path, (t) =>
    t.file ? { path: t.file.path, side: t.file.side, line: t.file.endLine ?? t.file.startLine } : null);
}

export function placeDrafts(rows, drafts, path) {
  return place(rows, drafts, path, (d) => {
    const t = d.target;
    return t && t.file != null ? { path: t.file, side: t.side, line: t.endLine ?? t.line } : null;
  });
}
