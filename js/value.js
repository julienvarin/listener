// Estimated value of a record: one number, built from recent sales, the marketplace, and how both moved.
//
// Recent sales: Discogs price suggestions (per condition, derived from sales history), read at VG+.
// Marketplace: the cheapest listing and how many copies are for sale. The cheapest of many listings is
// naturally below typical sale prices, and a lone listing is usually priced high, so the cheapest price
// is compared to what is normal for that number of copies (fitted on this collection:
// 1 copy ≈ 2.0× recent sales, 2–3 ≈ 1.1×, 4–9 ≈ 0.9×, 10+ ≈ 0.6×), with a floor because almost nobody
// lists below a couple of euros. The ratio between the actual and the normal cheapest price is "heat".
// Listings are asking prices, and records sell for a bit less than sellers ask, so an estimate that leans
// on listings is discounted.
// History: every build that refreshes a record appends [date, cheapest, for sale, VG+ sales] to r.hist.
// A record that has been going up is assumed to keep going up for a while (and down likewise), and one
// that has been off the market for months while people want it is scarce, so it is worth more.

const GRADE = 'Very Good Plus (VG+)';
const FLOOR = 2.5;
const ASKING = 0.88;
const DAY = 864e5;

export const expectedCheapest = (n, sales) => Math.max(sales * Math.max(0.55, 2.0 * n ** -0.45), FLOOR);

// What one snapshot says a VG+ copy is worth: recent sales, nudged by how the cheapest listing compares
// to normal. More listings make the marketplace count more; a lone copy far above sales barely counts,
// and a cheapest copy far below sales is likely worn.
function snapshot(S, L, N) {
  if (!S) return L && N ? (N === 1 ? Math.max(L / 2, Math.min(L, FLOOR)) : L) * ASKING : null;
  if (!L || !N) return S;
  const heat = L / expectedCheapest(N, S);
  const weight = 0.6 * (N / (N + 4));
  if (heat >= 1) return S * (1 + weight * (Math.min(heat, N <= 2 ? 2 : 6) - 1) * ASKING);
  return S * (1 - weight / 2 + (weight / 2) * Math.max(heat, 0.7));
}

// Yearly growth of the snapshot value across the stored history (log-linear fit), or null when the
// history is too short to say.
function growth(hist) {
  const pts = hist.map(([d, L, N, S]) => [Date.parse(d), snapshot(S, L, N)]).filter(([t, v]) => t && v);
  if (pts.length < 3 || pts.at(-1)[0] - pts[0][0] < 45 * DAY) return null;
  const xs = pts.map(([t]) => (t - pts[0][0]) / (365 * DAY));
  const ys = pts.map(([, v]) => Math.log(v));
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1);
  return Math.exp(slope) - 1;
}

// Days the record has been continuously off the market, counting back from the latest snapshot.
function daysUnlisted(hist, N) {
  if (N) return 0;
  let since = null;
  for (let i = hist.length - 1; i >= 0 && !hist[i][2]; i--) since = hist[i][0];
  return since ? Math.max(0, (Date.now() - Date.parse(since)) / DAY) : 0;
}

export function estimateValue(r) {
  if (r.have === undefined) return null;
  const s = r.suggest || {};
  const S = s[GRADE] || null;
  const L = r.lowest_price || null;
  const N = r.for_sale || 0;
  let value = snapshot(S, L, N);
  if (!value) return null;
  const hist = r.hist || [];
  const heat = S && L && N ? L / expectedCheapest(N, S) : null;

  // Momentum: carry half a year of the trend forward, capped both ways.
  const g = growth(hist);
  if (g !== null) value *= 1 + Math.max(-0.2, Math.min(0.35, g / 2));

  // Scarcity: wanted, nobody selling. Grows with demand and with how long nobody has listed a copy.
  const unlisted = daysUnlisted(hist, N);
  if (!N && r.want >= 10) {
    const demand = Math.min(0.25, 0.05 * (r.want / Math.max(r.have, 1)));
    const absence = Math.min(0.3, unlisted / 365 * 0.3) * (g === null || g >= 0 ? 1 : 0.5);
    value *= 1 + demand + absence;
  }

  let trend = null;
  if (g !== null && g >= 0.15) trend = 'Rising';
  else if (g !== null && g <= -0.15) trend = 'Falling';
  else if (N >= 2 && heat >= 1.5) trend = 'Heating up';
  else if (!N && r.want >= 20) trend = 'Scarce';

  // Your copy: scale by the condition in your Discogs notes when Discogs has a price for that grade.
  const own = r.notes?.['Media Condition'];
  const ownValue = own && S && s[own] ? value * (s[own] / S) : null;

  return { value, ownValue, own: ownValue ? own : null, trend, heat, growth: g };
}
