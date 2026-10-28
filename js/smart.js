// Smart playlists: rules over the collection ("added in 2023", "style is not House", "fewer than 5 for sale"…)
// that fill a playlist by themselves. A definition is a group: { match: 'all' | 'any', rules: [...] }, where each
// rule is either a condition { f, op, v, v2, unit } or a nested group. Text and list conditions take several
// values (v is an array) and match any of them, so "style is House, Tech House" needs no group. The definition syncs with the other playlists; the tracks are worked out
// on the device, so they follow the collection as it changes.

import { moodsOf } from './mixes.js';

const DAY = 864e5;

// [key, label, type, value(s) of a record and track]. Lists are matched on any of their values. BPM and energy
// belong to tracks: a playlist using them keeps only the tracks that match, not whole records.
export const FIELDS = [
  ['bpm', 'BPM', 'number', (r, t) => t?.bpm ?? undefined],
  ['energy', 'Energy (0–10)', 'number', (r, t) => t?.energy ?? undefined],
  ['added', 'Date Added', 'date', (r) => r.added],
  ['year', 'Year', 'number', (r) => r.year],
  ['genre', 'Genre', 'list', (r) => r.genres],
  ['style', 'Style', 'list', (r) => r.styles],
  ['mygenre', 'My Genre Tag', 'list', (r) => (r.myGenre ? [r.myGenre] : [])],
  ['tag', 'Tag', 'list', (r) => (r.notes.Tag ? [r.notes.Tag] : [])],
  ['mood', 'Mood (from notes)', 'list', moodsOf],
  ['notes', 'Notes', 'text', (r) => r.notes.Notes || ''],
  ['artist', 'Artist', 'list', (r) => r.artists],
  ['label', 'Label', 'list', (r) => r.labels.map((l) => l.name)],
  ['country', 'Country', 'list', (r) => (r.country ? [r.country] : [])],
  ['format', 'Format', 'list', (r) => [...r.formats, ...r.descriptions]],
  ['condition', 'Media Condition', 'list', (r) => (r.notes['Media Condition'] ? [r.notes['Media Condition']] : [])],
  ['title', 'Title', 'text', (r) => r.title],
  ['have', 'Have (Discogs)', 'number', (r) => r.have],
  ['want', 'Want (Discogs)', 'number', (r) => r.want],
  ['ratio', 'Want / Have', 'number', (r) => (r.have !== undefined ? r.ratio : undefined)],
  ['forsale', 'Copies for Sale', 'number', (r) => (r.have !== undefined ? r.for_sale || 0 : undefined)],
  ['price', 'Lowest Price (€)', 'number', (r) => r.lowest_price ?? undefined],
  ['value', 'Estimated Value (€)', 'number', (r) => (r.est ? r.worth : undefined)],
  ['trend', 'Value Trend', 'list', (r) => (r.est?.trend ? [r.est.trend] : [])],
  ['rating', 'Community Rating', 'number', (r) => (r.votes ? r.community_rating : undefined)],
  ['votes', 'Rating Votes', 'number', (r) => r.votes],
  ['myrating', 'My Rating', 'number', (r) => r.rating || 0],
  ['copies', 'Copies I Own', 'number', (r) => r.copies || 1],
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f[0], f]));

export const OPS = {
  list: [['is', 'is'], ['not', 'is not'], ['has', 'contains'], ['lacks', 'does not contain']],
  text: [['has', 'contains'], ['lacks', 'does not contain'], ['is', 'is'], ['not', 'is not']],
  number: [['gte', 'is at least'], ['lte', 'is at most'], ['lt', 'is less than'], ['gt', 'is more than'], ['is', 'is'], ['between', 'is between']],
  date: [['last', 'is in the last'], ['notlast', 'is not in the last'], ['after', 'is after'], ['before', 'is before'], ['between', 'is between']],
};

const TRACK_FIELDS = new Set(['bpm', 'energy']);

export const ORDERS = [['random', 'Random (new pick daily)'], ['slow', 'Slowest first'], ['fast', 'Fastest first'], ['calm', 'Calmest first'], ['intense', 'Most intense first'], ['added', 'Recently added'], ['year', 'Oldest first'], ['yeardesc', 'Newest first'], ['value', 'Most valuable'], ['rating', 'Highest rated'], ['want', 'Most wanted']];

export const blankRule = () => ({ f: 'style', op: 'is', v: [] });
export const blankGroup = () => ({ match: 'any', rules: [blankRule()] });
export const blankSmart = () => ({ match: 'all', rules: [blankRule()], order: 'random', limit: 50, per: 2 });
export const isGroup = (x) => Array.isArray(x?.rules);
export const isMulti = (f) => ['list', 'text'].includes(FIELD[f]?.[2]);

// Values of a text or list condition; older definitions stored a single string.
export const values = (x) => (Array.isArray(x.v) ? x.v : x.v ? [x.v] : []).map((v) => String(v).trim()).filter(Boolean);

const low = (s) => String(s ?? '').toLowerCase().trim();
const num = (v) => (v === '' || v === undefined || v === null ? NaN : Number(v));
const unitDays = { days: 1, weeks: 7, months: 30.44, years: 365.25 };

function test(rule, r, t) {
  const field = FIELD[rule.f];
  if (!field) return true;
  const [, , type, get] = field;
  const raw = get(r, t);
  if (type === 'list' || type === 'text') {
    const vals = (Array.isArray(raw) ? raw : [raw]).map(low);
    const want = values(rule).map(low);
    if (!want.length) return true;
    const is = want.some((w) => vals.includes(w));
    const has = want.some((w) => vals.some((x) => x.includes(w)));
    return { is, not: !is, has, lacks: !has }[rule.op] ?? true;
  }
  if (type === 'number') {
    const a = num(rule.v), b = num(rule.v2);
    if (Number.isNaN(a)) return true;
    if (raw === undefined || raw === null) return false;
    return {
      gte: () => raw >= a, lte: () => raw <= a, lt: () => raw < a, gt: () => raw > a,
      is: () => raw === a,
      between: () => raw >= Math.min(a, Number.isNaN(b) ? a : b) && raw <= Math.max(a, Number.isNaN(b) ? a : b),
    }[rule.op]?.() ?? true;
  }
  if (type === 'date') {
    const t = Date.parse(raw);
    if (rule.op === 'last' || rule.op === 'notlast') {
      const n = num(rule.v);
      if (Number.isNaN(n)) return true;
      const inside = !Number.isNaN(t) && Date.now() - t <= n * unitDays[rule.unit || 'months'] * DAY;
      return rule.op === 'last' ? inside : !inside;
    }
    const a = Date.parse(rule.v), b = Date.parse(rule.v2);
    if (Number.isNaN(a)) return true;
    if (Number.isNaN(t)) return false;
    if (rule.op === 'after') return t >= a;
    if (rule.op === 'before') return t < a;
    if (rule.op === 'between') return t >= Math.min(a, b || a) && t < Math.max(a, b || a) + DAY;
  }
  return true;
}

// Conditions with no value yet are left out, and so are groups left empty, so a half-written rule never empties
// the playlist.
const active = (x) => (isGroup(x) ? x.rules.some(active) : FIELD[x.f] && (isMulti(x.f) ? values(x).length : x.v !== '' && x.v !== undefined));

function matches(group, r, t) {
  const rules = group.rules.filter(active);
  if (!rules.length) return true;
  const ok = (x) => (isGroup(x) ? matches(x, r, t) : test(x, r, t));
  return group.match === 'any' ? rules.some(ok) : rules.every(ok);
}

const usesTracks = (g) => g.rules.some((x) => (isGroup(x) ? usesTracks(x) : active(x) && TRACK_FIELDS.has(x.f)));

// The tracks of a record a definition keeps: all of them for record-level rules, the matching ones otherwise.
const keptTracks = (lib, def, r) => (usesTracks(def) ? lib.playable(r).filter((t) => matches(def, r, t)) : matches(def, r) ? lib.playable(r) : []);

export function matchReleases(lib, def) {
  if (!usesTracks(def)) return lib.releases.filter((r) => matches(def, r));
  return lib.releases.filter((r) => keptTracks(lib, def, r).length);
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

const SORT = {
  added: (a, b) => (b.added || '').localeCompare(a.added || ''),
  year: (a, b) => (a.year || 9999) - (b.year || 9999),
  yeardesc: (a, b) => (b.year || 0) - (a.year || 0),
  value: (a, b) => b.worth - a.worth,
  rating: (a, b) => b.score - a.score,
  want: (a, b) => (b.want || 0) - (a.want || 0),
};

// Ascending (dir 1) or descending (dir -1) on a track measurement; unmeasured tracks go last.
const by = (key, dir) => (a, b) => {
  const x = a[key] ?? null, y = b[key] ?? null;
  if (x === null || y === null) return (x === null) - (y === null);
  return dir * (x - y);
};
const TRACK_SORT = { slow: by('bpm', 1), fast: by('bpm', -1), calm: by('energy', 1), intense: by('energy', -1) };

// Tracks for a smart playlist: matching, playable records in the chosen order, `per` tracks each, up to `limit`.
export function smartItems(lib, p) {
  const def = p.smart;
  const rand = seeded(`${p.id}:${new Date().toISOString().slice(0, 10)}`);
  const byTrack = TRACK_SORT[def.order];
  let rs = lib.releases.filter((r) => !lib.silent(r));
  rs = SORT[def.order] ? rs.sort(SORT[def.order]) : shuffle(rs, rand);
  const limit = Number(def.limit) || Infinity;
  const per = Number(def.per) || Infinity;
  const out = [];
  for (const r of rs) {
    const items = keptTracks(lib, def, r);
    if (!items.length) continue;
    const yt = items.filter((t) => t.yt);
    const pool = yt.length ? yt : items;
    out.push(...(byTrack ? pool.slice().sort(byTrack) : SORT[def.order] ? pool : shuffle(pool, rand)).slice(0, per));
    if (!byTrack && out.length >= limit) break;
  }
  // Track orders rank across the whole playlist; tracks without a measurement go last.
  if (byTrack) out.sort(byTrack);
  return out.slice(0, limit);
}

// One line describing the rules, for the playlist header. Nested groups go in parentheses.
export function describe(def, nested = false) {
  const parts = def.rules.filter(active).map((x) => {
    if (isGroup(x)) return describe(x, true);
    const [, label, type] = FIELD[x.f];
    const op = OPS[type].find(([k]) => k === x.op)?.[1] || '';
    const neg = x.op === 'not' || x.op === 'lacks';
    const val = isMulti(x.f) ? values(x).join(neg ? ' nor ' : ' or ')
      : x.op === 'between' ? `${x.v} and ${x.v2 ?? ''}` : (x.op === 'last' || x.op === 'notlast') ? `${x.v} ${x.unit || 'months'}` : x.v;
    return `${label} ${op} ${val}`;
  });
  if (!parts.length) return nested ? '' : 'Whole collection';
  const text = parts.join(def.match === 'any' ? ' or ' : ' · ');
  return nested && parts.length > 1 ? `(${text})` : text;
}

// Every value a list field takes, most common first, for the value suggestions.
export function suggestions(lib, f) {
  const field = FIELD[f];
  if (!field || field[2] !== 'list') return [];
  const counts = new Map();
  for (const r of lib.releases) for (const v of field[3](r)) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

export const fieldType = (f) => FIELD[f]?.[2];
