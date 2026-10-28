// Smart playlists: rules over the collection ("added in 2023", "style is not House", "fewer than 5 for sale"…)
// that fill a playlist by themselves. The definition syncs with the other playlists; the tracks are worked out
// on the device, so they follow the collection as it changes.

import { moodsOf } from './mixes.js';

const DAY = 864e5;

// [key, label, type, value(s) of a record]. Lists are matched on any of their values.
export const FIELDS = [
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

export const ORDERS = [['random', 'Random (new pick daily)'], ['added', 'Recently added'], ['year', 'Oldest first'], ['yeardesc', 'Newest first'], ['value', 'Most valuable'], ['rating', 'Highest rated'], ['want', 'Most wanted']];

export const blankRule = () => ({ f: 'style', op: 'is', v: '' });
export const blankSmart = () => ({ match: 'all', rules: [blankRule()], order: 'random', limit: 50, per: 2 });

const low = (s) => String(s ?? '').toLowerCase().trim();
const num = (v) => (v === '' || v === undefined || v === null ? NaN : Number(v));
const unitDays = { days: 1, weeks: 7, months: 30.44, years: 365.25 };

function test(rule, r) {
  const field = FIELD[rule.f];
  if (!field) return true;
  const [, , type, get] = field;
  const raw = get(r);
  const v = low(rule.v);
  if (type === 'list' || type === 'text') {
    const vals = (Array.isArray(raw) ? raw : [raw]).map(low);
    if (!v) return true;
    return {
      is: () => vals.includes(v),
      not: () => !vals.includes(v),
      has: () => vals.some((x) => x.includes(v)),
      lacks: () => !vals.some((x) => x.includes(v)),
    }[rule.op]?.() ?? true;
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

export function matchReleases(lib, def) {
  const rules = (def.rules || []).filter((x) => FIELD[x.f]);
  if (!rules.length) return lib.releases.slice();
  return lib.releases.filter((r) => (def.match === 'any' ? rules.some((x) => test(x, r)) : rules.every((x) => test(x, r))));
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

// Tracks for a smart playlist: matching, playable records in the chosen order, `per` tracks each, up to `limit`.
export function smartItems(lib, p) {
  const def = p.smart;
  const rand = seeded(`${p.id}:${new Date().toISOString().slice(0, 10)}`);
  let rs = matchReleases(lib, def).filter((r) => !lib.silent(r));
  rs = def.order === 'random' || !SORT[def.order] ? shuffle(rs, rand) : rs.sort(SORT[def.order]);
  const limit = Number(def.limit) || Infinity;
  const per = Number(def.per) || Infinity;
  const out = [];
  for (const r of rs) {
    const items = lib.playable(r);
    const yt = items.filter((t) => t.yt);
    const pool = yt.length ? yt : items;
    out.push(...(def.order === 'random' ? shuffle(pool, rand) : pool).slice(0, per));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// One line describing the rules, for the playlist header.
export function describe(def) {
  const parts = (def.rules || []).filter((x) => FIELD[x.f] && x.v !== '').map((x) => {
    const [, label, type] = FIELD[x.f];
    const op = OPS[type].find(([k]) => k === x.op)?.[1] || '';
    const val = x.op === 'between' ? `${x.v} and ${x.v2 ?? ''}` : (x.op === 'last' || x.op === 'notlast') ? `${x.v} ${x.unit || 'months'}` : x.v;
    return `${label} ${op} ${val}`;
  });
  return parts.length ? parts.join(def.match === 'any' ? ' or ' : ' · ') : 'Whole collection';
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
