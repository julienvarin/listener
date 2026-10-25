// Canvas map of the collection; positions come from the build (t-SNE over shared artists/labels/styles/years).

import { norm } from './library.js';

const PALETTE = ['#fa2d48', '#0a84ff', '#34c759', '#ff9f0a', '#bf5af2', '#30b0c7', '#5e5ce6', '#a2845e', '#64d2ff', '#ffd60a', '#3a3a3c'];
const OTHER = '#c7c7cc';
const MODES = [['genre', 'Genre'], ['style', 'Style'], ['decade', 'Decade'], ['label', 'Label'], ['mygenre', 'My Genre']];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const keyOf = {
  genre: (r) => r.genres[0],
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
    this.view = { x: 500, y: 500, k: 1 };
    this.images = new Map();
    this.hover = null;
    this.selected = null;
    this.query = '';
    this.isolate = null;
    this.pointers = new Map();

    const { icon } = opts;
    root.innerHTML = `
      <canvas class="map-canvas"></canvas>
      <div class="map-top">
        <div class="map-title"><h1>Collection Map</h1><p>Records sit close together when they share artists, labels, styles or eras.</p></div>
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
      this.isolate = this.isolate === b.dataset.cat ? null : b.dataset.cat;
      this.renderLegend();
      this.draw();
    });
    this.cardEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-map-action]');
      if (!b) return;
      const id = this.selected?.r.id;
      if (b.dataset.mapAction === 'play') opts.onPlay(id);
      else if (b.dataset.mapAction === 'open') opts.onOpen(id);
      else if (b.dataset.mapAction === 'close') this.select(null);
      else this.select(this.byId.get(Number(b.dataset.mapAction)), true);
    });

    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.setMode(opts.colorBy);
    this.resize();
    if (opts.focus && this.byId.has(opts.focus)) {
      this.select(this.byId.get(opts.focus), true);
      this.view.k = 7;
    }
    this.draw();
  }

  destroy() {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.raf);
  }

  setMode(mode) {
    this.mode = keyOf[mode] ? mode : 'style';
    this.isolate = null;
    this.root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    const counts = new Map();
    for (const n of this.nodes) {
      const k = keyOf[this.mode](n.r);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    let cats = [...counts].sort((a, b) => b[1] - a[1]).slice(0, PALETTE.length);
    if (this.mode === 'decade') cats = cats.sort((a, b) => a[0].localeCompare(b[0]));
    this.colors = new Map(cats.map(([k], i) => [k, PALETTE[i]]));
    this.legend = cats;
    for (const n of this.nodes) {
      n.cat = keyOf[this.mode](n.r) || '';
      n.color = this.colors.get(n.cat) || OTHER;
    }
    this.centroids = cats.map(([k]) => {
      const pts = this.nodes.filter((n) => n.cat === k);
      const xs = pts.map((p) => p.x).sort((a, b) => a - b), ys = pts.map((p) => p.y).sort((a, b) => a - b);
      return { k, x: xs[xs.length >> 1], y: ys[ys.length >> 1] };
    });
    this.renderLegend();
    this.draw();
  }

  renderLegend() {
    this.root.querySelector('.map-legend').innerHTML = this.legend.map(([k, n]) =>
      `<button data-cat="${esc(k)}" class="${this.isolate && this.isolate !== k ? 'dim' : ''}"><i style="background:${this.colors.get(k)}"></i>${esc(k)}<span>${n}</span></button>`).join('');
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
    if (this.isolate && n.cat !== this.isolate) return false;
    return !this.query || n.r.hay.includes(this.query);
  }

  nodeAt(sx, sy) {
    let best = null, bestD = (this.view.k > 3 ? this.size() / 1.4 : 10) ** 2;
    for (const n of this.nodes) {
      const [x, y] = this.toScreen(n);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
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
    const filtering = !!(this.query || this.isolate);
    const focus = this.selected || this.hover;

    if (focus) {
      ctx.strokeStyle = 'rgba(250,45,72,.45)';
      ctx.lineWidth = 1.5;
      const [fx, fy] = this.toScreen(focus);
      for (const id of focus.r.similar || []) {
        const m = this.byId.get(id);
        if (!m) continue;
        const [x, y] = this.toScreen(m);
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(x, y); ctx.stroke();
      }
    }

    const pad = size + 4;
    for (const pass of filtering ? [false, true] : [true]) {
      for (const n of this.nodes) {
        const hit = !filtering || this.matches(n);
        if (filtering && hit !== pass) continue;
        const [x, y] = this.toScreen(n);
        if (x < -pad || y < -pad || x > this.w + pad || y > this.h + pad) continue;
        ctx.globalAlpha = hit ? 1 : 0.12;
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

    if (focus) {
      const [x, y] = this.toScreen(focus);
      const r = covers ? size / 2 + 3 : 7;
      ctx.strokeStyle = '#fa2d48';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      covers ? ctx.rect(x - r, y - r, r * 2, r * 2) : ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (!covers && !filtering) {
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
      ctx.textAlign = 'center';
      for (const c of this.centroids) {
        const [x, y] = this.toScreen(c);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.strokeText(c.k, x, y);
        ctx.fillStyle = '#1d1d1f';
        ctx.fillText(c.k, x, y);
      }
    }
  }

  showTip(n, sx, sy) {
    if (!n) { this.tip.hidden = true; return; }
    const r = n.r;
    this.tip.innerHTML = `<img src="${esc(r.thumb || r.cover)}" alt=""><div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.label, r.year].filter(Boolean).join(' · '))}</small></div>`;
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(sx + 14, this.w - tw - 8)}px`;
    this.tip.style.top = `${Math.min(sy + 14, this.h - th - 8)}px`;
  }

  select(n, center = false) {
    this.selected = n;
    if (!n) { this.cardEl.hidden = true; this.draw(); return; }
    if (center) { this.view.x = n.x; this.view.y = n.y; this.view.k = Math.max(this.view.k, 7); }
    const r = n.r;
    const sim = (r.similar || []).map((id) => this.byId.get(id)).filter(Boolean);
    const { icon } = this.opts;
    this.cardEl.innerHTML = `
      <button class="icon-btn map-card-close" data-map-action="close" aria-label="Close">${icon('close')}</button>
      <div class="map-card-head"><img src="${esc(r.cover)}" alt=""><div><b>${esc(r.title)}</b><span>${esc(r.artist)}</span><small>${esc([r.label, r.catno, r.year].filter(Boolean).join(' · '))}</small><small>${esc(r.styles.slice(0, 3).join(', '))}</small></div></div>
      <div class="head-actions"><button class="btn btn-primary" data-map-action="play">${icon('play')}Play</button><button class="btn" data-map-action="open">Open Album</button></div>
      ${sim.length ? `<p class="map-card-label">Nearby</p><div class="map-near">${sim.slice(0, 6).map((m) => `<button data-map-action="${m.r.id}" title="${esc(`${m.r.artist} — ${m.r.title}`)}"><img src="${esc(m.r.thumb || m.r.cover)}" alt=""></button>`).join('')}</div>` : ''}`;
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
          const n = this.nodeAt(sx, sy);
          if (n !== this.hover) { this.hover = n; this.draw(); }
          this.showTip(n, sx, sy);
          c.style.cursor = n ? 'pointer' : 'grab';
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
        this.select(this.nodeAt(e.clientX - rect.left, e.clientY - rect.top));
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
