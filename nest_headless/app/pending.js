// Pending identity samples (verification backlog). When a voice or face
// sample is good enough to enrol but the match is ambiguous or unknown, it
// is parked here for an admin to label, mark as "not a household member",
// or drop. Storage: <identityDir>/pending/<id>/{meta.json, clip.wav|crop.jpg}.
// Retention: MAX_AGE_DAYS or MAX_SAMPLES (oldest dropped). A small negative
// set (_unknown.json) stops the same visitor being queued again for 30 days.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 7 * 86400000, MAX_SAMPLES = 200, UNKNOWN_TTL_MS = 30 * 86400000;

class PendingStore {
  constructor(dir) { this.dir = dir; this.unknownFile = path.join(dir, '_unknown.json'); }
  ensure() { fs.mkdirSync(this.dir, { recursive: true }); }

  list({ kind = null, camera = null, limit = 50 } = {}) {
    this.ensure();
    const out = [];
    for (const id of fs.readdirSync(this.dir)) {
      if (id.startsWith('_')) continue;
      const m = this.get(id);
      if (!m) continue;
      if (kind && m.kind !== kind) continue;
      if (camera && m.camera !== camera) continue;
      out.push(m);
    }
    out.sort((a, b) => (a.t < b.t ? 1 : -1));
    return { count: out.length, samples: out.slice(0, Math.max(1, Math.min(500, limit))) };
  }
  count() { this.ensure(); return fs.readdirSync(this.dir).filter((id) => !id.startsWith('_')).length; }
  get(id) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'meta.json'), 'utf8')); } catch (e) { return null; }
  }
  mediaPath(id) {
    const m = this.get(id);
    if (!m) return null;
    const f = path.join(this.dir, id, m.media);
    return fs.existsSync(f) ? { file: f, type: m.media.endsWith('.wav') ? 'audio/wav' : 'image/jpeg' } : null;
  }
  remove(id) {
    if (!this.get(id)) return false;
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return true;
  }
  // Prune by age and count, oldest first.
  prune() {
    this.ensure();
    const now = Date.now();
    const items = fs.readdirSync(this.dir).filter((id) => !id.startsWith('_')).map((id) => ({ id, m: this.get(id) })).filter((x) => x.m);
    for (const x of items) if (now - Date.parse(x.m.t) > MAX_AGE_MS) this.remove(x.id);
    const left = items.filter((x) => fs.existsSync(path.join(this.dir, x.id))).sort((a, b) => (a.m.t < b.m.t ? -1 : 1));
    for (let i = 0; i < left.length - MAX_SAMPLES; i++) this.remove(left[i].id);
  }
  // sample: {kind, camera, t, utterance_id?, quality, matches, embedding, size_px?, speech_ms?, media: {buf, ext}}
  add(sample) {
    this.ensure();
    const id = `${sample.kind}-${new Date(sample.t || Date.now()).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    const d = path.join(this.dir, id);
    fs.mkdirSync(d, { recursive: true });
    const mediaName = sample.media.ext === 'wav' ? 'clip.wav' : 'crop.jpg';
    fs.writeFileSync(path.join(d, mediaName), sample.media.buf);
    const meta = { id, kind: sample.kind, camera: sample.camera, t: sample.t || new Date().toISOString(), utterance_id: sample.utterance_id || null,
      quality: sample.quality || null, matches: sample.matches || [], size_px: sample.size_px, speech_ms: sample.speech_ms, media: mediaName, embedding: sample.embedding };
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
    this.prune();
    return meta;
  }
  loadUnknown() { try { return JSON.parse(fs.readFileSync(this.unknownFile, 'utf8')).filter((u) => Date.now() - Date.parse(u.t) < UNKNOWN_TTL_MS); } catch (e) { return []; } }
  markUnknown(id) {
    const m = this.get(id);
    if (!m) return false;
    const list = this.loadUnknown();
    list.push({ kind: m.kind, embedding: m.embedding, t: new Date().toISOString(), from: id });
    this.ensure();
    fs.writeFileSync(this.unknownFile, JSON.stringify(list));
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
