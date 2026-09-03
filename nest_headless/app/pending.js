// Pending identity samples (verification backlog). When a voice or face
// sample is good enough to enrol but the match is ambiguous or unknown, it
// is parked here for an admin to label, mark as "not a household member",
// or drop. Storage: <identityDir>/pending/<id>/{meta.json, clip.wav|crop.jpg}.
// Retention: MAX_AGE_DAYS or MAX_SAMPLES (oldest dropped). A small negative
// set (_unknown.json) stops the same visitor being queued again for 30 days.
//
// The index of metadata lives in memory: it is read from disk once,
// asynchronously, and every add/remove updates it here first. The directory
// may be on a network share, where a sync readdir plus one readFile per
// sample cost seconds on the event loop (#17). Media and metadata writes are
// asynchronous too; a failed write drops the entry again.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_AGE_MS = 7 * 86400000, MAX_SAMPLES = 200, UNKNOWN_TTL_MS = 30 * 86400000;
const ID_RE = /^[a-z0-9_-]{1,64}$/i;

class PendingStore {
  constructor(dir) {
    this.dir = dir; this.unknownFile = path.join(dir, '_unknown.json');
    this.index = null;          // id -> meta
    this.removed = new Set();   // ids removed while the initial load was still running
    this.unknown = null;
    this.ready = this._loadAsync().catch((e) => console.warn('[nest_headless] pending index load failed:', e.message));
  }
  async _loadAsync() {
    await fsp.mkdir(this.dir, { recursive: true });
    const idx = this._load();
    for (const id of await fsp.readdir(this.dir)) {
      if (id.startsWith('_') || idx.has(id) || this.removed.has(id)) continue;
      try { const m = JSON.parse(await fsp.readFile(path.join(this.dir, id, 'meta.json'), 'utf8')); if (m && m.id === id) idx.set(id, m); } catch (e) { /* skip */ }
    }
    this.removed.clear();
    return idx;
  }
  _load() { if (!this.index) this.index = new Map(); return this.index; }

  list({ kind = null, camera = null, limit = 50 } = {}) {
    const out = [...this._load().values()].filter((m) => (!kind || m.kind === kind) && (!camera || m.camera === camera));
    out.sort((a, b) => (a.t < b.t ? 1 : -1));
    return { count: out.length, samples: out.slice(0, Math.max(1, Math.min(500, limit))) };
  }
  count() { return this._load().size; }
  get(id) { return ID_RE.test(id) ? this._load().get(id) || null : null; }
  mediaPath(id) {
    const m = this.get(id);
    if (!m) return null;
    const f = path.join(this.dir, id, m.media);
    return fs.existsSync(f) ? { file: f, type: m.media.endsWith('.wav') ? 'audio/wav' : 'image/jpeg' } : null;
  }
  remove(id) {
    if (!this.get(id)) return false;
    this.index.delete(id); this.removed.add(id);
    fsp.rm(path.join(this.dir, id), { recursive: true, force: true }).catch(() => {});
    return true;
  }
  // Prune by age and count, oldest first.
  prune() {
    const now = Date.now();
    for (const m of [...this._load().values()]) if (now - Date.parse(m.t) > MAX_AGE_MS) this.remove(m.id);
    const left = [...this.index.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
    for (let i = 0; i < left.length - MAX_SAMPLES; i++) this.remove(left[i].id);
  }
  // sample: {kind, camera, t, utterance_id?, quality, matches, embedding, size_px?, speech_ms?, media: {buf, ext}}
  add(sample) {
    const id = `${sample.kind}-${new Date(sample.t || Date.now()).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    const d = path.join(this.dir, id);
    const mediaName = sample.media.ext === 'wav' ? 'clip.wav' : 'crop.jpg';
    const meta = { id, kind: sample.kind, camera: sample.camera, t: sample.t || new Date().toISOString(), utterance_id: sample.utterance_id || null,
      quality: sample.quality || null, matches: sample.matches || [], size_px: sample.size_px, speech_ms: sample.speech_ms, media: mediaName, embedding: sample.embedding };
    this._load().set(id, meta);
    (async () => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, mediaName), sample.media.buf);
      await fsp.writeFile(path.join(d, 'meta.json'), JSON.stringify(meta));
    })().catch((e) => { this.index.delete(id); console.warn('[nest_headless] pending write failed:', e.message); });
    this.prune();
    return meta;
  }
  loadUnknown() {
    if (this.unknown === null) {
      try { this.unknown = JSON.parse(fs.readFileSync(this.unknownFile, 'utf8')); } catch (e) { this.unknown = []; }
      if (!Array.isArray(this.unknown)) this.unknown = [];
    }
    return this.unknown.filter((u) => Date.now() - Date.parse(u.t) < UNKNOWN_TTL_MS);
  }
  markUnknown(id) {
    const m = this.get(id);
    if (!m) return false;
    const list = this.loadUnknown();
    list.push({ kind: m.kind, embedding: m.embedding, t: new Date().toISOString(), from: id });
    this.unknown = list;
    fsp.mkdir(this.dir, { recursive: true }).then(() => fsp.writeFile(this.unknownFile, JSON.stringify(list)))
      .catch((e) => console.warn('[nest_headless] unknown list write failed:', e.message));
    this.remove(id);
    return true;
  }
  // best similarity of an embedding against the negative set for its kind
  unknownScore(kind, embedding, cosine) {
    let best = -1;
    for (const u of this.loadUnknown()) if (u.kind === kind && Array.isArray(u.embedding) && u.embedding.length === embedding.length) best = Math.max(best, cosine(embedding, u.embedding));
    return best;
  }
}

module.exports = { PendingStore, MAX_AGE_MS, MAX_SAMPLES, UNKNOWN_TTL_MS };
