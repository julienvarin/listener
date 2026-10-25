// Canvas map of the collection. The build groups records by shared styles, eras, labels and genre tags,
// then lays them out so each group forms an island (see scripts/collection_map.py).

import { norm, sharedTraits } from './library.js';

const PALETTE = ['#fa2d48', '#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#30b0c7', '#5e5ce6', '#a2845e', '#64d2ff', '#ffd60a', '#3a3a3c'];
const OTHER = '#c7c7cc';
const MODES = [['cluster', 'Clusters'], ['style', 'Style'], ['decade', 'Decade'], ['label', 'Label'], ['mygenre', 'My Genre']];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${Math.round(v * 100)}%`;
const clusterColor = (id) => `hsl(${(id * 137.508) % 360} 68% 52%)`;

const keyOf = {
  cluster: (r) => (r.cluster === undefined ? '' : String(r.cluster)),
  style: (r) => r.styles[0],
  decade: (r) => r.decade,
  label: (r) => r.label,
  mygenre: (r) => r.myGenre,
};

export class CollectionMap {
  constructor(root, lib, opts) {
    this.root = root;
    this.lib = lib;
    this.opts = opts;
    this.nodes = lib.releases.filter((r) => r.xy).map((r) => ({ r, x: r.xy[0], y: r.xy[1] }));
    this.byId = new Map(this.nodes.map((n) => [n.r.id, n]));
    this.clusters = new Map(lib.clusters.map((c) => [c.id, c]));
    // Labels sit just above each island so they don't cover its records.
    for (const c of this.clusters.values()) {
      const ys = this.nodes.filter((n) => n.r.cluster === c.id).map((n) => n.y).sort((a, b) => a - b);
      c.top = ys.length ? ys[Math.floor(ys.length * 0.06)] : c.y;
    }
    this.view = { x: 500, y: 500, k: 1 };
    this.images = new Map();
    this.hover = null;
    this.selected = null;
    this.cluster = null;
    this.query = '';
    this.isolate = null;
    this.labelRects = [];
    this.pointers = new Map();

    const { icon } = opts;
    root.innerHTML = `
      <canvas class="map-canvas"></canvas>
      <div class="map-top">
        <div class="map-title"><h1>Collection Map</h1>
          <p>Each island is a group of records sharing styles, eras, labels and your genre tags. Click an island’s name to see what defines it, or a record to see what it has in common with its neighbours.</p></div>
        <div class="segmented">${MODES.map(([k, l]) => `<button data-mode="${k}">${l}</button>`).join('')}</div>
        <label class="filter-field map-search">${icon('search')}<input type="search" placeholder="Highlight artist, label, style…"></label>
      </div>
      <div class="map-legend"></div>
      <div class="map-zoom"><button data-zoom="1.6" aria-label="Zoom in">${icon('plus')}</button><button data-zoom="0.625" aria-label="Zoom out">${icon('minus')}</button><button data-zoom="reset" aria-label="Reset">${icon('expand')}</button></div>
      <div class="map-tip" hidden></div>
      <div class="map-card" hidden></div>`;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tip = root.querySelector('.map-tip');
    this.cardEl = root.querySelector('.map-card');

    root.querySelector('.segmented').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) { this.setMode(b.dataset.mode); opts.onColor(b.dataset.mode); }
    });
    root.querySelector('.map-search input').addEventListener('input', (e) => { this.query = norm(e.target.value); this.draw(); });
    root.querySelector('.map-zoom').addEventListener('click', (e) => {
      const b = e.target.closest('[data-zoom]');
      if (!b) return;
      if (b.dataset.zoom === 'reset') this.view = { x: 500, y: 500, k: 1 };
      else this.zoomAt(this.w / 2, this.h / 2, Number(b.dataset.zoom));
      this.draw();
    });
    root.querySelector('.map-legend').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      if (this.mode === 'cluster') {
        const id = Number(b.dataset.cat);
        this.selectCluster(this.cluster?.id === id ? null : this.clusters.get(id), true);
        return;
      }
      this.isolate = this.isolate === b.dataset.cat ? null : b.dataset.cat;
      this.renderLegend();
      this.draw();
    });
    this.cardEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-map-action]');
      if (!b) return;
      const a = b.dataset.mapAction;
      if (a === 'play') opts.onPlay([this.selected.r.id]);
      else if (a === 'open') opts.onOpen(this.selected.r.id);
      else if (a === 'play-cluster') opts.onPlay(this.lib.clusterMembers.get(this.cluster.id).map((r) => r.id), true);
      else if (a === 'open-cluster') opts.onOpenCluster(this.cluster.id);
      else if (a === 'close') { this.select(null); this.selectCluster(null); }
      else if (a.startsWith('cluster:')) this.selectCluster(this.clusters.get(Number(a.slice(8))), true);
      else this.select(this.byId.get(Number(a)), true);
    });

    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.setMode(opts.colorBy);
    this.resize();
    if (opts.focus && this.byId.has(opts.focus)) this.select(this.byId.get(opts.focus), true);
    else if (opts.cluster !== null && this.clusters.has(opts.cluster)) this.selectCluster(this.clusters.get(opts.cluster), true);
    this.draw();
  }

  destroy() {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.raf);
  }

  setMode(mode) {
    const hasClusters = this.clusters.size > 0;
    this.mode = keyOf[mode] && (mode !== 'cluster' || hasClusters) ? mode : hasClusters ? 'cluster' : 'style';
    this.isolate = null;
    this.root.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === this.mode);
      if (b.dataset.mode === 'cluster') b.hidden = !hasClusters;
    });
    if (this.mode === 'cluster') {
      this.colors = new Map([...this.clusters.keys()].map((id) => [String(id), clusterColor(id)]));
      this.legend = [...this.clusters.values()].map((c) => [String(c.id), c.size, c.name]);
    } else {
      const counts = new Map();
      for (const n of this.nodes) {
        const k = keyOf[this.mode](n.r);
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      let cats = [...counts].sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length);
      if (this.mode === 'decade') cats = cats.sort((a, b) => a[0].localeCompare(b[0]));
      this.colors = new Map(cats.map(([k], i) => [k, PALETTE[i]]));
      this.legend = cats.map(([k, n]) => [k, n, k]);
    }
    for (const n of this.nodes) {
      n.cat = keyOf[this.mode](n.r) || '';
      n.color = this.colors.get(n.cat) || OTHER;
    }
    this.renderLegend();
    this.draw();
  }

  renderLegend() {
    const active = this.mode === 'cluster' ? (this.cluster ? String(this.cluster.id) : null) : this.isolate;
    this.root.querySelector('.map-legend').innerHTML = this.legend.map(([k, n, label]) =>
      `<button data-cat="${esc(k)}" class="${active && active !== k ? 'dim' : ''}"><i style="background:${this.colors.get(k)}"></i>${esc(label)}<span>${n}</span></button>`).join('');
  }

  resize() {
    const rect = this.root.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.fit = Math.min(this.w, this.h) / 1080;
    this.draw();
  }

  toScreen(n) {
    const s = this.fit * this.view.k;
    return [(n.x - this.view.x) * s + this.w / 2, (n.y - this.view.y) * s + this.h / 2];
  }

  zoomAt(sx, sy, factor) {
    const s = this.fit * this.view.k;
    const wx = (sx - this.w / 2) / s + this.view.x, wy = (sy - this.h / 2) / s + this.view.y;
    this.view.k = Math.min(40, Math.max(0.6, this.view.k * factor));
    const s2 = this.fit * this.view.k;
    this.view.x = wx - (sx - this.w / 2) / s2;
    this.view.y = wy - (sy - this.h / 2) / s2;
  }

  matches(n) {
    if (this.cluster && n.r.cluster !== this.cluster.id) return false;
    if (this.isolate && n.cat !== this.isolate) return false;
    return !this.query || n.r.hay.includes(this.query);
  }

  nodeAt(sx, sy) {
    let best = null, bestD = (this.view.k > 3.5 ? this.size() / 1.4 : 10) ** 2;
    for (const n of this.nodes) {
      const [x, y] = this.toScreen(n);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  labelAt(sx, sy) {
    return this.labelRects.find((l) => sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h)?.c || null;
  }

  size() { return Math.min(84, 5 * this.view.k); }

  image(n) {
    let img = this.images.get(n.r.id);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = () => this.draw();
      img.src = n.r.thumb || n.r.cover;
      this.images.set(n.r.id, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  paint() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const covers = this.view.k > 3.5;
    const size = this.size();
    const filtering = !!(this.query || this.isolate || this.cluster);
    const pad = size + 4;

    for (const pass of filtering ? [false, true] : [true]) {
      for (const n of this.nodes) {
        const hit = !filtering || this.matches(n);
        if (filtering && hit !== pass) continue;
        const [x, y] = this.toScreen(n);
        if (x < -pad || y < -pad || x > this.w + pad || y > this.h + pad) continue;
        ctx.globalAlpha = hit ? 1 : 0.1;
        const img = covers && hit ? this.image(n) : null;
        if (img) {
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,.18)';
          ctx.shadowBlur = 6;
          ctx.shadowOffsetY = 2;
          ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
          ctx.restore();
        } else {
          ctx.fillStyle = n.color;
          ctx.beginPath();
          ctx.arc(x, y, covers ? size / 3 : Math.max(2.2, 1.6 + this.view.k * 0.9), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    // Rings instead of lines: the focused record in accent, its most similar records lighter.
    const focus = this.selected || this.hover;
    if (focus) {
      const ring = (n, color, width) => {
        const [x, y] = this.toScreen(n);
        const r = covers ? size / 2 + 3 : 7;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        if (covers) ctx.rect(x - r, y - r, r * 2, r * 2);
        else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      };
      for (const id of focus.r.similar || []) {
        const m = this.byId.get(id);
        if (m) ring(m, 'rgba(250,45,72,.55)', 1.5);
      }
      ring(focus, '#fa2d48', 2.5);
    }

    this.labelRects = [];
    if (covers || !this.clusters.size) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of this.clusters.values()) {
      if (this.cluster && c.id !== this.cluster.id) continue;
      const fs = Math.round(Math.min(17, 11 + Math.sqrt(c.size) / 3));
      ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;
      const tw = ctx.measureText(c.name).width;
      const [cx, top] = this.toScreen({ x: c.x, y: c.top });
      const cy = top - fs / 2 - 10;
      const box = { x: cx - tw / 2 - 8, y: cy - fs / 2 - 6, w: tw + 16, h: fs + 12, c };
      if (this.labelRects.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)) continue;
      this.labelRects.push(box);
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, box.h / 2);
      ctx.fill();
      ctx.fillStyle = '#1d1d1f';
      ctx.fillText(c.name, cx, cy + 0.5);
    }
  }

  showTip(n, sx, sy) {
    if (!n) { this.tip.hidden = true; return; }
    const r = n.r;
    const c = this.clusters.get(r.cluster);
    this.tip.innerHTML = `<img src="${esc(r.thumb || r.cover)}" alt=""><div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.label, r.year].filter(Boolean).join(' · '))}</small>${c ? `<small>${esc(c.name)}</small>` : ''}</div>`;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(sx + 14, this.w - tw - 8)}px`;
    this.tip.style.top = `${Math.min(sy + 14, this.h - th - 8)}px`;
  }

  select(n, center = false) {
    this.selected = n;
    if (!n) { this.cardEl.hidden = true; this.draw(); return; }
    this.cluster = null;
    this.renderLegend();
    if (center) { this.view.x = n.x; this.view.y = n.y; this.view.k = Math.max(this.view.k, 7); }
    const r = n.r;
    const c = this.clusters.get(r.cluster);
    const sim = (r.similar || []).map((id) => this.byId.get(id)).filter(Boolean).slice(0, 5);
    const { icon } = this.opts;
    this.cardEl.innerHTML = `
      <button class="icon-btn map-card-close" data-map-action="close" aria-label="Close">${icon('close')}</button>
      <div class="map-card-head"><img src="${esc(r.cover)}" alt=""><div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.label, r.catno, r.year].filter(Boolean).join(' · '))}</small>
        ${c ? `<button class="map-cluster-link" data-map-action="cluster:${c.id}"><i style="background:${clusterColor(c.id)}"></i>${esc(c.name)}</button>` : ''}</div></div>
      <div class="head-actions"><button class="btn btn-primary" data-map-action="play">${icon('play')}Play</button><button class="btn" data-map-action="open">Open Album</button></div>
      ${sim.length ? `<p class="map-card-label">Most similar · ringed on the map</p><div class="map-sim">${sim.map((m) => `<button data-map-action="${m.r.id}"><img src="${esc(m.r.thumb || m.r.cover)}" alt=""><span><b>${esc(m.r.title)}</b><small>${esc(m.r.artist)}</small><em>${esc(sharedTraits(r, m.r).join(' · ') || 'Similar overall')}</em></span></button>`).join('')}</div>` : ''}`;
    this.cardEl.hidden = false;
    this.draw();
  }

  selectCluster(c, center = false) {
    this.cluster = c;
    this.selected = null;
    this.renderLegend();
    if (!c) { this.cardEl.hidden = true; this.draw(); return; }
    if (center) { this.view.x = c.x; this.view.y = c.y; this.view.k = Math.max(this.view.k, 2.2); }
    const members = this.lib.clusterMembers.get(c.id) || [];
    const covers = members.filter((r) => r.cover && !r.cover.includes('spacer.gif')).slice(0, 6);
    const line = (label, items) => items.length ? `<p class="map-def"><span>${label}</span>${items.map(([k, v]) => `${esc(k)} <em>${pct(v)}</em>`).join(', ')}</p>` : '';
    const { icon } = this.opts;
    this.cardEl.innerHTML = `
      <button class="icon-btn map-card-close" data-map-action="close" aria-label="Close">${icon('close')}</button>
      <p class="map-card-label"><i class="dot" style="background:${clusterColor(c.id)}"></i>Cluster · ${c.size} records</p>
      <h2 class="map-cluster-name">${esc(c.name)}</h2>
      ${line('Styles', c.styles)}
      ${line('Era', c.decades)}
      ${line('Your tags', c.own)}
      ${line('Labels', c.labels)}
      <div class="map-near">${covers.map((r) => `<button data-map-action="${r.id}" title="${esc(`${r.artist} — ${r.title}`)}"><img src="${esc(r.thumb || r.cover)}" alt=""></button>`).join('')}</div>
      <div class="head-actions"><button class="btn btn-primary" data-map-action="play-cluster">${icon('shuffle')}Shuffle</button><button class="btn" data-map-action="open-cluster">See All</button></div>`;
    this.cardEl.hidden = false;
    this.draw();
  }

  bindPointer() {
    const c = this.canvas;
    let moved = false, last = null, pinch = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)));
      else { const s = this.fit * this.view.k; this.view.x += e.deltaX / s; }
      this.draw();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      moved = false;
      last = [e.clientX, e.clientY];
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: this.view.k };
      }
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (!this.pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') {
          const label = this.labelAt(sx, sy);
          const n = label ? null : this.nodeAt(sx, sy);
          if (n !== this.hover) { this.hover = n; this.draw(); }
          this.showTip(n, sx, sy);
          c.style.cursor = n || label ? 'pointer' : 'grab';
        }
        return;
      }
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mx = (a[0] + b[0]) / 2 - rect.left, my = (a[1] + b[1]) / 2 - rect.top;
        this.zoomAt(mx, my, (pinch.k * (d / pinch.d)) / this.view.k);
        moved = true;
        this.draw();
        return;
      }
      const dx = e.clientX - last[0], dy = e.clientY - last[1];
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      const s = this.fit * this.view.k;
      this.view.x -= dx / s;
      this.view.y -= dy / s;
      last = [e.clientX, e.clientY];
      this.tip.hidden = true;
      c.style.cursor = 'grabbing';
      this.draw();
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) pinch = null;
      if (!moved && e.type === 'pointerup') {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const label = this.labelAt(sx, sy);
        const n = label ? null : this.nodeAt(sx, sy);
        if (label) this.selectCluster(label, true);
        else if (n) this.select(n);
        else { this.select(null); this.selectCluster(null); }
      }
      if (this.pointers.size === 1) last = [...this.pointers.values()][0];
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.draw(); } this.tip.hidden = true; });
    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, 2);
      this.draw();
    });
  }
}
