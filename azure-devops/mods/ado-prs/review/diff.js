// Pure line diff (Myers O(ND)) for the PR review view. No herdr/gpui imports.

const MAX_LINES = 20000;
const MAX_EDITS = 4000; // cost cap: Myers trace memory is O(D^2)

export function splitLines(text) {
  if (text == null || text === "") return [];
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Returns null when the edit distance exceeds MAX_EDITS.
// Edit script as [op, oldIdx, newIdx] where op is 0 (equal), -1 (delete), 1 (insert).
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const off = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice(off - d, off + d + 1)); // only k in [-d..d]; index k + d
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]))
        ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  // Backtrack from (n, m); trace[d] holds v as it was before round d.
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d], k = x - y;
    const down = k === -d || (k !== d && pv[k - 1 + d] < pv[k + 1 + d]);
    const pk = down ? k + 1 : k - 1;
    const px = pv[pk + d], py = px - pk;
    const mx = down ? px : px + 1;
    while (x > mx) { x--; y--; ops.push([0, x, y]); }
    if (down) { y--; ops.push([1, x, y]); } else { x--; ops.push([-1, x, y]); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push([0, x, y]); }
  return ops.reverse();
}

export function diffLines(oldLines, newLines) {
  const rows = [];
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    oldLines.forEach((text, i) => rows.push({ kind: "del", oldNo: i + 1, newNo: null, text }));
    newLines.forEach((text, i) => rows.push({ kind: "add", oldNo: null, newNo: i + 1, text }));
    return rows;
  }
  // Trim common prefix/suffix so Myers only works on the changed middle.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endO = oldLines.length, endN = newLines.length;
  while (endO > start && endN > start && oldLines[endO - 1] === newLines[endN - 1]) { endO--; endN--; }

  for (let i = 0; i < start; i++) rows.push({ kind: "ctx", oldNo: i + 1, newNo: i + 1, text: oldLines[i] });
  const ops = myers(oldLines.slice(start, endO), newLines.slice(start, endN)) ?? [
    ...Array.from({ length: endO - start }, (_, i) => [-1, i, 0]),
    ...Array.from({ length: endN - start }, (_, i) => [1, 0, i]),
  ];
  for (const [op, x, y] of ops) {
    const oi = x + start, ni = y + start;
    if (op === 0) rows.push({ kind: "ctx", oldNo: oi + 1, newNo: ni + 1, text: oldLines[oi] });
    else if (op < 0) rows.push({ kind: "del", oldNo: oi + 1, newNo: null, text: oldLines[oi] });
    else rows.push({ kind: "add", oldNo: null, newNo: ni + 1, text: newLines[ni] });
  }
  for (let i = 0; i < oldLines.length - endO; i++) {
    rows.push({ kind: "ctx", oldNo: endO + i + 1, newNo: endN + i + 1, text: oldLines[endO + i] });
  }
  return rows;
}

export function toHunks(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "ctx") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const segs = [];
  let i = 0;
  while (i < rows.length) {
    const start = i;
    const visible = keep[i];
    while (i < rows.length && keep[i] === visible) i++;
    if (visible) segs.push({ type: "rows", rows: rows.slice(start, i) });
    else segs.push({ type: "gap", count: i - start, oldNo: rows[start].oldNo, newNo: rows[start].newNo });
  }
  return segs;
}

export function toSplit(rows) {
  const pairs = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "ctx") { pairs.push({ left: r, right: r }); i++; continue; }
    const dels = [], adds = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      pairs.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return pairs;
}
