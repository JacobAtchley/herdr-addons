// Persisted unsent review comments. Pure: the caller supplies load/save.
// Stored shape: { [prKey]: { [draftKey]: { body, target, updated } } }

const DEBOUNCE_MS = 300;

export function draftKey(t) {
  if (t.general) return "g";
  if (t.thread != null) return `t:${t.thread}`;
  return `f:${t.side}:${t.file}:${t.line}-${t.endLine ?? t.line}`;
}

export function prKey(ref) {
  return `${ref.org}/${ref.repoId}/${ref.id}`;
}

export class Drafts {
  static MAX_AGE_MS = 7 * 24 * 3600 * 1000;

  constructor({ load, save, now = Date.now, onError }) {
    this._onError = onError;
    this._load = load;
    this._save = save;
    this._now = now;
    this._data = {};
    this._pr = null;
    this._timer = null;
    this._inflight = Promise.resolve();
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
        if (!(v.updated >= cutoff)) { delete map[k]; pruned = true; }
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
      clearTimeout(this._timer);
      this._timer = null;
      await this._write();
    }
    await this._inflight;
  }

  _schedule() {
    if (this._loading) { this._dirty = true; return; } // open() re-schedules after merging
    if (this._unsafe) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._write().catch((e) => this._onError?.(e));
    }, DEBOUNCE_MS);
    this._timer.unref?.();
  }

  _write() {
    if (this._loading || this._unsafe) return Promise.resolve();
    const snapshot = structuredClone(this._data); // taken now, saved in order
    const p = this._inflight.catch(() => {}).then(() => this._save(snapshot));
    this._inflight = p;
    return p;
  }
}
