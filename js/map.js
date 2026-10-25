// Canvas map of the collection. The build groups records by shared styles, eras, labels and genre tags,
// then lays them out so each group forms an island (see scripts/collection_map.py).

import { norm, sharedTraits } from './library.js';

const PALETTE = ['#fa2d48', '#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#30b0c7', '#5e5ce6', '#a2845e', '#64d2ff', '#ffd60a', '#3a3a3c'];
const OTHER = '#c7c7cc';
const MODES = [['cluster', 'Clusters'], ['style', 'Style'], ['decade', 'Decade'], ['label', 'Label'], ['mygenre', 'My Genre']];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${Math.round(v * 100)}%`;

function composition(c) {
  const line = (label, items) => items?.length ? `<p class="map-def"><span>${label}</span>${items.map(([k, v]) => `${esc(k)} <em>${pct(v)}</em>`).join(', ')}</p>` : '';
  return `${line('Styles', c.styles?.slice(0, 4))}${line('Your notes', c.moods)}${line('Countries', c.countries)}${line('Era', c.decades)}${line('Labels', c.labels)}${line('Your tags', c.own)}`;
}
const regionHue = (id) => (id * 360 / 12 + 8) % 360;

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
    this.regions = new Map(lib.regions.map((g) => [g.id, g]));
    // Mini clusters share their region's hue, with a different shade each.
    const shade = new Map();
    for (const c of this.clusters.values()) {
      const i = shade.get(c.region) || 0;
      shade.set(c.region, i + 1);
      c.color = `hsl(${regionHue(c.region ?? c.id)} ${62 + (i % 3) * 8}% ${40 + (i % 4) * 7}%)`;
    }
    for (const g of this.regions.values()) g.color = `hsl(${regionHue(g.id)} 70% 46%)`;
    this.region = null;
    // Labels sit just above each island so they don't cover its records.
    const topOf = (pick) => {
      const ys = this.nodes.filter(pick).map((n) => n.y).sort((a, b) => a - b);
      return ys.length ? ys[Math.floor(ys.length * 0.06)] : null;
    };
    for (const c of this.clusters.values()) c.top = topOf((n) => n.r.cluster === c.id) ?? c.y;
    for (const g of this.regions.values()) g.top = topOf((n) => n.r.region === g.id) ?? g.y;
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
          <p>Regions split into smaller crates as you zoom in. Records sit together when they share styles, eras, labels, countries, your genre tags and the words in your notes. Click a name to see what defines it.</p></div>
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
        if (this.regions.size) this.selectRegion(this.region?.id === id ? null : this.regions.get(id), true);
        else this.selectCluster(this.cluster?.id === id ? null : this.clusters.get(id), true);
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
      else if (a === 'play-region') opts.onPlay(this.lib.regionMembers.get(this.region.id).map((r) => r.id), true);
      else if (a === 'open-region') opts.onOpenRegion(this.region.id);
      else if (a === 'close') { this.select(null); this.selectCluster(null); this.selectRegion(null); }
      else if (a.startsWith('cluster:')) this.selectCluster(this.clusters.get(Number(a.slice(8))), true);
      else if (a.startsWith('region:')) this.selectRegion(this.regions.get(Number(a.slice(7))), true);
      else this.select(this.byId.get(Number(a)), true);
    });

    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.setMode(opts.colorBy);
    this.resize();
    if (opts.focus && this.byId.has(opts.focus)) this.select(this.byId.get(opts.focus), true);
    else if (opts.cluster !== null && this.clusters.has(opts.cluster)) this.selectCluster(this.clusters.get(opts.cluster), true);
    else if (opts.region !== null && this.regions.has(opts.region)) this.selectRegion(this.regions.get(opts.region), true);
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
      this.colors = new Map([...this.clusters.values()].map((c) => [String(c.id), c.color]));
      const top = this.regions.size ? [...this.regions.values()] : [...this.clusters.values()];
      this.legend = top.map((c) => [String(c.id), c.size, c.name, c.color]);
    } else {
      const counts = new Map();
      for (const n of this.nodes) {
        const k = keyOf[this.mode](n.r);
        if (k) counts.set(k, (counts.get(k) || 0) + 1);
      }
      let cats = [...counts].sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length);
      if (this.mode === 'decade') cats = cats.sort((a, b) => a[0].localeCompare(b[0]));
      this.colors = new Map(cats.map(([k], i) => [k, PALETTE[i]]));
      this.legend = cats.map(([k, n]) => [k, n, k, this.colors.get(k)]);
    }
    for (const n of this.nodes) {
      n.cat = keyOf[this.mode](n.r) || '';
      n.color = this.colors.get(n.cat) || OTHER;
    }
    this.renderLegend();
    this.draw();
  }

  renderLegend() {
    const focus = this.regions.size ? this.region?.id ?? (this.cluster ? this.cluster.region : null) : this.cluster?.id;
    const active = this.mode === 'cluster' ? (focus != null ? String(focus) : null) : this.isolate;
    this.root.querySelector('.map-legend').innerHTML = this.legend.map(([k, n, label, color]) =>
      `<button data-cat="${esc(k)}" class="${active && active !== k ? 'dim' : ''}"><i style="background:${color}"></i>${esc(label)}<span>${n}</span></button>`).join('');
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
    if (this.region && n.r.region !== this.region.id) return false;
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
    return this.labelRects.find((l) => sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) || null;
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
    const filtering = !!(this.query || this.isolate || this.cluster || this.region);
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
    const showRegions = this.regions.size && this.view.k < 1.7 && !this.cluster;
    const items = showRegions ? [...this.regions.values()] : [...this.clusters.values()];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of items) {
      if (this.cluster && c.id !== this.cluster.id) continue;
      if (!showRegions && this.region && c.region !== this.region.id) continue;
      const fs = showRegions ? 16 : 13;
      const font = (size, weight) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;
      ctx.font = font(fs, showRegions ? 700 : 600);
      const nameW = ctx.measureText(c.name).width;
      const facts = showRegions ? '' : c.facts || '';
      ctx.font = font(11, 400);
      const factsW = facts ? ctx.measureText(facts).width : 0;
      const w = Math.max(nameW, factsW) + 18;
      const h = facts ? fs + 24 : fs + 12;
      const [cx, top] = this.toScreen({ x: c.x, y: c.top });
      const box = { x: cx - w / 2, y: top - h - 8, w, h, c, kind: showRegions ? 'region' : 'cluster' };
      if (this.labelRects.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)) continue;
      this.labelRects.push(box);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, 10);
      ctx.fill();
      ctx.fillStyle = showRegions ? c.color : '#1d1d1f';
      ctx.font = font(fs, showRegions ? 700 : 600);
      ctx.fillText(c.name, cx, box.y + (facts ? fs / 2 + 6 : h / 2 + 0.5));
      if (facts) {
        ctx.fillStyle = '#86868b';
        ctx.font = font(11, 400);
        ctx.fillText(facts, cx, box.y + fs + 14);
      }
    }
  }

  showTip(n, sx, sy) {
    if (!n) { this.tip.hidden = true; return; }
    const r = n.r;
    const c = this.clusters.get(r.cluster);
    this.tip.innerHTML = `<img src="${esc(r.thumb || r.cover)}" alt=""><div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.label, r.year].filter(Boolean).join(' · '))}</small>${c ? `<small style="color:${c.color}">${esc(c.name)}</small>` : ''}</div>`;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(sx + 14, this.w - tw - 8)}px`;
    this.tip.style.top = `${Math.min(sy + 14, this.h - th - 8)}px`;
  }

  select(n, center = false) {
    this.selected = n;
    if (!n) { this.cardEl.hidden = true; this.draw(); return; }
    this.cluster = null;
    this.region = null;
    this.renderLegend();
    if (center) { this.view.x = n.x; this.view.y = n.y; this.view.k = Math.max(this.view.k, 7); }
    const r = n.r;
    const c = this.clusters.get(r.cluster);
    const sim = (r.similar || []).map((id) => this.byId.get(id)).filter(Boolean).slice(0, 5);
    const { icon } = this.opts;
    this.cardEl.innerHTML = `
      <button class="icon-btn map-card-close" data-map-action="close" aria-label="Close">${icon('close')}</button>
      <div class="map-card-head"><img src="${esc(r.cover)}" alt=""><div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.label, r.catno, r.year].filter(Boolean).join(' · '))}</small>
        ${c ? `<button class="map-cluster-link" data-map-action="cluster:${c.id}"><i style="background:${c.color}"></i>${esc(c.name)}</button>` : ''}</div></div>
      <div class="head-actions"><button class="btn btn-primary" data-map-action="play">${icon('play')}Play</button><button class="btn" data-map-action="open">Open Album</button></div>
      ${sim.length ? `<p class="map-card-label">Most similar · ringed on the map</p><div class="map-sim">${sim.map((m) => `<button data-map-action="${m.r.id}"><img src="${esc(m.r.thumb || m.r.cover)}" alt=""><span><b>${esc(m.r.title)}</b><small>${esc(m.r.artist)}</small><em>${esc(sharedTraits(r, m.r).join(' · ') || 'Similar overall')}</em></span></button>`).join('')}</div>` : ''}`;
    this.cardEl.hidden = false;
    this.draw();
  }

  selectCluster(c, center = false) {
    this.cluster = c;
    this.selected = null;
    this.region = null;
    this.renderLegend();
    if (!c) { this.cardEl.hidden = true; this.draw(); return; }
    if (center) { this.view.x = c.x; this.view.y = c.y; this.view.k = Math.max(this.view.k, 2.6); }
    const members = this.lib.clusterMembers.get(c.id) || [];
    const covers = members.filter((r) => r.cover && !r.cover.includes('spacer.gif')).slice(0, 6);
    const g = this.regions.get(c.region);
    const { icon } = this.opts;
    this.cardEl.innerHTML = `
      <button class="icon-btn map-card-close" data-map-action="close" aria-label="Close">${icon('close')}</button>
      ${g ? `<button class="map-card-label map-region-link" data-map-action="region:${g.id}"><i class="dot" style="background:${g.color}"></i>${esc(g.name)}</button>` : ''}
      <h2 class="map-cluster-name" style="color:${c.color}">${esc(c.name)}</h2>
      <p class="map-facts">${esc(c.facts || `${c.size} records`)}</p>
      ${composition(c)}
      <div class="map-near">${covers.map((r) => `<button data-map-action="${r.id}" title="${esc(`${r.artist} — ${r.title}`)}"><img src="${esc(r.thumb || r.cover)}" alt=""></button>`).join('')}</div>
      <div class="head-actions"><button class="btn btn-primary" data-map-action="play-cluster">${icon('shuffle')}Shuffle</button><button class="btn" data-map-action="open-cluster">See All</button></div>`;
    this.cardEl.hidden = false;
    this.draw();
  }

  selectRegion(g, center = false) {
    this.region = g;
    this.cluster = null;
    this.selected = null;
    this.renderLegend();
    if (!g) { this.cardEl.hidden = true; this.draw(); return; }
    if (center) { this.view.x = g.x; this.view.y = g.y; this.view.k = Math.max(this.view.k, 1.8); }
    const minis = [...this.clusters.values()].filter((c) => c.region === g.id).sort((a, b) => b.size - a.size);
    const { icon } = this.opts;
    this.cardEl.innerHTML = `
      <button class="icon-btn map-card-close" data-map-action="close" aria-label="Close">${icon('close')}</button>
      <p class="map-card-label"><i class="dot" style="background:${g.color}"></i>Region</p>
      <h2 class="map-cluster-name" style="color:${g.color}">${esc(g.name)}</h2>
      <p class="map-facts">${esc(g.facts || `${g.size} records`)}</p>
      ${composition(g)}
      <div class="map-minis">${minis.map((c) => `<button data-map-action="cluster:${c.id}"><i style="background:${c.color}"></i><span><b>${esc(c.name)}</b><small>${esc(c.facts || '')}</small></span></button>`).join('')}</div>
      <div class="head-actions"><button class="btn btn-primary" data-map-action="play-region">${icon('shuffle')}Shuffle</button><button class="btn" data-map-action="open-region">See All</button></div>`;
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
        if (label) label.kind === 'region' ? this.selectRegion(label.c, true) : this.selectCluster(label.c, true);
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
