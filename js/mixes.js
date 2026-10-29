// Made for You: playlists the app builds itself from the collection, rotating every day.
// Each recipe proposes candidates (a mood from your notes, a country in a decade, a Discogs style in a decade,
// your genre tags, a curated map cluster, a label, hidden gems); the day's seed picks ten across recipes, so
// the mix of kinds stays varied, and draws up to two playable tracks per record.

// Mirrors MOODS in scripts/collection_map.py.
const MOODS = {
  deep: 'deep', intense: 'intense', club: 'club', groovy: 'groovy', groove: 'groovy',
  melancholic: 'melancholic', melancholy: 'melancholic', loopy: 'loopy', roller: 'roller', ballad: 'ballad',
  dark: 'dark', darkisant: 'dark', darkos: 'dark', vocoder: 'vocoder', gangster: 'gangster',
  omenous: 'ominous', ominous: 'ominous', solar: 'solar', glitchy: 'glitchy', moody: 'moody',
  dreamy: 'dreamy', funky: 'funky', spooky: 'spooky', chill: 'chill', laidback: 'chill', slow: 'slow',
  fast: 'fast', dub: 'dub', tension: 'tension', breaky: 'breaky', 'woman-vocal': 'female vocal',
  'man-vocal': 'male vocal', raw: 'raw', bassy: 'bassy', melodic: 'melodic', 'slow-dance': 'slow dance',
  trippy: 'trippy', robotic: 'robotic', lullaby: 'lullaby', weird: 'weird', organic: 'organic',
  epic: 'epic', spacey: 'spacey', emotion: 'emotional', jackin: 'jackin', oriental: 'oriental',
  tribal: 'tribal', jazzy: 'jazzy', trancey: 'trancey', proggy: 'proggy', playful: 'playful',
  indus: 'industrial', dancefloor: 'dancefloor', beatless: 'beatless', mental: 'mental',
};

import { trackNoteText } from './library.js';

const MIN = 8;
const TRACKS = 30;
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const decadeName = (d) => `${d.slice(2)}`;

// Moods in a record's notes, or with a track, in what the notes say about that track and the whole record.
export function moodsOf(r, t = null) {
  const words = (t ? trackNoteText(r, t) : r.notes.Notes || '').toLowerCase().match(/[a-z][a-z-]+/g) || [];
  return [...new Set(words.filter((w) => MOODS[w]).map((w) => MOODS[w]))];
}

function seeded(text) {
  let a = [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function groupBy(releases, keysOf) {
  const m = new Map();
  for (const r of releases) for (const k of keysOf(r)) if (k) (m.get(k) || m.set(k, []).get(k)).push(r);
  return m;
}

const big = (m) => [...m].filter(([, rs]) => rs.length >= MIN);

function recipes(lib) {
  const rs = lib.releases.filter((r) => !lib.silent(r));
  const out = {};
  const moods = groupBy(rs, moodsOf);
  // Mood mixes take the tracks the mood is about: all of a record's tracks for a note on the whole record,
  // only the named ones for "B1 dreamy".
  const moodPick = (m) => (t, r) => moodsOf(r, t).includes(m);
  out.mood = big(moods).map(([m, list]) => ({ id: `mood-${slug(m)}`, tags: [m], name: `${capFirst(m)} moods`, sub: `Tracks your notes call ${m}`, list, pick: moodPick(m) }));
  out.moodStyle = big(groupBy(rs, (r) => moodsOf(r).flatMap((m) => r.styles.map((s) => `${m}|${s}`))))
    .map(([k, list]) => { const [m, s] = k.split('|'); return { id: `ms-${slug(k)}`, tags: [m, s], name: `${capFirst(m)} ${s}`, sub: `${s} your notes call ${m}`, list, pick: moodPick(m) }; });
  out.countryDecade = big(groupBy(rs, (r) => (r.country && r.decade ? [`${r.country}|${r.decade}`] : [])))
    .map(([k, list]) => { const [c, d] = k.split('|'); return { id: `cd-${slug(k)}`, tags: [c, d], name: `${c} in the ${decadeName(d)}`, sub: `Pressed in ${c}, ${d}`, list }; });
  out.styleDecade = big(groupBy(rs, (r) => (r.decade ? r.styles.map((s) => `${s}|${r.decade}`) : [])))
    .map(([k, list]) => { const [s, d] = k.split('|'); return { id: `sd-${slug(k)}`, tags: [s, d], name: `${decadeName(d)} ${s}`, sub: `Discogs style ${s}, ${d}`, list }; });
  out.myGenre = big(groupBy(rs, (r) => (r.myGenre ? [r.myGenre] : [])))
    .map(([g, list]) => ({ id: `mg-${slug(g)}`, tags: [g], name: `${g} crate dig`, sub: `From your ${g} tag`, list }));
  out.myGenreDecade = big(groupBy(rs, (r) => (r.myGenre && r.decade ? [`${r.myGenre}|${r.decade}`] : [])))
    .map(([k, list]) => { const [g, d] = k.split('|'); return { id: `mgd-${slug(k)}`, tags: [g, d], name: `${g}, ${d}`, sub: `Your ${g} tag, ${d}`, list }; });
  out.cluster = lib.clusters.map((c) => ({ c, list: (lib.clusterMembers.get(c.id) || []).filter((r) => rs.includes(r)) }))
    .filter(({ list }) => list.length >= MIN)
    .map(({ c, list }) => ({ id: `cl-${c.id}`, name: c.name, sub: 'A corner of your collection map', list }));
  out.label = big(groupBy(rs, (r) => [...new Set(r.labels.map((l) => l.name))].filter((n) => !/^(not on label|white label|none|no label)/i.test(n))))
    .map(([l, list]) => ({ id: `lb-${slug(l)}`, name: `${l} selects`, sub: `Records on ${l}`, list }));
  const noted = rs.filter((r) => r.noteParts.tracks.some(Boolean));
  if (noted.length >= MIN) out.highlights = [{ id: 'highlights', name: 'Your highlights', sub: 'Tracks you singled out in your notes', list: noted, pick: (t) => !!t.note }];
  const gems = rs.filter((r) => r.have !== undefined && r.have <= 150 && r.want > r.have);
  if (gems.length >= MIN) out.gems = [{ id: 'gems', name: 'Hidden gems', sub: 'Few own them, more want them', list: gems }];
  const old = rs.filter((r) => r.added && Date.now() - Date.parse(r.added) > 2 * 365 * 864e5);
  if (old.length >= MIN) out.dust = [{ id: 'dust', name: 'Dusted off', sub: 'In the crates for over two years', list: old }];
  return out;
}

function tracksFor(lib, list, rand, pick) {
  const out = [];
  for (const r of shuffle(list, rand)) {
    const all = lib.playable(r);
    const items = pick ? all.filter((t) => pick(t, r)) : all;
    if (!items.length) continue;
    const yt = items.filter((t) => t.yt);
    out.push(...shuffle(yt.length ? yt : items, rand).slice(0, list.length >= TRACKS ? 1 : 2));
    if (out.length >= TRACKS) break;
  }
  return out;
}

let cache = null;

// The day's mixes. `turn` rerolls the pick within the same day.
export function mixes(lib, turn = 0, count = 10) {
  const day = new Date().toISOString().slice(0, 10);
  const seed = `${day}:${turn}`;
  if (cache?.seed === seed && cache.lib === lib) return cache.list;
  const rand = seeded(seed);
  const pools = Object.values(recipes(lib)).map((p) => shuffle(p, rand)).filter((p) => p.length);
  // Round-robin across recipes. The first pass skips mixes sharing a subject (a style, tag, mood, decade or
  // country) with one already picked; the second fills up if that leaves too few.
  const picked = [];
  const used = new Set();
  const key = (t) => t.toLowerCase();
  for (const strict of [true, false]) {
    const queues = pools.map((p) => p.slice());
    while (picked.length < count && queues.some((q) => q.length)) {
      for (const q of shuffle(queues, rand)) {
        let m;
        while ((m = q.shift()) && (picked.includes(m) || picked.some((x) => key(x.name) === key(m.name)) || (strict && (m.tags || []).some((t) => used.has(key(t)))))) ;
        if (!m) continue;
        picked.push(m);
        (m.tags || []).forEach((t) => used.add(key(t)));
        if (picked.length >= count) break;
      }
    }
  }
  const list = picked.map((m) => ({ ...m, items: tracksFor(lib, m.list, rand, m.pick) })).filter((m) => m.items.length >= 5);
  cache = { seed, lib, list };
  return list;
}
