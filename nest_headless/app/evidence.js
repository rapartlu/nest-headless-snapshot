// Evidence by reference (#21): the frame a decision came from must stay
// addressable after the fact. Every frame node handles is noted in a small
// in-memory ring per camera (exact frames for the last minute or two), and
// frames behind events are written to the archive under <camera>_events/
// with an ISO stamp, so GET /archive/<camera>/<time>.jpg can answer with the
// nearest frame from memory, the event archive, or the heartbeat archive.
'use strict';

class FrameRing {
  constructor(max = 90) { this.max = max; this.items = []; }
  push(t, jpg) {
    if (this.items.length && this.items[this.items.length - 1].t === t) return;
    this.items.push({ t, jpg });
    while (this.items.length > this.max) this.items.shift();
  }
  // the frame closest to t, with the distance in ms
  nearest(t) {
    let best = null;
    for (const it of this.items) { const d = Math.abs(it.t - t); if (!best || d < best.dt) best = { t: it.t, jpg: it.jpg, dt: d }; }
    return best;
  }
  latest() { return this.items[this.items.length - 1] || null; }
}

// 2026-09-03T16:24:52.317Z -> 2026-09-03T16-24-52-317Z (safe in a file name)
const stampOf = (t) => new Date(t).toISOString().replace(/[:.]/g, '-');
// the reverse, for the leading stamp of an archive file name; null if none
function parseStamp(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : null;
}
// "2026-09-03T16:24:52Z", "2026-09-03T16-24-52-317Z" or epoch ms -> ms
function parseTime(s) {
  s = String(s || '').replace(/\.jpg$/, '');
  if (/^\d{10,13}$/.test(s)) return Number(s.length === 10 ? s + '000' : s);
  const st = parseStamp(s); if (st !== null) return st;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
// nearest stamped name in a sorted list (raw frames only: no _a/_f/_cat suffixes unless allowed)
function nearestName(names, t, { suffix = '.jpg', raw = true } = {}) {
  let best = null;
  for (const n of names) {
    if (!n.endsWith(suffix)) continue;
    if (raw && /_(a|f|cat|cat_raw)\.jpg$/.test(n)) continue;
    const ts = parseStamp(n); if (ts === null) continue;
    const d = Math.abs(ts - t);
    if (!best || d < best.dt) best = { name: n, t: ts, dt: d };
  }
  return best;
}

module.exports = { FrameRing, stampOf, parseStamp, parseTime, nearestName };
