// Passage zones (Hearth #7): a polygon drawn across a doorway. When a tracked
// PERSON's feet move through it, one nest_headless_passage event is posted
// with a direction relative to the zone's declared inside (the room behind
// the door), a track id stable while that person stays in view, a cheap
// adult-vs-child hint (box height / frame height) and whether a bag came
// along. Pure logic, no I/O: the server feeds detections per sampled frame.
//
// Syntax (watch_passages), same as watch_rois polygons plus an optional
// inside point after '|':
//   downstairs_hallway_camera:downstairs_toilet@0.62,0.55:0.70,0.55:0.72,0.72:0.60,0.72|in=0.66,0.40;front_door@...
// Without `in=` the direction is "across".
'use strict';

function parseWatchPassages(spec) {
  const out = {};
  for (const entry of String(spec || '').split(/\s+/).filter(Boolean)) {
    const ci = entry.indexOf(':');
    if (ci < 0) continue;
    const cam = 'camera.' + entry.slice(0, ci);
    out[cam] = entry.slice(ci + 1).split(';').map((zone, i) => {
      let name = 'passage' + (i + 1), rest = zone;
      const at = zone.indexOf('@');
      if (at > 0) { name = zone.slice(0, at); rest = zone.slice(at + 1); }
      let inside = null;
      const bar = rest.indexOf('|');
      if (bar >= 0) {
        for (const opt of rest.slice(bar + 1).split('|')) {
          const m = /^in=([-\d.]+),([-\d.]+)$/.exec(opt);
          if (m) inside = [Number(m[1]), Number(m[2])];
        }
        rest = rest.slice(0, bar);
      }
      const pts = rest.split(':').map((pair) => pair.split(',').map(Number))
        .filter((q) => q.length === 2 && q.every(Number.isFinite));
      if (pts.length < 3) return null;
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      return { name, pts, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, centroid: [cx, cy], inside };
    }).filter(Boolean);
    if (!out[cam].length) delete out[cam];
  }
  return out;
}

function inPoly(pts, px, py) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Which side of the passage a point is on: +1 towards the declared inside,
// -1 away from it, 0 when there is no declared inside (line-style zone).
function sideOf(p, fx, fy) {
  if (!p.inside) return 0;
  const vx = p.inside[0] - p.centroid[0], vy = p.inside[1] - p.centroid[1];
  const d = (fx - p.centroid[0]) * vx + (fy - p.centroid[1]) * vy;
  return d >= 0 ? 1 : -1;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}

const TRACK_TTL_MS = 4000;      // a person unseen this long is gone (or through the door)
const REPEAT_MS = 2000;         // one event per track+passage per 2 s
const MATCH_IOU = 0.25, MATCH_DIST = 0.18;

class PassageTracker {
  constructor(camShort, passages) {
    this.cam = camShort;
    this.passages = passages;
    this.tracks = [];
    this.seq = 0;
    this.day = '';
  }

  newId(now) {
    const d = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    if (d !== this.day) { this.day = d; this.seq = 0; }
    this.seq++;
    return `${this.cam.replace(/^camera\./, '').replace(/_camera$/, '')}-${d}-${String(this.seq).padStart(6, '0')}`;
  }

  // persons/bags: [{box:{x,y,w,h}, conf}] in frame fractions. Returns events.
  update(persons, bags, now) {
    const events = [];
    const unmatched = new Set(this.tracks);
    const assigned = [];
    // greedy match: best IoU first, then nearest centroid for fast movers
    const cands = [];
    for (const t of this.tracks) for (const [i, p] of persons.entries()) {
      const s = iou(t.box, p.box);
      const dx = (t.box.x + t.box.w / 2) - (p.box.x + p.box.w / 2), dy = (t.box.y + t.box.h) - (p.box.y + p.box.h);
      const dist = Math.hypot(dx, dy);
      if (s >= MATCH_IOU || dist <= MATCH_DIST) cands.push({ t, i, score: s > 0 ? 1 + s : 1 - dist });
    }
    cands.sort((a, b) => b.score - a.score);
    const usedDet = new Set();
    for (const c of cands) {
      if (!unmatched.has(c.t) || usedDet.has(c.i)) continue;
      unmatched.delete(c.t); usedDet.add(c.i); assigned.push([c.t, persons[c.i]]);
    }
    for (const [i, p] of persons.entries()) {
      if (usedDet.has(i)) continue;
      const t = { id: this.newId(now), box: p.box, firstSeen: now, lastSeen: now, zones: {} };
      this.tracks.push(t); assigned.push([t, p]);
    }
    for (const [t, p] of assigned) {
      t.box = p.box; t.lastSeen = now;
      const fx = p.box.x + p.box.w / 2, fy = p.box.y + p.box.h;
      const carrying = bags.some((b) => iou(b.box, p.box) > 0.05 || (b.box.x + b.box.w / 2 > p.box.x && b.box.x + b.box.w / 2 < p.box.x + p.box.w && b.box.y + b.box.h / 2 > p.box.y && b.box.y + b.box.h / 2 < p.box.y + p.box.h)) ? 'bag' : null;
      t.attributes = { height_ratio: Math.round(p.box.h * 100) / 100, carrying };
      for (const pz of this.passages) {
        const z = t.zones[pz.name] || (t.zones[pz.name] = { inZone: false, lastSide: null, entrySide: null, lastEventMs: 0 });
        const inside = inPoly(pz.pts, fx, fy) || inPoly(pz.pts, fx, fy - 0.03);
        const side = sideOf(pz, fx, fy);
        if (!z.inZone && inside) { z.inZone = true; z.entrySide = z.lastSide; }
        else if (z.inZone && !inside) {
          z.inZone = false;
          let dir = null;
          if (pz.inside) {
            if (z.entrySide === null || z.entrySide !== side) dir = side > 0 ? 'in' : 'out';   // came through, or emerged from the doorway
          } else if (z.entrySide === null || true) dir = 'across';
          // 'across' zones (no inside point) chatter while someone hovers in an opening: longer guard
          if (dir && (!z.lastEventMs || now - z.lastEventMs >= (dir === 'across' ? 10000 : REPEAT_MS))) { z.lastEventMs = now; events.push(this.event(pz, dir, t, now)); }
        }
        if (!inside) z.lastSide = side;
      }
    }
    // expire: a track that vanished while standing in a doorway went through it
    const keep = [];
    for (const t of this.tracks) {
      if (now - t.lastSeen <= TRACK_TTL_MS) { keep.push(t); continue; }
      for (const pz of this.passages) {
        const z = t.zones[pz.name];
        if (!z || !z.inZone) continue;
        let dir = null;
        if (pz.inside) { if (z.entrySide !== null) dir = z.entrySide < 0 ? 'in' : 'out'; }
        else dir = 'across';
        if (dir && (!z.lastEventMs || now - z.lastEventMs >= REPEAT_MS)) events.push(this.event(pz, dir, t, t.lastSeen));
      }
    }
    this.tracks = keep;
    return events;
  }

  event(pz, direction, t, at) {
    return {
      passage: pz.name, direction, track_id: t.id, t: new Date(at).toISOString(),
      person: { matches: [] },
      attributes: t.attributes || { height_ratio: null, carrying: null },
    };
  }
}

module.exports = { parseWatchPassages, PassageTracker, inPoly };
