/* capture-timeline-card: renders the nest_headless per-camera capture
   timeline (samples/<camera>/timeline.json) - each archived frame with its
   annotated image, verdicts, detections and confidences. */

class CaptureTimelineCard extends HTMLElement {
  setConfig(config) {
    if (!config.camera) throw new Error('camera required');
    this._cfg = { limit: 40, refresh: 60, ...config };
    this._filter = 'all';
  }
  getCardSize() { return 10; }
  set hass(hass) {
    if (!this._root) {
      this._root = this.attachShadow({ mode: 'open' });
      this._root.innerHTML = `<style>
        .card { background: var(--ha-card-background, var(--card-background-color,#fff));
          border-radius: var(--ha-card-border-radius,12px); border: 1px solid var(--divider-color,#e0e0e0);
          padding: 14px 14px 6px; color: var(--primary-text-color,#212121);
          font-family: var(--paper-font-body1_-_font-family, system-ui, sans-serif); }
        h2 { font-size: 16px; font-weight: 600; margin: 0 0 10px; }
        .filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
        .fbtn { font-size: 12px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
          background: var(--secondary-background-color,#f0f0f0); color: var(--primary-text-color,#212121);
          border: 1px solid var(--divider-color,#e0e0e0); user-select: none; }
        .fbtn.on { background: var(--primary-color,#03a9f4); color: #fff; border-color: transparent; font-weight: 600; }
        .row { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--divider-color,#e0e0e0);
          cursor: pointer; align-items: flex-start; }
        .row img { width: 128px; border-radius: 6px; display: block; }
        .meta { flex: 1; min-width: 0; }
        .t { font-size: 12.5px; color: var(--secondary-text-color,#727272); }
        .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
        .chip { font-size: 11px; padding: 1px 7px; border-radius: 9px;
          background: var(--secondary-background-color,#f0f0f0); color: var(--primary-text-color,#212121); }
        .chip.alert { background: #e8443a; color: #fff; font-weight: 600; }
        .chip.ok { background: #2e7d32; color: #fff; }
        .chip.warn { background: #eda100; color: #1d1c1a; }
        .big { width: 100%; margin: 6px 0; border-radius: 8px; display: none; }
        .row.open + .big { display: block; }
        .empty { padding: 16px 0; font-size: 13px; color: var(--secondary-text-color,#727272); }
      </style>
      <div class="card"><h2></h2><div id="filters" class="filters"></div>
        <div id="list"><div class="empty">Loading timeline…</div></div></div>`;
      this._root.querySelector('h2').textContent = this._cfg.title || this._cfg.camera;
      this._load();
      this._timer = setInterval(() => this._load(), (this._cfg.refresh) * 1000);
    }
  }
  disconnectedCallback() { if (this._timer) clearInterval(this._timer); }

  // Filter predicates over timeline entries. "dets" is any detection at all,
  // including below-alert-threshold and off-surface sightings - the
  // "suspected" view; "alert" is only verdicts that would fire the deterrent.
  static get FILTERS() {
    return {
      all:   { label: 'All', test: () => true },
      alert: { label: '🐱 alerts', test: (e) => e.cat === true },
      dets:  { label: 'detections', test: (e) => e.cat === true || (e.dets || []).length > 0 },
      open:  { label: 'door open', test: (e) => !!(e.classifier && e.classifier.positive) },
    };
  }

  async _load() {
    const cam = this._cfg.camera;
    try {
      const r = await fetch(`/local/nest/samples/${cam}/timeline.json?_=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) this._data = await r.json();
    } catch (e) { /* keep old view */ }
    this._render();
  }

  _render() {
    const cam = this._cfg.camera;
    const data = this._data || [];
    const F = CaptureTimelineCard.FILTERS;
    const hasClassifier = data.some((e) => e.classifier);
    const keys = Object.keys(F).filter((k) => k !== 'open' || hasClassifier);
    const fbar = this._root.querySelector('#filters');
    fbar.innerHTML = keys.map((k) => {
      const n = k === 'all' ? data.length : data.filter(F[k].test).length;
      return `<span class="fbtn ${this._filter === k ? 'on' : ''}" data-f="${k}">${F[k].label} (${n})</span>`;
    }).join('');
    fbar.querySelectorAll('.fbtn').forEach((b) => b.addEventListener('click', () => {
      this._filter = b.dataset.f; this._render();
    }));
    const list = this._root.querySelector('#list');
    if (!data.length) { list.innerHTML = '<div class="empty">No captures archived yet.</div>'; return; }
    // filter across the FULL history, then cap - so "detections" surfaces
    // every sighting in the rolling window, not just recent rows
    const shown = data.filter(F[this._filter].test).slice(0, this._cfg.limit);
    if (!shown.length) { list.innerHTML = '<div class="empty">Nothing matches this filter in the current window.</div>'; return; }
    const rows = shown.map((e, i) => {
      const img = `/local/nest/samples/${cam}/${e.aimg || e.img}`;
      const dt = new Date(e.t);
      const ago = Math.round((Date.now() - dt.getTime()) / 60000);
      const chips = [];
      if (e.cat === true) chips.push('<span class="chip alert">🐱 cat on surface</span>');
      for (const d of e.dets || []) chips.push(`<span class="chip">${d.name} ${(d.conf * 100).toFixed(0)}%${d.roi ? ' · ' + d.roi : ''}</span>`);
      if (e.classifier) {
        const c = e.classifier;
        chips.push(`<span class="chip ${c.positive ? 'alert' : 'ok'}">${c.positive ? 'OPEN' : 'closed'} ${(c.score * 100).toFixed(0)}%</span>`);
        if (c.engine) chips.push(`<span class="chip">${c.engine}</span>`);
        if (c.framingOk === false) chips.push('<span class="chip warn">framing drift</span>');
      }
      if (e.luma !== undefined && e.luma < 30) chips.push(`<span class="chip">dark ${e.luma}</span>`);
      return `<div class="row" data-i="${i}">
          <img loading="lazy" src="${img}">
          <div class="meta">
            <div class="t">${dt.toLocaleTimeString()} · ${dt.toLocaleDateString()} · ${ago < 60 ? ago + ' min ago' : Math.round(ago / 60) + ' h ago'}</div>
            <div class="chips">${chips.join('') || '<span class="chip">no detections</span>'}</div>
          </div>
        </div><img class="big" loading="lazy" src="${img}">`;
    }).join('');
    list.innerHTML = rows;
    list.querySelectorAll('.row').forEach((r) => {
      r.addEventListener('click', () => r.classList.toggle('open'));
    });
  }
}
customElements.define('capture-timeline-card', CaptureTimelineCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'capture-timeline-card', name: 'Capture Timeline Card',
  description: 'nest_headless capture timeline with detections, verdicts and filters' });
