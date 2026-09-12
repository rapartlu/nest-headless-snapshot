'use strict';
// Who to report for a zone state change (#46).
//
// `zone_state` used to take ONE peopleNear sample, at the instant a state flip
// is announced. At a dishwasher that instant is exactly when the person is bent
// over the open door with their face to the floor, so the event that decides
// whether a child is credited with the chore saw nobody - while `zone_change`,
// which gets the hold's faces accumulated across the whole visit, logged
// "visit by <name>" for the same two minutes.
//
// So a state change reports this instant PLUS the visit: a face seen at any
// point while somebody was at the appliance counts. Entries merge on box
// overlap with the best-evidenced view winning, exactly as the hold accumulates
// them, and anything contributed by the visit rather than this frame is marked
// `from_visit` so a consumer can weigh it, and with the visit's own id.
//
// The id matters more than it looks. `heldPeople` merges on box overlap, so one
// person who steps aside and comes back during a visit becomes two entries, and
// a long visit can yield four names for what was really one or two people. As
// four independent boxes a consumer may pick the strongest and look confident;
// as one visit's candidates it can see they are competing for the same
// identity and hold them all as probable. Same `visit_id` means "these are
// alternatives", not "these are a crowd".

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = ix * iy;
  return i / Math.max(1e-9, a.w * a.h + b.w * b.h - i);
};

// fresh: peopleNear for this frame. held: faces from a visit in progress.
// recent: faces from a visit that has just ended, usable for windowMs.
function peopleForState(fresh, { held = [], recent = [], recentAtMs = 0, now = Date.now(), windowMs = 90000, minIou = 0.4, visitId = null, recentVisitId = null } = {}) {
  const out = (fresh || []).filter((p) => p && p.box).map((p) => ({ ...p }));
  const older = (held || []).map((p) => [p, visitId]);
  if ((recent || []).length && now - recentAtMs <= windowMs) older.push(...recent.map((p) => [p, recentVisitId]));
  for (const [p, vid] of older) {
    if (!p || !p.box) continue;
    const same = out.find((q) => iou(q.box, p.box) >= minIou);
    if (!same) { out.push({ ...p, from_visit: true, ...(vid ? { visit_id: vid } : {}) }); continue; }
    if ((p.score || 0) > (same.score || 0)) {
      same.name = p.name; same.score = p.score;
      same.matches = p.matches || same.matches || [];
      same.from_visit = true;
      if (vid) same.visit_id = vid;
    }
  }
  return out;
}

module.exports = { peopleForState, iou };
