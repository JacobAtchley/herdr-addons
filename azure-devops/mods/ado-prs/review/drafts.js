// Persisted unsent review comments. Pure: the caller supplies load/save.
// Stored shape: { [prKey]: { [draftKey]: { body, target, updated } } }
//
// Several Drafts instances (one per mod copy: dialog, split pane) share one
// file, so a save never writes this instance's whole snapshot: it re-reads the
// file and replaces only the PR maps this instance touched (mergeDrafts).

const DEBOUNCE_MS = 300;

// Node's timers, for tests and plain JS. The Herdr mod runtime has no
// setTimeout (it throws), so the mod passes its own `timer`.
const nodeTimer = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return () => clearTimeout(t);
  },
};

export function draftKey(t) {
  if (t.general) return "g";
  if (t.thread != null) return `t:${t.thread}`;
  // A file draft's line numbers belong to one version (left: the base — in
  // All changes the merge base of iteration `to`, hence "base<to>"; right:
  // the latest push); it is part of the key so a draft from another version
  // never shares a box with a line clicked in this one.
  const base = `f:${t.side}:${t.file}:${t.line}-${t.endLine ?? t.line}`;
  if (!t.range) return base;
  return `${base}@${t.side === "left" ? t.range.from ?? `base${t.range.to}` : t.range.to}`;
}

/**
 * `current` (the file as read now) with each PR map in `parts` replaced; a
 * null or empty map removes that PR. PRs not in `parts` are kept as they are.
 */
export function mergeDrafts(current, parts) {
  const out = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
  for (const [p, map] of Object.entries(parts)) {
    if (map && Object.keys(map).length) out[p] = map;
    else delete out[p];
  }
  return out;
}

export function prKey(ref) {
  return `${ref.org}/${ref.repoId}/${ref.id}`;
}

export class Drafts {
  static MAX_AGE_MS = 7 * 24 * 3600 * 1000;

  // exclusive(fn): runs fn (one re-read + save) while holding a lock shared
  // with the other instances, so two saves can't interleave read and write.
  // timer.after(ms, fn) runs fn once after ms and returns a cancel function.
  constructor({ load, save, now = Date.now, onError, exclusive = (fn) => fn(), timer = nodeTimer }) {
    this._after = timer.after;
    this._onError = onError;
    this._load = load;
    this._save = save;
    this._exclusive = exclusive;
    this._now = now;
    this._data = {};
    this._pr = null;
    this._timer = null;
    this._inflight = Promise.resolve();
    this._touched = new Set(); // PR keys changed since the last save started
  }

  // Overlapping open() calls are serialized: each runs after the previous one
  // has finished, so a stale continuation can never clobber newer state.
  open(pr) {
    const prev = this._opening;
    const p = (async () => {
      if (prev) await prev.catch(() => {});
      await this._open(pr);
    })();
    this._opening = p;
    return p;
  }

  async _open(pr) {
    // Persist the previous PR's pending edits first (data is complete here).
    // flush() snapshots synchronously, so we can switch PR right away.
    const flushed = this.flush();
    // While loading, _data is partial: nothing may be written (_loading) or
    // other PRs' drafts on disk would be wiped. set()s made meanwhile are
    // collected in `raced` and merged after the load.
    this._pr = pr;
    const raced = (this._data = {});
    this._loading = true;
    try { await flushed; } catch (e) { this._onError?.(e); }
    let loaded;
    try {
      loaded = (await this._load()) ?? {};
    } catch (e) {
      // _data is partial: block all writes (_unsafe) until an open() succeeds.
      // _loading must be cleared so flush() never waits on an open that failed.
      this._loading = false;
      this._unsafe = true;
      this._onError?.(e);
      throw e;
    }
    this._unsafe = false;
    // Edits made while loading (to any PR: a view for an earlier PR may still
    // be finishing a post) are merged over the loaded data, then the deletes
    // that arrived meanwhile are replayed in order.
    const dirty = this._dirty || Object.values(raced).some((m) => Object.keys(m).length > 0);
    this._data = loaded;
    for (const [p, map] of Object.entries(raced)) {
      if (Object.keys(map).length) this._data[p] = { ...(loaded[p] ?? {}), ...map };
    }
    const deletes = this._pendingDeletes ?? [];
    this._pendingDeletes = [];
    this._loading = false;
    this._dirty = false;
    for (const [key, opts] of deletes) this._deleteNow(key, opts);
    if (dirty) this._schedule();
    const cutoff = this._now() - Drafts.MAX_AGE_MS;
    let pruned = false;
    for (const [p, map] of Object.entries(this._data)) {
      for (const [k, v] of Object.entries(map)) {
        if (!(v.updated >= cutoff)) { delete map[k]; pruned = true; this._touched.add(p); }
      }
      if (Object.keys(map).length === 0) delete this._data[p];
    }
    if (pruned) await this._write();
  }

  get(key, pr = this._pr) {
    return this._data[pr]?.[key] ?? null;
  }

  // `pr` defaults to the open PR; a view passes its own so that a late event
  // (after the user moved to another PR) can't touch that other PR's drafts.
  set(key, target, body, pr = this._pr) {
    if (!body) return this.delete(key, { pr });
    // A newer set wins over a delete queued during a load.
    if (this._pendingDeletes?.length) this._pendingDeletes = this._pendingDeletes.filter(([k, o]) => k !== key || o.pr !== pr);
    (this._data[pr] ??= {})[key] = { body, target, updated: this._now() };
    this._touched.add(pr);
    this._schedule();
  }

  /**
   * Remove a draft. `pr` (default: the open PR) names the PR it belongs to.
   * `ifBody`: only when the stored body (trimmed) still equals it, so text
   * typed while a post was in flight survives the post's cleanup.
   */
  delete(key, { pr = this._pr, ifBody } = {}) {
    if (this._loading) {
      // _data is partial during a load: replay once it has merged.
      (this._pendingDeletes ??= []).push([key, { pr, ifBody }]);
      const map = this._data[pr];
      if (map && key in map && (ifBody == null || String(map[key].body).trim() === String(ifBody).trim())) delete map[key];
      return;
    }
    this._deleteNow(key, { pr, ifBody });
  }

  _deleteNow(key, { pr, ifBody }) {
    const map = this._data[pr];
    if (!map || !(key in map)) return;
    if (ifBody != null && String(map[key].body ?? "").trim() !== String(ifBody).trim()) return;
    delete map[key];
    if (Object.keys(map).length === 0) delete this._data[pr];
    this._touched.add(pr);
    this._schedule();
  }

  list(pr = this._pr) {
    return Object.entries(this._data[pr] ?? {}).map(([key, v]) => ({
      key, target: v.target, body: v.body, updated: v.updated,
    }));
  }

  // Force any pending debounced save and wait for in-flight saves.
  async flush() {
    // Never wait on the open() that is itself calling flush(): _open() calls
    // flush() before setting _loading, so _loading is only true for a load in
    // progress started by an earlier call.
    if (this._loading && this._opening) await this._opening.catch(() => {});
    if (this._unsafe) return; // last load failed: data is partial, never write it
    if (this._timer) {
      this._timer();
      this._timer = null;
      await this._write();
    }
    // A save started elsewhere reports its own failure (onError / its caller).
    await this._inflight.catch(() => {});
  }

  _schedule() {
    if (this._loading) { this._dirty = true; return; } // open() re-schedules after merging
    if (this._unsafe) return;
    if (this._timer) this._timer();
    this._timer = this._after(DEBOUNCE_MS, () => {
      this._timer = null;
      this._write().catch((e) => this._onError?.(e));
    });
  }

  // Snapshot the touched PR maps now; in order, re-read the file, merge them
  // in and save. A failed save marks them touched again so the next one retries.
  _write() {
    if (this._loading || this._unsafe) return Promise.resolve();
    const touched = [...this._touched];
    this._touched.clear();
    if (!touched.length) return this._inflight;
    const parts = {};
    for (const p of touched) parts[p] = this._data[p] ? structuredClone(this._data[p]) : null;
    const p = this._inflight.catch(() => {}).then(async () => {
      try {
        // load() rejects when the file exists but can't be read: never save
        // then, or the other instances' PRs in it would be dropped.
        await this._exclusive(async () => this._save(mergeDrafts(await this._load(), parts)));
      } catch (e) {
        for (const k of touched) this._touched.add(k);
        throw e;
      }
    });
    this._inflight = p;
    return p;
  }
}
