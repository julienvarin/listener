import { estimateValue } from './value.js';

export const euro = (v) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: v < 10 ? 2 : 0 }).format(v);

export const norm = (s = '') =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const containsPhrase = (haystack, needle) => (` ${haystack} `).includes(` ${needle} `);

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Library {
  constructor(payload) {
    this.generated = payload.generated;
    this.user = payload.user;
    this.gistToken = payload.gist_token || '';
    this.releases = payload.releases;
    this.clusters = payload.clusters || [];
    this.regions = payload.regions || [];
    this.discogsValue = payload.collection_value || {};
    this.entities = payload.entities || {};
    this.byId = new Map();
    this.itemCache = new Map();
    for (const r of this.releases) {
      r.artist = r.artists.join(', ') || 'Unknown Artist';
      r.label = r.labels[0]?.name || '';
      r.catno = r.labels[0]?.catno || '';
      r.decade = r.year ? `${Math.floor(r.year / 10) * 10}s` : '';
      r.notes ||= {};
      r.myGenre = r.notes.Genre || '';
      r.noteParts = parseNotes(r.notes.Notes || '', (r.tracks || []).map((t) => t.pos));
      r.ratio = r.have ? r.want / r.have : 0;
      r.hay = norm([
        r.title, r.artist, ...r.labels.map((l) => `${l.name} ${l.catno}`),
        ...r.genres, ...r.styles, r.year, r.country, ...Object.values(r.notes),
        ...(r.tracks || []).map((t) => `${t.title} ${(t.artists || []).join(' ')}`),
      ].join(' '));
      this.byId.set(r.id, r);
    }
    // Records without artwork borrow the white label of Frankie Bones' "Just As Long As I Got You".
    const noCover = (r) => !r.cover || r.cover.includes('spacer.gif');
    const white = this.releases.find((r) => !noCover(r) && /just as long as i got you/.test(norm(r.title)) && r.artists.some((a) => norm(a) === 'frankie bones'));
    if (white) for (const r of this.releases.filter(noCover)) Object.assign(r, { cover: white.cover, thumb: white.thumb || white.cover });
    // Names to Discogs IDs, for the artist and label profiles (most common ID when two share a name).
    this.entityIds = { a: new Map(), l: new Map() };
    const tally = (kind, name, id) => {
      if (!id) return;
      const m = this.entityIds[kind].get(name) || new Map();
      m.set(id, (m.get(id) || 0) + 1);
      this.entityIds[kind].set(name, m);
    };
    for (const r of this.releases) {
      r.artists.forEach((a, i) => tally('a', a, r.artist_ids?.[i]));
      r.labels.forEach((l) => tally('l', l.name, l.id));
    }
    this.artists = this.group((r) => r.artists);
    this.labels = this.group((r) => [...new Set(r.labels.map((l) => l.name))]);
    this.genres = this.group((r) => r.genres);
    this.styles = this.group((r) => r.styles);
    this.decades = this.group((r) => (r.decade ? [r.decade] : []));
    this.formats = this.group((r) => r.formats);
    this.myGenres = this.group((r) => (r.myGenre ? [r.myGenre] : []));
    this.clusterMembers = this.group((r) => (r.cluster === undefined ? [] : [r.cluster]));
    this.regionMembers = this.group((r) => (r.region === undefined ? [] : [r.region]));
    // Vote-weighted rating: pulls ratings with few votes toward the collection average.
    const rated = this.releases.filter((r) => r.votes);
    const mean = rated.reduce((a, r) => a + r.community_rating * r.votes, 0) / (rated.reduce((a, r) => a + r.votes, 0) || 1);
    for (const r of this.releases) {
      r.score = r.votes ? (r.votes * r.community_rating + 10 * mean) / (r.votes + 10) : 0;
      r.ratioScore = r.have !== undefined ? r.want / (r.have + 20) : 0;
      r.est = estimateValue(r);
      r.worth = r.est ? (r.est.ownValue ?? r.est.value) : 0;
    }
    this.energy = energyScale(this.releases);
    const valued = this.releases.filter((r) => r.est);
    this.estimatedTotal = valued.reduce((a, r) => a + r.worth * (r.copies || 1), 0);
    this.valuedCount = valued.length;
  }

  // Discogs profile of an artist ('a') or label ('l') by name, once a build has fetched it.
  entity(kind, name) {
    const ids = this.entityIds[kind].get(name);
    if (!ids) return null;
    const [id] = [...ids].sort((x, y) => y[1] - x[1])[0];
    const e = this.entities[`${kind}${id}`];
    return e && !e.missing ? { ...e, id } : null;
  }

  group(keysOf) {
    const map = new Map();
    for (const r of this.releases) {
      for (const k of keysOf(r)) {
        if (!k) continue;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
      }
    }
    return map;
  }

  // Pair each tracklist entry with one of the release's YouTube videos by title.
  items(r) {
    if (this.itemCache.has(r.id)) return this.itemCache.get(r.id);
    const videos = (r.videos || []).map((v) => ({ ...v, n: norm(v.title), used: false }));
    const tracks = (r.tracks || []).map((t, i) => ({ t, i, n: norm(t.title), v: null }));
    for (const tr of [...tracks].sort((a, b) => b.n.length - a.n.length)) {
      if (tr.n.length < 2) continue;
      const v = videos.find((x) => !x.used && containsPhrase(x.n, tr.n));
      if (v) { v.used = true; tr.v = v; }
    }
    const free = videos.filter((v) => !v.used);
    if (tracks.length === 1 && !tracks[0].v && free.length) { tracks[0].v = free[0]; free[0].used = true; }

    const base = (key, extra) => ({ rid: r.id, key, album: r.title, cover: r.cover, thumb: r.thumb, ...extra });
    const result = {
      tracks: tracks.map((tr) => base(`t${tr.i}`, {
        pos: tr.t.pos,
        title: tr.t.title || 'Untitled',
        artist: (tr.t.artists || r.artists).join(', ') || r.artist,
        dur: tr.t.dur || fmtTime(tr.v?.dur),
        yt: tr.v?.yt || null,
        apple: r.apple?.[tr.i],
        note: r.noteParts.tracks[tr.i] || '',
        bpm: r.audio?.[tr.i]?.[0] ?? null,
        energy: r.audio?.[tr.i] ? this.energy(r.audio[tr.i]) : null,
        spotify: r.spotify?.[tr.i] || null,
      })),
      extras: videos.filter((v) => !v.used).map((v) => base(`v${v.yt}`, {
        pos: '',
        title: v.title,
        artist: r.artist,
        dur: fmtTime(v.dur),
        yt: v.yt,
      })),
    };
    this.itemCache.set(r.id, result);
    return result;
  }

  item(rid, key) {
    const r = this.byId.get(rid);
    if (!r) return null;
    const { tracks, extras } = this.items(r);
    return tracks.find((t) => t.key === key) || extras.find((t) => t.key === key) || null;
  }

  playable(r) {
    const { tracks, extras } = this.items(r);
    return tracks.length ? tracks : extras;
  }

  // Known to have nothing to play: no YouTube video, Apple preview or Spotify track on any track.
  silent(r) {
    return !!r.stats_at && this.playable(r).every((t) => !t.yt && !t.spotify && appleCached(t) === null);
  }

  search(q, limit = 60) {
    const terms = norm(q).split(' ').filter(Boolean);
    if (!terms.length) return null;
    const hit = (s) => { const n = norm(s); return terms.every((t) => n.includes(t)); };
    const albums = this.releases.filter((r) => terms.every((t) => r.hay.includes(t)));
    const pick = (map) => [...map.keys()].filter(hit).sort((a, b) => map.get(b).length - map.get(a).length).slice(0, 12);
    const tracks = [];
    for (const r of albums) {
      for (const t of this.items(r).tracks) {
        if (hit(`${t.title} ${t.artist}`)) tracks.push(t);
        if (tracks.length >= 40) break;
      }
      if (tracks.length >= 40) break;
    }
    return {
      albums: albums.slice(0, limit),
      albumCount: albums.length,
      artists: pick(this.artists),
      labels: pick(this.labels),
      styles: pick(this.styles),
      tracks,
    };
  }
}

// Notes can be about the whole record or about tracks, by starting a part with the track position:
// "B1 deep roller", "A1-B2 dreamy" (A1 and B2), "A1 banger B1 hit", "great label. A2 the one". Only positions on
// the record's own tracklist count. Bare capital letters or numbers ("A", "2") count at the start of the notes
// or a line, after punctuation, or before a colon or dash, so "the A side" or "x 2" mid-sentence stays prose. Returns { general, tracks: [note per track index] }.
const POS = /[A-Za-z]{1,2}\d{1,2}[a-z]?|[A-Z]{1,2}|\d{1,2}/.source;
const GROUP = new RegExp(`(?<![\\w-])((?:${POS})(?:\\s*[-–/+&]\\s*(?:${POS}))*)(?![\\w])`, 'g');

export function parseNotes(text, positions) {
  const index = new Map();
  positions.forEach((p, i) => {
    const k = String(p || '').trim();
    if (!k) return;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(i);
  });
  const lookup = (tok) => index.get(tok) || (/\d/.test(tok) && /[a-z]/i.test(tok) ? index.get(tok.toUpperCase()) : null);
  const groups = [];
  if (index.size) {
    for (const m of text.matchAll(GROUP)) {
      const toks = m[1].split(/\s*[-–/+&]\s*/);
      const hits = toks.map(lookup);
      if (hits.some((h) => !h)) continue;
      // Bare letters or numbers count at the start, after punctuation, joined ("A-B dub") or before a colon or dash.
      const loose = toks.every((t) => !(/\d/.test(t) && /[a-z]/i.test(t)));
      const before = text.slice(0, m.index).replace(/[ \t]+$/, '');
      const opens = !before || /[,;.:!?\n(]$/.test(before);
      if (loose && toks.length === 1 && !opens && !/^\s*[:\-–—]/.test(text.slice(m.index + m[1].length))) continue;
      if (/\b(side|disc|cd|part|vol|no|track)\.?\s*$/i.test(text.slice(0, m.index))) continue;
      groups.push({ start: m.index, end: m.index + m[1].length, tracks: hits.flat() });
    }
  }
  const clean = (s) => s.replace(/^[\s:,;.\-–—]+|[\s,;.]+$/g, '').trim();
  const tracks = [];
  groups.forEach((g, i) => {
    const part = clean(text.slice(g.end, groups[i + 1]?.start ?? text.length));
    if (part) for (const t of g.tracks) tracks[t] = tracks[t] ? `${tracks[t]} · ${part}` : part;
  });
  return { general: clean(groups.length ? text.slice(0, groups[0].start) : text), tracks };
}

// A track's notes: what the record's notes say about it, plus what they say about the whole record.
export const trackNoteText = (r, t) => [r.noteParts?.general, t?.note].filter(Boolean).join(' ');

// Energy 0–10 from a track's measurements ([bpm, loudness dB, onset strength, brightness], see
// scripts/audio_features.py): the average of where its loudness, rhythmic busyness and brightness rank in the
// collection, so 0 is the calmest track you own and 10 the most intense.
function energyScale(releases) {
  const cols = [[], [], []];
  for (const r of releases) for (const a of r.audio || []) if (a) for (let k = 0; k < 3; k++) cols[k].push(a[k + 1]);
  cols.forEach((c) => c.sort((x, y) => x - y));
  const rank = (c, v) => {
    if (c.length < 2) return 0.5;
    let lo = 0, hi = c.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < v) lo = m + 1; else hi = m; }
    return lo / (c.length - 1);
  };
  return (a) => Math.round(((rank(cols[0], a[1]) + rank(cols[1], a[2]) + rank(cols[2], a[3])) / 3) * 100) / 10;
}

// Why two records sit near each other: what they share.
export function sharedTraits(a, b) {
  const out = [];
  const artists = a.artists.filter((x) => b.artists.includes(x) && !/^(various|unknown artist)/i.test(x));
  if (artists.length) out.push(`Same artist: ${artists[0]}`);
  const labels = a.labels.map((l) => l.name).filter((x) => b.labels.some((l) => l.name === x) && !/^not on label/i.test(x));
  if (labels.length) out.push(`Same label: ${labels[0]}`);
  const styles = a.styles.filter((x) => b.styles.includes(x));
  if (styles.length) out.push(styles.slice(0, 2).join(', '));
  if (a.myGenre && a.myGenre === b.myGenre) out.push(`Your ${a.myGenre} tag`);
  if (a.decade && a.decade === b.decade) out.push(a.decade);
  return out;
}

// iTunes Search API: free 30s previews, used when Discogs has no usable video.
const APPLE_STORE = 'listener.apple';
let appleCache;
try { appleCache = JSON.parse(localStorage.getItem(APPLE_STORE) || '{}'); } catch { appleCache = {}; }

// undefined = not looked up yet, null = no preview exists
export function appleCached(item) {
  return item.apple !== undefined ? item.apple : appleCache[`${item.rid}:${item.key}`];
}

export async function applePreview(item) {
  if (item.apple !== undefined) return item.apple;
  const id = `${item.rid}:${item.key}`;
  if (id in appleCache) return appleCache[id];
  const title = item.title.replace(/\((original|extended)? ?mix\)/i, '').trim();
  const artists = item.artist.split(/,|&| vs\.? | feat\.? | ft\.? | and | x /i).map(norm).filter(Boolean);
  const term = `${artists[0] || ''} ${title}`;
  let found = null;
  try {
    const res = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'song', limit: '10' })}`);
    const { results = [] } = await res.json();
    const t = norm(title).split(' ')[0];
    const m = results.find((x) => {
      const name = norm(x.artistName);
      return x.previewUrl && artists.some((a) => name.includes(a) || a.includes(name)) && norm(x.trackName).includes(t);
    });
    if (m) found = { url: m.previewUrl, link: m.trackViewUrl };
  } catch {
    return null;
  }
  appleCache[id] = found;
  try { localStorage.setItem(APPLE_STORE, JSON.stringify(appleCache)); } catch {}
  return found;
}
