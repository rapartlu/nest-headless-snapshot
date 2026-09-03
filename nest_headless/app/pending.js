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

// Hard negatives (#18): samples an admin marked "not a person" (a poster, a
// reflection, the cat; for voice the TV or a dog). The sample's directory is
// moved to <identityDir>/negatives/not_person/<id>/ so the crops can feed a
// detector retune later, and the embeddings stop the same thing being queued
// or matched to a person again. Kept until deleted, capped at NEG_MAX.
const MAX_AGE_MS = 7 * 86400000, MAX_SAMPLES = 200, UNKNOWN_TTL_MS = 30 * 86400000, NEG_MAX = 500;
const ID_RE = /^[a-z0-9_-]{1,64}$/i;

class PendingStore {
  constructor(dir) {
    this.dir = dir; this.unknownFile = path.join(dir, '_unknown.json');
    this.negDir = path.join(path.dirname(dir), 'negatives', 'not_person');
    this.index = null;          // id -> meta
    this.removed = new Set();   // ids removed while the initial load was still running
    this.writes = new Map();    // id -> promise of the sample's files landing on disk
    this.unknown = null;
    this.negatives = [];        // [{id, kind, embedding, t, camera}]
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
    await fsp.mkdir(this.negDir, { recursive: true });
    for (const id of await fsp.readdir(this.negDir)) {
      if (this.negatives.some((n) => n.id === id)) continue;
      try { const m = JSON.parse(await fsp.readFile(path.join(this.negDir, id, 'meta.json'), 'utf8')); if (m && Array.isArray(m.embedding)) this.negatives.push({ id, kind: m.kind, embedding: m.embedding, t: m.t, camera: m.camera }); } catch (e) { /* skip */ }
    }
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
    (this.writes.get(id) || Promise.resolve()).then(() => fsp.rm(path.join(this.dir, id), { recursive: true, force: true })).catch(() => {});
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
    const w = (async () => {
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, mediaName), sample.media.buf);
      await fsp.writeFile(path.join(d, 'meta.json'), JSON.stringify(meta));
    })().catch((e) => { this.index.delete(id); console.warn('[nest_headless] pending write failed:', e.message); });
    this.writes.set(id, w.finally(() => this.writes.delete(id)));
    this.prune();
    return meta;
  }
  // ---- hard negatives (#18)
  negativeCount() { return this.negatives.length; }
  listNegatives() { return this.negatives.map((n) => ({ id: n.id, kind: n.kind, camera: n.camera, t: n.t })).sort((a, b) => (a.t < b.t ? 1 : -1)); }
  // best similarity of an embedding against the "not a person" set for its kind
  negativeScore(kind, embedding, cosine) {
    let best = -1;
    for (const n of this.negatives) if (n.kind === kind && Array.isArray(n.embedding) && n.embedding.length === embedding.length) best = Math.max(best, cosine(embedding, n.embedding));
    return best;
  }
  // Move a pending sample (crop or clip + meta) into the negative set.
  markNotPerson(id) {
    const m = this.get(id);
    if (!m) return false;
    this.index.delete(id); this.removed.add(id);
    this.negatives.push({ id, kind: m.kind, embedding: m.embedding, t: m.t, camera: m.camera });
    const src = path.join(this.dir, id), dst = path.join(this.negDir, id);
    (this.writes.get(id) || Promise.resolve())
      .then(() => fsp.mkdir(this.negDir, { recursive: true }))
      .then(() => fsp.rename(src, dst).catch(() => fsp.cp(src, dst, { recursive: true }).then(() => fsp.rm(src, { recursive: true, force: true }))))
      .catch((e) => console.warn('[nest_headless] negative move failed:', e.message));
    while (this.negatives.length > NEG_MAX) this.removeNegative(this.negatives.sort((a, b) => (a.t < b.t ? -1 : 1))[0].id);
    return true;
  }
  removeNegative(id) {
    if (!ID_RE.test(id)) return false;
    const i = this.negatives.findIndex((n) => n.id === id);
    if (i < 0) return false;
    this.negatives.splice(i, 1);
    fsp.rm(path.join(this.negDir, id), { recursive: true, force: true }).catch(() => {});
    return true;
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

module.exports = { PendingStore, MAX_AGE_MS, MAX_SAMPLES, UNKNOWN_TTL_MS, NEG_MAX };
