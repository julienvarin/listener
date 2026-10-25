import { parseBundle, deriveKey, openBundle, rememberKey, recallKey, forgetKey } from './crypto.js';
import { Library, appleCached, fmtTime, norm } from './library.js';
import { Player } from './player.js';
import { Playlists } from './playlists.js';
import { icon } from './icons.js';
import { CollectionMap } from './map.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const isMobile = () => matchMedia('(max-width: 760px)').matches;
const euro = (v) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: v < 10 ? 2 : 0 }).format(v);

let lib, player, playlists;
const lists = new Map();
let listSeq = 0;
const scrollMemory = new Map();

/* ---------- boot & unlock ---------- */

async function boot() {
  const lock = $('#lock');
  let bundle;
  try {
    const res = await fetch('data/library.enc', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bundle = parseBundle(await res.arrayBuffer());
  } catch (e) {
    lock.hidden = false;
    $('#lock-status').textContent = `Library not built yet (${e.message}).`;
    return;
  }
  const saved = await recallKey(bundle);
  if (saved) {
    try { return start(await openBundle(bundle, saved)); } catch { forgetKey(); }
  }
  lock.hidden = false;
  $('#lock-password').focus();
  $('.lock-card').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#lock-status');
    status.textContent = 'Unlocking…';
    try {
      const key = await deriveKey($('#lock-password').value, bundle);
      const payload = await openBundle(bundle, key);
      if ($('#lock-remember').checked) await rememberKey(key, bundle);
      lock.hidden = true;
      start(payload);
    } catch {
      status.textContent = 'Wrong password.';
      $('.lock-card').classList.remove('shake');
      void $('.lock-card').offsetWidth;
      $('.lock-card').classList.add('shake');
      $('#lock-password').select();
    }
  });
}

function start(payload) {
  lib = new Library(payload);
  player = new Player();
  playlists = new Playlists();
  $('#app').hidden = false;

  player.addEventListener('track', () => { renderPlayer(); markCurrent(); renderQueue(); renderSheet(); });
  player.addEventListener('state', () => { renderPlayer(); markCurrent(); renderSheet(); });
  player.addEventListener('time', updateProgress);
  player.addEventListener('queue', () => { renderPlayer(); renderQueue(); renderSheet(); });
  player.addEventListener('unavailable', () => toast('No audio found for this track — skipped'));
  playlists.addEventListener('change', () => { renderSidebar(); if (route().seg[0]?.startsWith('playlist')) render(); });
  playlists.addEventListener('status', renderSidebar);

  renderSidebar();
  renderTabbar();
  renderPlayer();
  window.addEventListener('hashchange', () => render());
  render();
  bindGlobal();
  playlists.connect(lib.gistToken);
}

/* ---------- routing ---------- */

function route() {
  const h = location.hash.slice(1) || '/discover';
  const [path, qs = ''] = h.split('?');
  return { seg: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs), key: h };
}

let lastKey = null;
let activeMap = null;
function render() {
  const main = $('#main');
  activeMap?.destroy();
  activeMap = null;
  main.classList.remove('full-bleed');
  if (lastKey) scrollMemory.set(lastKey, main.scrollTop);
  lists.clear();
  const r = route();
  const [view, arg] = r.seg;
  const views = {
    discover: () => discoverView(),
    list: () => shelfListView(arg, r),
    map: () => mapView(r),
    mygenres: () => tilesView('My Genres', lib.myGenres, 'mygenre'),
    mygenre: () => collectionView(arg, 'My Genre', lib.myGenres.get(arg), r, false, 'added'),
    cluster: () => clusterView(Number(arg), r),
    recent: () => browseView('Recently Added', lib.releases, r, { sort: 'added' }),
    albums: () => browseView('Albums', lib.releases, r, { sort: 'artist' }),
    artists: () => indexView('Artists', lib.artists, 'artist', true),
    labels: () => indexView('Labels', lib.labels, 'label', false),
    genres: () => tilesView('Genres', lib.genres, 'genre'),
    styles: () => tilesView('Styles', lib.styles, 'style'),
    decades: () => tilesView('Decades', lib.decades, 'decade', (a, b) => a[0].localeCompare(b[0])),
    artist: () => collectionView(arg, 'Artist', lib.artists.get(arg), r, true),
    label: () => collectionView(arg, 'Label', lib.labels.get(arg), r),
    genre: () => collectionView(arg, 'Genre', lib.genres.get(arg), r),
    style: () => collectionView(arg, 'Style', lib.styles.get(arg), r),
    decade: () => collectionView(arg, 'Decade', lib.decades.get(arg), r, false, 'year'),
    album: () => albumView(lib.byId.get(Number(arg))),
    playlists: () => playlistsView(),
    playlist: () => playlistView(playlists.get(arg)),
    search: () => searchView(r.q.get('q') || ''),
    library: () => libraryView(),
  };
  main.innerHTML = '';
  (views[view] || views.discover)();
  main.scrollTop = scrollMemory.get(r.key) || 0;
  lastKey = r.key;
  highlightNav(view || 'discover', arg);
  markCurrent();
}

function go(hash) { location.hash = hash; }

/* ---------- sidebar & tabbar ---------- */

const NAV = [
  ['discover', 'Listen Now', 'play-circle'],
  ['map', 'Collection Map', 'map'],
  ['recent', 'Recently Added', 'clock'],
  ['albums', 'Albums', 'album'],
  ['artists', 'Artists', 'mic'],
  ['labels', 'Labels', 'tag'],
  ['genres', 'Genres', 'grid'],
  ['styles', 'Styles', 'sparkles'],
  ['decades', 'Decades', 'calendar'],
  ['mygenres', 'My Genres', 'bookmark'],
];

function renderSidebar() {
  const sync = { local: '', syncing: 'Syncing…', synced: 'Playlists synced', error: 'Sync failed' }[playlists.status];
  const updated = lib.generated ? new Date(lib.generated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const prev = $('#search');
  const search = prev?.value ?? '';
  const focused = prev && document.activeElement === prev ? [prev.selectionStart, prev.selectionEnd] : null;
  $('#sidebar').innerHTML = `
    <div class="side-brand"><img src="icon.svg" alt=""><span>Listener</span></div>
    <label class="side-search">${icon('search')}<input id="search" type="search" placeholder="Search" autocomplete="off" spellcheck="false" value="${esc(search)}"><kbd>⌘K</kbd></label>
    <nav class="side-nav">
      <h6>Library</h6>
      ${NAV.map(([id, label, ic]) => `<a href="#/${id}" data-nav="${id}">${icon(ic)}<span>${label}</span></a>`).join('')}
      <h6>Playlists <button class="icon-btn" data-action="new-playlist" title="New Playlist">${icon('plus')}</button></h6>
      ${playlists.all.map((p) => `<a href="#/playlist/${p.id}" data-nav="playlist:${p.id}" data-drop-playlist="${p.id}">${icon('playlist')}<span>${esc(p.name)}</span></a>`).join('')}
      ${playlists.all.length ? '' : '<p class="side-empty">Create a playlist with + or from any track’s ••• menu.</p>'}
    </nav>
    <footer class="side-foot">
      <span>${plural(lib.releases.length, 'record')}${updated ? ` · updated ${updated}` : ''}</span>
      ${sync ? `<span class="sync sync-${playlists.status}">${sync}</span>` : ''}
      <button class="link-btn" data-action="lock">Lock</button>
    </footer>`;
  if (focused) { $('#search').focus(); $('#search').setSelectionRange(...focused); }
  highlightNav(...route().seg);
}

function renderTabbar() {
  const tabs = [['discover', 'Listen Now', 'play-circle'], ['library', 'Library', 'album'], ['map', 'Map', 'map'], ['search', 'Search', 'search'], ['playlists', 'Playlists', 'playlist']];
  $('#tabbar').innerHTML = tabs.map(([id, label, ic]) => `<a href="#/${id}" data-tab="${id}">${icon(ic)}<span>${label}</span></a>`).join('');
}

function highlightNav(view = 'discover', arg) {
  const id = view === 'playlist' ? `playlist:${arg}` : view;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === id));
  const tabFor = { discover: 'discover', list: 'discover', map: 'map', search: 'search', playlists: 'playlists', playlist: 'playlists' }[view] || 'library';
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === tabFor));
}

/* ---------- shared pieces ---------- */

const hasCover = (r) => r.cover && !r.cover.includes('spacer.gif');
const art = (r, cls = '') => hasCover(r)
  ? `<img class="${cls}" src="${esc(r.cover)}" alt="" loading="lazy" decoding="async">`
  : `<div class="${cls} art-empty">${icon('note')}</div>`;

function card(r, badge = '') {
  return `<div class="card">
    <div class="card-cover"><a class="card-art" href="#/album/${r.id}">${art(r)}</a>
    <button class="card-play" data-play-album="${r.id}" aria-label="Play">${icon('play')}</button>
    <button class="card-more" data-more-album="${r.id}" aria-label="More">${icon('more')}</button></div>
    <a class="card-title" href="#/album/${r.id}">${esc(r.title)}</a>
    <a class="card-sub" href="#/artist/${enc(r.artists[0] || '')}">${esc(r.artist)}</a>
    ${badge ? `<span class="card-badge">${esc(badge)}</span>` : ''}
  </div>`;
}

// Render long collections in chunks as the user scrolls.
function mountChunks(container, items, renderItem, chunk = 96) {
  let i = 0;
  const sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  const more = () => {
    container.insertAdjacentHTML('beforeend', items.slice(i, i + chunk).map((x) => renderItem(x)).join(''));
    i += chunk;
    if (i >= items.length) io.disconnect(), sentinel.remove();
    else container.after(sentinel);
  };
  const io = new IntersectionObserver((e) => e[0].isIntersecting && more(), { root: $('#main'), rootMargin: '1200px' });
  more();
  if (i < items.length) io.observe(sentinel);
}

function header(title, { kicker = '', sub = '', actions = true, extra = '' } = {}) {
  return `<header class="view-head">
    ${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ''}
    <div class="view-head-row">
      <h1>${esc(title)}</h1>
      ${actions ? `<div class="head-actions">
        <button class="btn btn-primary" data-action="play-view">${icon('play')}Play</button>
        <button class="btn" data-action="shuffle-view">${icon('shuffle')}Shuffle</button>
      </div>` : ''}
    </div>
    ${sub ? `<p class="view-sub">${sub}</p>` : ''}
    ${extra}
  </header>`;
}

let viewReleases = [];

const SORTS = {
  added: ['Recently Added', (a, b) => (b.added || '').localeCompare(a.added || '')],
  artist: ['Artist', (a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0)],
  title: ['Title', (a, b) => a.title.localeCompare(b.title)],
  year: ['Year', (a, b) => (a.year || 9999) - (b.year || 9999) || a.artist.localeCompare(b.artist)],
  label: ['Label', (a, b) => a.label.localeCompare(b.label) || a.catno.localeCompare(b.catno, undefined, { numeric: true })],
  want: ['Most Wanted', (a, b) => (b.want || 0) - (a.want || 0)],
  have: ['Rarest', (a, b) => (a.have || 1e9) - (b.have || 1e9)],
  ratio: ['Want / Have', (a, b) => b.ratioScore - a.ratioScore],
  price: ['Price', (a, b) => (b.lowest_price || 0) - (a.lowest_price || 0)],
  rating: ['Community Rating', (a, b) => b.score - a.score],
};
const FILTERS = [
  ['genre', 'Genre', (r) => r.genres],
  ['style', 'Style', (r) => r.styles],
  ['decade', 'Decade', (r) => (r.decade ? [r.decade] : [])],
  ['format', 'Format', (r) => r.formats],
  ['country', 'Country', (r) => (r.country ? [r.country] : [])],
  ['mygenre', 'My Genre', (r) => (r.myGenre ? [r.myGenre] : [])],
  ['tag', 'Tag', (r) => (r.notes.Tag ? [r.notes.Tag] : [])],
  ['condition', 'Condition', (r) => (r.notes['Media Condition'] ? [r.notes['Media Condition']] : [])],
];

function applyFilters(releases, q) {
  return releases.filter((r) => FILTERS.every(([k, , get]) => !q.get(k) || get(r).includes(q.get(k))));
}

function toolbar(base, q, defaultSort, skip = []) {
  const filtered = applyFilters(base, q);
  const selects = FILTERS.filter(([k]) => !skip.includes(k)).map(([k, label, get]) => {
    const pool = applyFilters(base, new URLSearchParams([...q].filter(([x]) => x !== k)));
    const counts = new Map();
    for (const r of pool) for (const v of get(r)) counts.set(v, (counts.get(v) || 0) + 1);
    const opts = [...counts].sort((a, b) => (k === 'decade' ? a[0].localeCompare(b[0]) : b[1] - a[1]));
    const val = q.get(k) || '';
    if (!opts.length) return '';
    return `<label class="pill-select ${val ? 'on' : ''}"><span>${val ? esc(val) : label}</span>${icon('chevron-down')}
      <select data-filter="${k}"><option value="">All ${label === 'Country' ? 'Countries' : label === 'Condition' ? 'Conditions' : `${label}s`}</option>
      ${opts.map(([v, n]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(v)} (${n})</option>`).join('')}</select></label>`;
  }).join('');
  const sort = q.get('sort') || defaultSort;
  const active = FILTERS.some(([k]) => q.get(k));
  return {
    filtered,
    html: `<div class="toolbar">
      ${selects}
      ${active ? `<button class="link-btn" data-action="clear-filters">Clear</button>` : ''}
      <span class="toolbar-spacer"></span>
      <span class="toolbar-count">${plural(filtered.length, 'album')}</span>
      <label class="pill-select sort">${icon('sort')}<span>${sort ? SORTS[sort][0] : 'Featured'}</span>
        <select data-filter="sort">${defaultSort ? '' : '<option value="">Featured</option>'}${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>`,
    sort,
  };
}

function browseView(title, base, r, { sort: defaultSort }) {
  const tb = toolbar(base, r.q, defaultSort);
  viewReleases = tb.filtered.slice().sort(SORTS[tb.sort][1]);
  $('#main').innerHTML = `${header(title, { extra: tb.html })}<div class="grid" id="grid"></div>`;
  mountChunks($('#grid'), viewReleases, card);
}

function collectionView(name, kind, releases, r, round = false, defaultSort = 'year') {
  if (!releases) return emptyView(`${kind} not found`);
  const skip = { Genre: ['genre'], Style: ['style'], Decade: ['decade'], 'My Genre': ['mygenre'] }[kind] || [];
  const tb = toolbar(releases, r.q, defaultSort, skip);
  viewReleases = tb.filtered.slice().sort(SORTS[tb.sort][1]);
  const lead = releases.find(hasCover);
  const related = kind === 'Genre' ? topCounts(releases, (x) => x.styles, 18).map(([s, n]) => `<a class="chip" href="#/style/${enc(s)}">${esc(s)} <span>${n}</span></a>`).join('') : '';
  const hero = kind === 'Artist' || kind === 'Label'
    ? `<div class="entity-hero">${lead ? art(lead, `entity-art ${round ? 'round' : ''}`) : `<div class="entity-art art-empty ${round ? 'round' : ''}">${icon('note')}</div>`}<div>`
    : '<div>';
  const labelsOf = kind === 'Artist' ? topCounts(releases, (x) => x.labels.map((l) => l.name), 6) : [];
  const artistsOf = kind === 'Label' ? topCounts(releases, (x) => x.artists, 8) : [];
  const sub = [
    plural(releases.length, 'album'),
    yearsSpan(releases),
    ...labelsOf.map(([l]) => `<a href="#/label/${enc(l)}">${esc(l)}</a>`),
    ...artistsOf.map(([a]) => `<a href="#/artist/${enc(a)}">${esc(a)}</a>`),
  ].filter(Boolean).join(' · ');
  $('#main').innerHTML = `${hero}${header(name, { kicker: kind, sub, extra: (related ? `<div class="chips">${related}</div>` : '') + tb.html })}</div>${hero === '<div>' ? '' : '</div>'}<div class="grid" id="grid"></div>`;
  mountChunks($('#grid'), viewReleases, card);
}

function clusterView(id, r) {
  const c = lib.clusters.find((x) => x.id === id);
  const releases = lib.clusterMembers.get(id);
  if (!c || !releases) return emptyView('Cluster not found');
  const tb = toolbar(releases, r.q, 'artist');
  viewReleases = tb.filtered.slice().sort(SORTS[tb.sort][1]);
  const pct = (items) => items.map(([k, v]) => `${esc(k)} ${Math.round(v * 100)}%`).join(', ');
  const sub = [
    plural(releases.length, 'album'),
    c.styles.length && pct(c.styles.slice(0, 3)),
    c.decades.length && `mostly ${pct(c.decades.slice(0, 1))}`,
    c.own.length && `your tags: ${pct(c.own)}`,
    `<a href="#/map?cluster=${id}">Show on map</a>`,
  ].filter(Boolean).join(' · ');
  $('#main').innerHTML = `${header(c.name, { kicker: 'Cluster', sub, extra: tb.html })}<div class="grid" id="grid"></div>`;
  mountChunks($('#grid'), viewReleases, card);
}

function yearsSpan(releases) {
  const ys = releases.map((r) => r.year).filter(Boolean);
  if (!ys.length) return '';
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

function topCounts(releases, get, n) {
  const m = new Map();
  for (const r of releases) for (const v of get(r)) m.set(v, (m.get(v) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function indexView(title, map, kind, round) {
  viewReleases = [];
  const entries = [...map].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  $('#main').innerHTML = `${header(title, { actions: false, sub: plural(entries.length, kind) })}
    <label class="filter-field">${icon('search')}<input id="index-filter" type="search" placeholder="Filter ${title.toLowerCase()}"></label>
    <div class="index-list" id="index"></div>`;
  const row = ([name, rs]) => {
    const lead = rs.find(hasCover) || rs[0];
    return `<a class="index-row" href="#/${kind}/${enc(name)}">${art(lead, `index-art ${round ? 'round' : ''}`)}<span class="index-name">${esc(name)}</span><span class="index-count">${rs.length}</span>${icon('chevron-right')}</a>`;
  };
  const draw = (list) => { $('#index').innerHTML = ''; mountChunks($('#index'), list, row, 150); };
  draw(entries);
  $('#index-filter').addEventListener('input', (e) => {
    const n = norm(e.target.value);
    draw(n ? entries.filter(([name]) => norm(name).includes(n)) : entries);
  });
}

const TILE_COLORS = ['#fa2d48', '#ff9f0a', '#30b0c7', '#5e5ce6', '#34c759', '#ff375f', '#64d2ff', '#bf5af2', '#ac8e68', '#0a84ff', '#ff6482', '#32ade6'];
const tint = (s) => TILE_COLORS[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE_COLORS.length];

function tilesView(title, map, kind, sorter = (a, b) => b[1].length - a[1].length) {
  viewReleases = [];
  const entries = [...map].sort(sorter);
  $('#main').innerHTML = `${header(title, { actions: false, sub: plural(entries.length, kind) })}
    ${entries.length > 30 ? `<label class="filter-field">${icon('search')}<input id="tile-filter" type="search" placeholder="Filter ${title.toLowerCase()}"></label>` : ''}
    <div class="tiles" id="tiles"></div>`;
  const tile = ([name, rs]) => {
    const covers = rs.filter(hasCover).slice(0, 3);
    return `<a class="tile" href="#/${kind}/${enc(name)}" style="--tint:${tint(name)}">
      <span class="tile-name">${esc(name)}</span><span class="tile-count">${plural(rs.length, 'album')}</span>
      <span class="tile-covers">${covers.map((r) => `<img src="${esc(r.thumb || r.cover)}" alt="" loading="lazy">`).join('')}</span>
    </a>`;
  };
  const draw = (list) => { $('#tiles').innerHTML = ''; mountChunks($('#tiles'), list, tile, 60); };
  draw(entries);
  $('#tile-filter')?.addEventListener('input', (e) => {
    const n = norm(e.target.value);
    draw(n ? entries.filter(([name]) => norm(name).includes(n)) : entries);
  });
}

function libraryView() {
  viewReleases = [];
  $('#main').innerHTML = `${header('Library', { actions: false })}
    <nav class="library-links">${NAV.map(([id, label, ic]) => `<a href="#/${id}">${icon(ic)}<span>${label}</span>${icon('chevron-right')}</a>`).join('')}</nav>
    <h2 class="section-title">Recently Added</h2>
    <div class="grid">${lib.releases.slice().sort(SORTS.added[1]).slice(0, 12).map((r) => card(r)).join('')}</div>
    <p class="foot-note">${plural(lib.releases.length, 'record')} · <button class="link-btn" data-action="lock">Lock</button></p>`;
}

function emptyView(msg) {
  viewReleases = [];
  $('#main').innerHTML = `<div class="empty">${icon('note')}<p>${esc(msg)}</p></div>`;
}

/* ---------- track lists ---------- */

function registerList(items) {
  const id = `L${++listSeq}`;
  lists.set(id, items);
  return id;
}

function trackRows(items, { list, numbered = true, covers = false, playlistId = null } = {}) {
  const id = list || registerList(items);
  return items.map((t, i) => {
    const apple = t.yt ? undefined : appleCached(t);
    const state = t.yt ? '' : apple === null ? 'unavailable' : 'preview';
    return `<div class="row ${state}" data-list="${id}" data-index="${i}" data-rid="${t.rid}" data-key="${t.key}" ${playlistId ? 'draggable="true"' : ''}>
      <span class="row-lead">${covers
        ? `<img src="${esc(t.thumb || t.cover)}" alt="" loading="lazy">`
        : `<span class="row-num">${esc(numbered ? t.pos || i + 1 : '')}</span>`}
        <span class="row-eq"><i></i><i></i><i></i></span><span class="row-playicon">${icon('play')}</span></span>
      <span class="row-main"><span class="row-title">${esc(t.title)}</span>${covers ? `<span class="row-sub">${esc(t.artist)} — <a href="#/album/${t.rid}">${esc(t.album)}</a></span>` : t.artistDiffers ? `<span class="row-sub">${esc(t.artist)}</span>` : ''}</span>
      ${state === 'preview' ? '<span class="badge">Preview</span>' : state === 'unavailable' ? '<span class="badge muted">No audio</span>' : ''}
      <span class="row-dur">${esc(t.dur || '')}</span>
      <button class="icon-btn row-more" data-more-track ${playlistId ? `data-playlist="${playlistId}"` : ''} aria-label="More">${icon('more')}</button>
    </div>`;
  }).join('');
}

function markCurrent() {
  const cur = player?.current;
  document.querySelectorAll('.row').forEach((el) => {
    const on = cur && Number(el.dataset.rid) === cur.rid && el.dataset.key === cur.key;
    el.classList.toggle('current', !!on);
    el.classList.toggle('paused', !!on && !player.playing);
  });
}

/* ---------- album ---------- */

function albumView(r) {
  if (!r) return emptyView('Album not found');
  viewReleases = [r];
  const { tracks, extras } = lib.items(r);
  tracks.forEach((t) => { t.artistDiffers = t.artist !== r.artist; });
  const fmt = [...r.formats, ...r.descriptions.filter((d) => !/^(LP|Album)$/.test(d))].join(', ');
  const meta = [r.genres[0], r.year, fmt].filter(Boolean).map(esc).join(' · ');
  const byArtist = (lib.artists.get(r.artists[0]) || []).filter((x) => x.id !== r.id).slice(0, 12);
  const byLabel = (lib.labels.get(r.label) || []).filter((x) => x.id !== r.id && !byArtist.includes(x)).slice(0, 12);
  const added = r.added ? new Date(r.added).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  $('#main').innerHTML = `
    <section class="album-hero">
      ${art(r, 'album-art')}
      <div class="album-info">
        <h1>${esc(r.title)}</h1>
        <p class="album-artist">${r.artists.map((a) => `<a href="#/artist/${enc(a)}">${esc(a)}</a>`).join(', ') || 'Unknown Artist'}</p>
        <p class="album-meta">${meta}</p>
        <div class="head-actions">
          <button class="btn btn-primary" data-action="play-view">${icon('play')}Play</button>
          <button class="btn" data-action="shuffle-view">${icon('shuffle')}Shuffle</button>
          <button class="icon-btn round" data-more-album="${r.id}" aria-label="More">${icon('more')}</button>
        </div>
        <div class="chips">${r.styles.map((s) => `<a class="chip" href="#/style/${enc(s)}">${esc(s)}</a>`).join('')}${r.myGenre ? `<a class="chip mine" href="#/mygenre/${enc(r.myGenre)}">${esc(r.myGenre)}</a>` : ''}</div>
        ${r.notes.Notes ? `<p class="album-note">${esc(r.notes.Notes)}</p>` : ''}
      </div>
    </section>
    <div class="tracks">${tracks.length ? trackRows(tracks) : ''}</div>
    ${extras.length ? `<h2 class="section-title">${tracks.length ? 'Other Videos' : 'Videos'}</h2><div class="tracks">${trackRows(extras, { numbered: false })}</div>` : ''}
    ${!tracks.length && !extras.length ? `<p class="foot-note">${r.stats_at ? 'No tracklist on Discogs for this release.' : 'Tracks for this record load with the next library build.'}</p>` : ''}
    ${statsStrip(r)}
    <dl class="album-facts">
      ${r.labels.map((l) => `<div><dt>Label</dt><dd><a href="#/label/${enc(l.name)}">${esc(l.name)}</a> — ${esc(l.catno)}</dd></div>`).join('')}
      ${r.country ? `<div><dt>Country</dt><dd>${esc(r.country)}</dd></div>` : ''}
      ${r.released ? `<div><dt>Released</dt><dd>${esc(r.released)}</dd></div>` : ''}
      ${r.genres.length ? `<div><dt>Genre</dt><dd>${r.genres.map((g) => `<a href="#/genre/${enc(g)}">${esc(g)}</a>`).join(', ')}</dd></div>` : ''}
      ${added ? `<div><dt>Added</dt><dd>${added}${r.copies > 1 ? ` · ${r.copies} copies` : ''}</dd></div>` : ''}
      ${['Media Condition', 'Sleeve Condition', 'Tag'].filter((k) => r.notes[k]).map((k) => `<div><dt>${k.replace(' Condition', '')}</dt><dd>${esc(r.notes[k])}</dd></div>`).join('')}
      <div><dt>Discogs</dt><dd><a href="https://www.discogs.com/release/${r.id}" target="_blank" rel="noopener">View release ↗</a> · <a href="https://www.discogs.com/sell/release/${r.id}" target="_blank" rel="noopener">Marketplace ↗</a></dd></div>
    </dl>
    ${shelf('Similar in Your Collection', (r.similar || []).map((id) => lib.byId.get(id)).filter(Boolean), `#/map?focus=${r.id}`)}
    ${shelf(`More by ${r.artists[0] || ''}`, byArtist, `#/artist/${enc(r.artists[0] || '')}`)}
    ${shelf(`More on ${r.label}`, byLabel, `#/label/${enc(r.label)}`)}`;
}

function shelf(title, releases, href, { sub = '', badge = null } = {}) {
  if (!releases.length) return '';
  return `<section class="shelf"><h2 class="section-title"><a href="${href}">${esc(title)} ${icon('chevron-right')}</a></h2>
    ${sub ? `<p class="shelf-sub">${esc(sub)}</p>` : ''}
    <div class="shelf-row">${releases.map((r) => card(r, badge ? badge(r) : '')).join('')}</div></section>`;
}

function statsStrip(r) {
  if (r.have === undefined) return '';
  const cells = [
    [r.have.toLocaleString(), 'Have'],
    [r.want.toLocaleString(), 'Want'],
    [r.have ? r.ratio.toFixed(2) : '–', 'Want / Have'],
    [r.votes ? `${r.community_rating.toFixed(2)}` : '–', r.votes ? `Rating · ${r.votes} votes` : 'Rating'],
    [r.lowest_price ? euro(r.lowest_price) : '–', r.for_sale ? `Lowest of ${r.for_sale} for sale` : 'None for sale'],
  ];
  return `<div class="stats">${cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
    ${r.stats_at ? `<p class="stats-note">Marketplace data from ${new Date(r.stats_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>` : ''}`;
}

/* ---------- discover ---------- */

function seeded(seedText) {
  let a = [...seedText].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDaily(list, n, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return n ? a.slice(0, n) : a;
}

const want = (r) => `${r.want.toLocaleString()} want · ${r.have.toLocaleString()} have`;

// Every shelf keeps its full list so "See All" can show everything.
function shelves() {
  const today = new Date();
  const rand = seeded(today.toDateString());
  const rs = lib.releases;
  const stats = rs.filter((r) => r.have !== undefined);
  const byAdded = rs.slice().sort(SORTS.added[1]);
  const md = (d) => d.slice(5, 10);
  const todayMd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const sixMonths = new Date(today - 182 * 864e5).toISOString();
  const out = [];
  const add = (key, title, list, opts = {}) => list.length && out.push({ key, title, list, ...opts });

  add('rediscover', 'Rediscover', pickDaily(rs.filter((r) => r.added && r.added < sixMonths), 0, rand), {
    sub: 'Records you haven’t added in a while — reshuffled every day.',
    badge: (r) => `Added ${new Date(r.added).getFullYear()}`,
  });
  add('onthisday', 'On This Day', rs.filter((r) => r.added && md(r.added) === todayMd && r.added.slice(0, 4) < String(today.getFullYear())).sort(SORTS.added[1]), {
    sub: 'Added on this date in previous years.',
    badge: (r) => `${today.getFullYear() - Number(r.added.slice(0, 4))} years ago`,
  });
  add('recent', 'Recently Added', byAdded);
  add('ratio', 'Best Want / Have Ratio', stats.filter((r) => r.want >= 20 && r.want > r.have).sort(SORTS.ratio[1]), {
    sub: 'Far more people want these than own them. Weighted so a handful of wants doesn’t outrank hundreds.',
    badge: (r) => `${want(r)} · ${r.ratio.toFixed(1)}×`,
  });
  add('valuable', 'Most Valuable', stats.filter((r) => r.lowest_price).sort(SORTS.price[1]), {
    sub: 'Ranked by the cheapest copy currently on the Discogs marketplace.',
    badge: (r) => `from ${euro(r.lowest_price)} · ${r.for_sale} for sale`,
  });
  add('notforsale', 'Nobody’s Selling', stats.filter((r) => !r.for_sale && r.want >= 10).sort(SORTS.want[1]), {
    sub: 'Wanted, but no copy on the marketplace right now.', badge: (r) => `${r.want} want · 0 for sale`,
  });
  add('rarest', 'Rarest', stats.filter((r) => r.have > 0).sort(SORTS.have[1]), {
    sub: 'Fewest Discogs users own these.', badge: (r) => `${r.have} have`,
  });
  add('wanted', 'Most Wanted', stats.slice().sort(SORTS.want[1]), { badge: want });
  const labels = [...lib.labels].filter(([n, l]) => l.length >= 6 && !/^not on label/i.test(n));
  if (labels.length) {
    const [name, list] = labels[Math.floor(rand() * labels.length)];
    add('label', `Label Spotlight: ${name}`, pickDaily(list, 0, rand), { href: `#/label/${enc(name)}`, sub: `${list.length} records on ${name} in your collection · changes daily.` });
  }
  const styles = [...lib.styles].filter(([, l]) => l.length >= 8);
  if (styles.length) {
    const [name, list] = styles[Math.floor(rand() * styles.length)];
    add('style', `Style of the Day: ${name}`, pickDaily(list, 0, rand), { href: `#/style/${enc(name)}`, sub: `${list.length} ${name} records · changes daily.` });
  }
  add('notes', 'From Your Notes', pickDaily(rs.filter((r) => r.notes.Notes), 0, rand), {
    sub: 'Records you wrote something about.', badge: (r) => r.notes.Notes.split('\n')[0].slice(0, 60),
  });
  add('toprated', 'Community Favourites', stats.filter((r) => r.votes >= 3).sort(SORTS.rating[1]), {
    sub: 'Highest rated on Discogs, weighted by number of votes: 4.8★ from 40 votes beats 5★ from 2.',
    badge: (r) => `★ ${r.community_rating.toFixed(2)} · ${r.votes} votes`,
  });
  const mine = [...lib.myGenres];
  if (mine.length) {
    const [name, list] = mine[Math.floor(rand() * mine.length)];
    add('mygenre', `Your ${name} Crate`, pickDaily(list, 0, rand), { href: `#/mygenre/${enc(name)}`, sub: 'From the genre tags in your Discogs notes · a different tag every day.' });
  }
  return out;
}

function discoverView() {
  viewReleases = [];
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Late Night Digging' : hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
  const all = shelves();
  const [first, ...rest] = all;
  $('#main').innerHTML = `${header('Listen Now', { actions: false, kicker: hello })}
    ${first ? `<section class="hero-shelf">${first.list.slice(0, 5).map((r, i) => `<a class="feature ${i ? '' : 'big'}" href="#/album/${r.id}">${art(r)}<span class="feature-text"><small>${i ? '' : esc(first.title)}</small><b>${esc(r.title)}</b><span>${esc(r.artist)}</span></span><button class="card-play" data-play-album="${r.id}" aria-label="Play">${icon('play')}</button></a>`).join('')}</section>
      <div class="hero-actions"><button class="btn btn-primary" data-action="shuffle-rediscover">${icon('shuffle')}Shuffle Rediscover</button><a class="btn" href="#/list/rediscover">See All</a></div>` : ''}
    ${rest.map((sh) => shelf(sh.title, sh.list.slice(0, 16), sh.href || `#/list/${sh.key}`, sh)).join('')}`;
}

function shelfListView(key, r) {
  const sh = shelves().find((x) => x.key === key);
  if (!sh) return emptyView('Nothing here today');
  const tb = toolbar(sh.list, r.q, null);
  const keepOrder = !r.q.get('sort');
  viewReleases = keepOrder ? tb.filtered : tb.filtered.slice().sort(SORTS[tb.sort][1]);
  $('#main').innerHTML = `${header(sh.title, { sub: sh.sub ? esc(sh.sub) : '', extra: tb.html })}<div class="grid" id="grid"></div>`;
  mountChunks($('#grid'), viewReleases, (x) => card(x, sh.badge ? sh.badge(x) : ''));
}

/* ---------- collection map ---------- */

function mapView(r) {
  viewReleases = [];
  const main = $('#main');
  main.classList.add('full-bleed');
  if (!lib.releases.some((x) => x.xy)) return emptyView('The collection map is computed on the next library build.');
  main.innerHTML = `<div class="map-wrap" id="map"></div>`;
  activeMap = new CollectionMap($('#map'), lib, {
    colorBy: r.q.get('color') || 'cluster',
    focus: Number(r.q.get('focus')) || null,
    cluster: r.q.has('cluster') ? Number(r.q.get('cluster')) : null,
    icon,
    onPlay: (ids, shuffle = false) => playReleases(ids.map((id) => lib.byId.get(id)), shuffle),
    onOpen: (id) => go(`#/album/${id}`),
    onOpenCluster: (id) => go(`#/cluster/${id}`),
    onColor: (c) => history.replaceState(null, '', `#/map?color=${c}`),
  });
}

/* ---------- playlists ---------- */

function playlistItems(p) {
  return p.items.map(({ rid, key }) => lib.item(rid, key)).filter(Boolean);
}

function mosaic(items, cls) {
  const covers = [...new Map(items.filter((t) => t.cover && !t.cover.includes('spacer.gif')).map((t) => [t.rid, t.cover])).values()].slice(0, 4);
  if (!covers.length) return `<div class="${cls} art-empty">${icon('playlist')}</div>`;
  if (covers.length < 4) return `<img class="${cls}" src="${esc(covers[0])}" alt="">`;
  return `<div class="${cls} mosaic">${covers.map((c) => `<img src="${esc(c)}" alt="" loading="lazy">`).join('')}</div>`;
}

function playlistsView() {
  viewReleases = [];
  $('#main').innerHTML = `${header('Playlists', { actions: false, sub: playlists.token ? 'Synced across your devices with a private GitHub Gist.' : 'Saved on this device.' })}
    <div class="grid">
      <button class="card card-new" data-action="new-playlist"><span class="card-art art-empty">${icon('plus')}</span><span class="card-title">New Playlist</span></button>
      ${playlists.all.map((p) => {
        const items = playlistItems(p);
        return `<div class="card"><div class="card-cover"><a class="card-art" href="#/playlist/${p.id}">${mosaic(items, '')}</a>
          <button class="card-play" data-play-playlist="${p.id}" aria-label="Play">${icon('play')}</button></div>
          <a class="card-title" href="#/playlist/${p.id}">${esc(p.name)}</a><span class="card-sub">${plural(items.length, 'song')}</span></div>`;
      }).join('')}
    </div>`;
}

function playlistView(p) {
  if (!p) return emptyView('Playlist not found');
  viewReleases = [];
  const items = playlistItems(p);
  const list = registerList(items);
  $('#main').innerHTML = `
    <section class="album-hero">
      ${mosaic(items, 'album-art')}
      <div class="album-info">
        <p class="kicker">Playlist</p>
        <h1>${esc(p.name)}</h1>
        <p class="album-meta">${plural(items.length, 'song')}</p>
        <div class="head-actions">
          <button class="btn btn-primary" data-play-playlist="${p.id}" ${items.length ? '' : 'disabled'}>${icon('play')}Play</button>
          <button class="btn" data-play-playlist="${p.id}" data-shuffle ${items.length ? '' : 'disabled'}>${icon('shuffle')}Shuffle</button>
          <button class="icon-btn round" data-more-playlist="${p.id}" aria-label="More">${icon('more')}</button>
        </div>
      </div>
    </section>
    <div class="tracks" data-sortable="${p.id}">${items.length ? trackRows(items, { list, covers: true, playlistId: p.id }) : '<p class="foot-note">Add songs from any album with the ••• button.</p>'}</div>`;
}

/* ---------- search ---------- */

function searchView(q) {
  viewReleases = [];
  const field = isMobile() ? `<label class="filter-field big">${icon('search')}<input id="search-mobile" type="search" placeholder="Artists, albums, labels, songs" value="${esc(q)}" autocomplete="off"></label>` : '';
  const res = lib.search(q);
  if (!res) {
    $('#main').innerHTML = `${header('Search', { actions: false })}${field}
      <h2 class="section-title">Browse Genres</h2>
      <div class="tiles">${[...lib.genres].sort((a, b) => b[1].length - a[1].length).map(([g, rs]) => `<a class="tile" href="#/genre/${enc(g)}" style="--tint:${tint(g)}"><span class="tile-name">${esc(g)}</span><span class="tile-count">${plural(rs.length, 'album')}</span></a>`).join('')}</div>`;
    bindMobileSearch();
    return;
  }
  viewReleases = res.albums;
  const entityRow = (title, names, kind, map, round) => names.length ? `<h2 class="section-title">${title}</h2><div class="entity-row">${names.map((n) => {
    const lead = map.get(n).find(hasCover) || map.get(n)[0];
    return `<a class="entity" href="#/${kind}/${enc(n)}">${art(lead, `entity-thumb ${round ? 'round' : ''}`)}<span>${esc(n)}</span><small>${plural(map.get(n).length, 'album')}</small></a>`;
  }).join('')}</div>` : '';
  const total = res.albumCount + res.artists.length + res.labels.length + res.tracks.length;
  $('#main').innerHTML = `${header(`Results for “${q}”`, { actions: false })}${field}
    ${total ? '' : '<div class="empty"><p>No results.</p></div>'}
    ${entityRow('Artists', res.artists, 'artist', lib.artists, true)}
    ${res.albums.length ? `<h2 class="section-title">Albums <span class="count">${res.albumCount}</span></h2><div class="grid">${res.albums.map((r) => card(r)).join('')}</div>` : ''}
    ${res.tracks.length ? `<h2 class="section-title">Songs</h2><div class="tracks">${trackRows(res.tracks, { covers: true })}</div>` : ''}
    ${entityRow('Labels', res.labels, 'label', lib.labels, false)}
    ${res.styles.length ? `<h2 class="section-title">Styles</h2><div class="chips">${res.styles.map((s) => `<a class="chip" href="#/style/${enc(s)}">${esc(s)} <span>${lib.styles.get(s).length}</span></a>`).join('')}</div>` : ''}`;
  bindMobileSearch();
}

function bindMobileSearch() {
  const input = $('#search-mobile');
  if (!input) return;
  if (!input.value) input.focus();
  input.addEventListener('input', debounce(() => history.replaceState(null, '', `#/search?q=${enc(input.value)}`) || searchKeepFocus(input.value), 180));
}

function searchKeepFocus(q) {
  render();
  const input = $('#search-mobile');
  if (input) { input.focus(); input.setSelectionRange(q.length, q.length); }
}

/* ---------- playing things ---------- */

function releaseQueue(releases, { shuffle = false, cap = 600 } = {}) {
  const pool = shuffle ? releases.slice().sort(() => Math.random() - 0.5) : releases;
  const out = [];
  for (const r of pool) {
    const items = lib.playable(r);
    out.push(...(shuffle ? items.filter((t) => t.yt) : items));
    if (out.length >= cap) break;
  }
  return out;
}

function playReleases(releases, shuffle) {
  const q = releaseQueue(releases, { shuffle });
  if (!q.length) return toast('Nothing playable here');
  player.play(q, 0, { shuffle });
}

/* ---------- player UI ---------- */

function renderPlayer() {
  const t = player.current;
  const src = !t ? '' : player.source === 'apple' ? 'Apple Music Preview' : player.source === 'yt' ? 'YouTube' : '';
  const playBtn = `<button class="ctl ctl-play" data-action="toggle" aria-label="${player.playing ? 'Pause' : 'Play'}">${icon(player.playing ? 'pause' : 'play')}</button>`;
  $('#playerbar').innerHTML = `
    <div class="pb-controls">
      <button class="ctl small ${player.shuffle ? 'on' : ''}" data-action="shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="ctl" data-action="prev" aria-label="Previous">${icon('prev')}</button>
      ${playBtn}
      <button class="ctl" data-action="next" aria-label="Next">${icon('next')}</button>
      <button class="ctl small ${player.repeat !== 'off' ? 'on' : ''}" data-action="repeat" aria-label="Repeat">${icon(player.repeat === 'one' ? 'repeat1' : 'repeat')}</button>
    </div>
    <div class="lcd ${t ? '' : 'idle'}">
      ${t ? `<a class="lcd-art" href="#/album/${t.rid}">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : icon('note')}</a>
        <div class="lcd-text">
          <span class="lcd-title">${esc(t.title)}${player.loading ? ' <span class="spinner"></span>' : ''}</span>
          <span class="lcd-sub"><a href="#/artist/${enc(t.artist.split(', ')[0])}">${esc(t.artist)}</a> — <a href="#/album/${t.rid}">${esc(t.album)}</a></span>
        </div>
        <span class="lcd-src">${src}</span>
        <div class="lcd-progress"><span class="t-cur"></span><input type="range" class="scrub" min="0" max="1000" value="0" aria-label="Seek"><span class="t-dur"></span></div>`
      : `<span class="lcd-logo">${icon('note')}</span>`}
    </div>
    <div class="pb-right">
      ${icon('volume')}<input type="range" class="volume" min="0" max="100" value="${Math.round(player.volume * 100)}" aria-label="Volume">
      <button class="ctl small ${$('#queue').hidden ? '' : 'on'}" data-action="queue" aria-label="Queue">${icon('queue')}</button>
    </div>
    <div class="mini" ${t ? '' : 'hidden'}>
      ${t ? `<button class="mini-open" data-action="sheet">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : `<span class="art-empty">${icon('note')}</span>`}<span class="mini-text"><span>${esc(t.title)}</span><small>${esc(t.artist)}</small></span></button>
        ${playBtn}<button class="ctl" data-action="next" aria-label="Next">${icon('next')}</button>
        <div class="mini-progress"><i></i></div>` : ''}
    </div>`;
  updateProgress();
}

let scrubbing = false;
function updateProgress() {
  if (scrubbing) return;
  const cur = player.time, dur = player.duration;
  const frac = dur ? cur / dur : 0;
  document.querySelectorAll('.scrub').forEach((s) => { s.value = Math.round(frac * 1000); s.style.setProperty('--p', `${frac * 100}%`); });
  document.querySelectorAll('.t-cur').forEach((s) => { s.textContent = fmtTime(cur) || '0:00'; });
  document.querySelectorAll('.t-dur').forEach((s) => { s.textContent = dur ? `-${fmtTime(dur - cur) || '0:00'}` : ''; });
  document.querySelectorAll('.mini-progress i').forEach((s) => { s.style.width = `${frac * 100}%`; });
}

function renderQueue() {
  const q = $('#queue');
  if (q.hidden) return;
  const t = player.current;
  const next = player.upNext;
  q.innerHTML = `<header><h2>Playing Next</h2><button class="icon-btn" data-action="queue" aria-label="Close">${icon('close')}</button></header>
    ${t ? `<div class="queue-now">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ''}<div><span>${esc(t.title)}</span><small>${esc(t.artist)}</small></div></div>` : '<p class="foot-note">Nothing playing.</p>'}
    <div class="queue-list">${next.slice(0, 200).map((x, i) => `<button class="queue-row" data-jump="${i}">${x.thumb || x.cover ? `<img src="${esc(x.thumb || x.cover)}" alt="" loading="lazy">` : ''}<span><span>${esc(x.title)}</span><small>${esc(x.artist)}</small></span></button>`).join('')}</div>
    ${next.length > 200 ? `<p class="foot-note">+ ${next.length - 200} more</p>` : ''}`;
}

function renderSheet() {
  const sheet = $('#sheet');
  if (sheet.hidden) return;
  const t = player.current;
  if (!t) { sheet.hidden = true; return; }
  sheet.innerHTML = `<div class="sheet-inner">
    <button class="sheet-grabber" data-action="close-sheet" aria-label="Close"></button>
    <a class="sheet-art" href="#/album/${t.rid}" data-action="close-sheet">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : icon('note')}</a>
    <div class="sheet-meta"><div><h2>${esc(t.title)}</h2><p>${esc(t.artist)} — ${esc(t.album)}</p></div>
      <button class="icon-btn round" data-more-current aria-label="More">${icon('more')}</button></div>
    <div class="lcd-progress big"><input type="range" class="scrub" min="0" max="1000" value="0" aria-label="Seek"><div class="times"><span class="t-cur"></span><span class="sheet-src">${player.source === 'apple' ? 'Preview' : ''}</span><span class="t-dur"></span></div></div>
    <div class="sheet-controls">
      <button class="ctl small ${player.shuffle ? 'on' : ''}" data-action="shuffle">${icon('shuffle')}</button>
      <button class="ctl big" data-action="prev">${icon('prev')}</button>
      <button class="ctl big" data-action="toggle">${icon(player.playing ? 'pause' : 'play')}</button>
      <button class="ctl big" data-action="next">${icon('next')}</button>
      <button class="ctl small ${player.repeat !== 'off' ? 'on' : ''}" data-action="repeat">${icon(player.repeat === 'one' ? 'repeat1' : 'repeat')}</button>
    </div>
    <div class="sheet-queue"><h3>Playing Next</h3>${player.upNext.slice(0, 30).map((x, i) => `<button class="queue-row" data-jump="${i}">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy">` : ''}<span><span>${esc(x.title)}</span><small>${esc(x.artist)}</small></span></button>`).join('') || '<p class="foot-note">Nothing queued.</p>'}</div>
  </div>`;
  updateProgress();
}

/* ---------- menus & dialogs ---------- */

function openMenu(anchor, entries) {
  const menu = $('#menu');
  menu.innerHTML = `<div class="menu-panel">${entries.map((e, i) => e === '-' ? '<hr>' : e.submenu
    ? `<div class="menu-group"><p>${esc(e.label)}</p>${e.submenu.map((s, j) => `<button data-menu="${i}:${j}">${esc(s.label)}</button>`).join('')}</div>`
    : `<button data-menu="${i}" class="${e.danger ? 'danger' : ''}">${e.icon ? icon(e.icon) : ''}${esc(e.label)}</button>`).join('')}
    <button class="menu-cancel" data-menu="cancel">Cancel</button></div>`;
  menu.hidden = false;
  const panel = $('.menu-panel', menu);
  if (!isMobile()) {
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    panel.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  }
  menu.onclick = (ev) => {
    const b = ev.target.closest('[data-menu]');
    if (!b && ev.target.closest('.menu-panel')) return;
    menu.hidden = true;
    if (!b || b.dataset.menu === 'cancel') return;
    const [i, j] = b.dataset.menu.split(':').map(Number);
    (j === undefined ? entries[i] : entries[i].submenu[j]).run();
  };
}

function addToPlaylistEntry(items) {
  return {
    label: 'Add to Playlist',
    submenu: [
      { label: 'New Playlist…', run: () => newPlaylist(items) },
      ...playlists.all.map((p) => ({ label: p.name, run: () => { playlists.add(p.id, items); toast(`Added to ${p.name}`); } })),
    ],
  };
}

function itemMenu(anchor, items, extra = []) {
  openMenu(anchor, [
    { label: 'Play Next', icon: 'next', run: () => { player.playNext(items); toast('Playing next'); } },
    { label: 'Add to Queue', icon: 'queue', run: () => { player.addToQueue(items); toast('Added to queue'); } },
    '-',
    ...extra,
    addToPlaylistEntry(items),
  ]);
}

function newPlaylist(items = []) {
  const name = prompt('Playlist name', 'New Playlist');
  if (name === null) return;
  const p = playlists.create(name.trim(), items);
  if (items.length) toast(`Added to ${p.name}`);
  else go(`#/playlist/${p.id}`);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------- events ---------- */

function bindGlobal() {
  const desktopSearch = debounce((q) => {
    if (q) {
      history[route().seg[0] === 'search' ? 'replaceState' : 'pushState'](null, '', `#/search?q=${enc(q)}`);
      render();
    }
    else if (route().seg[0] === 'search') go('#/recent');
  }, 160);
  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') desktopSearch(e.target.value.trim());
    if (e.target.classList.contains('volume')) player.setVolume(e.target.value / 100);
    if (e.target.classList.contains('scrub')) {
      scrubbing = true;
      const frac = e.target.value / 1000;
      e.target.style.setProperty('--p', `${frac * 100}%`);
      document.querySelectorAll('.t-cur').forEach((s) => { s.textContent = fmtTime(frac * player.duration) || '0:00'; });
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('scrub')) { player.seek((e.target.value / 1000) * player.duration); scrubbing = false; }
    const f = e.target.dataset.filter;
    if (f) {
      const r = route();
      e.target.value ? r.q.set(f, e.target.value) : r.q.delete(f);
      go(`#/${r.seg.map(enc).join('/')}${r.q.size ? `?${r.q}` : ''}`);
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    const el = (sel) => t.closest(sel);
    let x;
    if ((x = el('[data-play-album]'))) {
      e.preventDefault();
      return playReleases([lib.byId.get(Number(x.dataset.playAlbum))], false);
    }
    if ((x = el('[data-more-album]'))) {
      e.preventDefault();
      const r = lib.byId.get(Number(x.dataset.moreAlbum));
      return itemMenu(x, lib.playable(r), [
        { label: 'Go to Artist', icon: 'mic', run: () => go(`#/artist/${enc(r.artists[0] || '')}`) },
        { label: 'View on Discogs', icon: 'link', run: () => open(`https://www.discogs.com/release/${r.id}`, '_blank', 'noopener') },
      ]);
    }
    if ((x = el('[data-more-track]'))) {
      e.stopPropagation();
      const row = x.closest('.row');
      const item = lists.get(row.dataset.list)[Number(row.dataset.index)];
      const extra = [{ label: 'Go to Album', icon: 'album', run: () => go(`#/album/${item.rid}`) }];
      if (x.dataset.playlist) extra.push({ label: 'Remove from Playlist', icon: 'close', danger: true, run: () => playlists.removeAt(x.dataset.playlist, Number(row.dataset.index)) });
      return itemMenu(x, [item], extra);
    }
    if ((x = el('[data-more-current]'))) {
      const item = player.current;
      return item && itemMenu(x, [item], [{ label: 'Go to Album', icon: 'album', run: () => { $('#sheet').hidden = true; go(`#/album/${item.rid}`); } }]);
    }
    if ((x = el('[data-more-playlist]'))) {
      const p = playlists.get(x.dataset.morePlaylist);
      return openMenu(x, [
        { label: 'Rename…', icon: 'pencil', run: () => { const n = prompt('Rename playlist', p.name); if (n) playlists.rename(p.id, n.trim()); } },
        { label: 'Delete Playlist', icon: 'close', danger: true, run: () => { if (confirm(`Delete “${p.name}”?`)) { playlists.remove(p.id); go('#/playlists'); } } },
      ]);
    }
    if ((x = el('[data-play-playlist]'))) {
      e.preventDefault();
      const items = playlistItems(playlists.get(x.dataset.playPlaylist));
      return items.length && player.play(items, 0, { shuffle: x.hasAttribute('data-shuffle') });
    }
    if ((x = el('.row')) && !el('a')) {
      const items = lists.get(x.dataset.list);
      const i = Number(x.dataset.index);
      const cur = player.current;
      if (cur && cur.rid === items[i].rid && cur.key === items[i].key) return player.toggle();
      return player.play(items, i, { shuffle: player.shuffle });
    }
    if ((x = el('[data-jump]'))) return player.jump(Number(x.dataset.jump));
    if ((x = el('[data-action]'))) {
      const a = x.dataset.action;
      const actions = {
        toggle: () => player.toggle(),
        next: () => player.next(),
        prev: () => player.prev(),
        shuffle: () => player.toggleShuffle(),
        repeat: () => player.cycleRepeat(),
        queue: () => { $('#queue').hidden = !$('#queue').hidden; renderQueue(); renderPlayer(); },
        sheet: () => { $('#sheet').hidden = false; renderSheet(); },
        'close-sheet': () => { $('#sheet').hidden = true; },
        'play-view': () => playReleases(viewReleases, false),
        'shuffle-rediscover': () => playReleases(shelves()[0].list, true),
        'shuffle-view': () => playReleases(viewReleases, true),
        'new-playlist': () => newPlaylist(),
        'clear-filters': () => { const r = route(); go(`#/${r.seg.map(enc).join('/')}${r.q.get('sort') ? `?sort=${r.q.get('sort')}` : ''}`); },
        lock: () => { forgetKey(); location.reload(); },
      };
      if (actions[a]) { e.preventDefault(); actions[a](); }
    }
  });

  // Drag to reorder playlist rows, or drop a track on a sidebar playlist.
  let drag = null;
  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row[draggable]');
    if (!row) return;
    drag = { list: row.dataset.list, index: Number(row.dataset.index), playlist: row.closest('[data-sortable]').dataset.sortable };
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!drag) return;
    const over = e.target.closest('[data-sortable] .row');
    if (over) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (!drag) return;
    const over = e.target.closest('[data-sortable] .row');
    if (over) { e.preventDefault(); playlists.move(drag.playlist, drag.index, Number(over.dataset.index)); }
  });
  document.addEventListener('dragend', () => { drag = null; document.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging')); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isMobile()) go('#/search'); else $('#search').focus(), $('#search').select();
    } else if (e.key === 'Escape') {
      $('#menu').hidden = true;
      $('#sheet').hidden = true;
      if (typing) document.activeElement.blur();
    } else if (typing) {
      return;
    } else if (e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    } else if (e.code === 'Space') {
      e.preventDefault();
      player.toggle();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowRight') {
      player.next();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowLeft') {
      player.prev();
    }
  });
}

boot();
