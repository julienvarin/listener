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
    this.byId = new Map();
    this.itemCache = new Map();
    for (const r of this.releases) {
      r.artist = r.artists.join(', ') || 'Unknown Artist';
      r.label = r.labels[0]?.name || '';
      r.catno = r.labels[0]?.catno || '';
      r.decade = r.year ? `${Math.floor(r.year / 10) * 10}s` : '';
      r.notes ||= {};
      r.myGenre = r.notes.Genre || '';
      r.ratio = r.have ? r.want / r.have : 0;
      r.hay = norm([
        r.title, r.artist, ...r.labels.map((l) => `${l.name} ${l.catno}`),
        ...r.genres, ...r.styles, r.year, r.country, ...Object.values(r.notes),
        ...(r.tracks || []).map((t) => `${t.title} ${(t.artists || []).join(' ')}`),
      ].join(' '));
      this.byId.set(r.id, r);
    }
    this.artists = this.group((r) => r.artists);
    this.labels = this.group((r) => [...new Set(r.labels.map((l) => l.name))]);
    this.genres = this.group((r) => r.genres);
    this.styles = this.group((r) => r.styles);
    this.decades = this.group((r) => (r.decade ? [r.decade] : []));
    this.formats = this.group((r) => r.formats);
    this.myGenres = this.group((r) => (r.myGenre ? [r.myGenre] : []));
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

// iTunes Search API: free 30s previews, used when Discogs has no usable video.
const APPLE_STORE = 'listener.apple';
let appleCache;
try { appleCache = JSON.parse(localStorage.getItem(APPLE_STORE) || '{}'); } catch { appleCache = {}; }

// undefined = not looked up yet, null = no preview exists
export function appleCached(item) {
  return appleCache[`${item.rid}:${item.key}`];
}

export async function applePreview(item) {
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
