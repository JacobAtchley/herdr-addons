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

  constructor({ load, save, now = Date.now }) {
    this._load = load;
    this._save = save;
    this._now = now;
    this._data = {};
    this._pr = null;
    this._timer = null;
    this._inflight = Promise.resolve();
  }

  async open(pr) {
    this._pr = pr;
    this._data = (await this._load()) ?? {};
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

  get(key) {
    return this._data[this._pr]?.[key] ?? null;
  }

  set(key, target, body) {
    if (!body) return this.delete(key);
    (this._data[this._pr] ??= {})[key] = { body, target, updated: this._now() };
    this._schedule();
  }

  delete(key) {
    const map = this._data[this._pr];
    if (!map || !(key in map)) return;
    delete map[key];
    if (Object.keys(map).length === 0) delete this._data[this._pr];
    this._schedule();
  }

  list() {
    return Object.entries(this._data[this._pr] ?? {}).map(([key, v]) => ({
      key, target: v.target, body: v.body, updated: v.updated,
    }));
  }

  // Force any pending debounced save and wait for in-flight saves.
  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      await this._write();
    }
    await this._inflight;
  }

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._write().catch(() => {});
    }, DEBOUNCE_MS);
    this._timer.unref?.();
  }

  _write() {
    const p = this._inflight.catch(() => {}).then(() => this._save(this._data));
    this._inflight = p;
    return p;
  }
}
