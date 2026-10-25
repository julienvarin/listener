// Estimated value of a record, blending recent sales with the current marketplace.
//
// Recent sales: Discogs price suggestions (per condition, derived from sales history), read at VG+.
// Marketplace: the cheapest listing and how many copies are for sale. The cheapest of many listings is
// naturally below typical sale prices, and a lone listing is usually priced high, so the cheapest price
// is compared to what is normal for that number of copies (fitted on this collection:
// 1 copy ≈ 2.0× recent sales, 2–3 ≈ 1.1×, 4–9 ≈ 0.9×, 10+ ≈ 0.6×), with a floor because almost nobody
// lists below a couple of euros. The ratio between the actual and the normal cheapest price is "heat".

const GRADE = 'Very Good Plus (VG+)';
const short = (c) => c.match(/\(([^)]+)\)/)?.[1] || c;

const FLOOR = 2.5;
export const expectedCheapest = (n, sales) => Math.max(sales * Math.max(0.55, 2.0 * n ** -0.45), FLOOR);

export function estimateValue(r, euro) {
  if (r.have === undefined) return null;
  const s = r.suggest || {};
  const S = s[GRADE] || null;
  const L = r.lowest_price || null;
  const N = r.for_sale || 0;
  const why = [];
  let value, confidence, trend = null, heat = null;

  if (S) {
    why.push(`Recent sales put a VG+ copy around ${euro(S)}.`);
    value = S;
    if (L && N) {
      heat = L / expectedCheapest(N, S);
      // More listings make the marketplace signal more trustworthy; prices below the norm count for half,
      // since a cheap outlier is often a worn copy.
      const weight = 0.6 * (N / (N + 4));
      const capped = Math.min(heat, N <= 2 ? 2 : 6);
      value = heat >= 1 ? S * (1 - weight + weight * capped) : S * (1 - weight / 2 + (weight / 2) * Math.max(heat, 0.7));
      const worn = L < 0.4 * S;
      if (N === 1 && L >= 3 * S) why.push(`The only copy for sale is listed at ${euro(L)}, far above recent sales, so it barely counts.`);
      else if (worn) why.push(`The cheapest copy (${euro(L)}) is far below recent sales, likely a worn copy, so it barely counts.`);
      else if (heat >= 1.5) why.push(`Even the cheapest of ${N} copies for sale (${euro(L)}) is well above what's normal, so the estimate leans up.`);
      else if (heat <= 0.7) why.push(`Copies are listed below recent sales (${N} for sale from ${euro(L)}), so the estimate leans down a little.`);
      else why.push(`${N} for sale from ${euro(L)}, in line with recent sales.`);
      if (N >= 2 && heat >= 1.5) trend = 'Heating up';
      else if (N >= 5 && heat <= 0.6 && !worn) trend = 'Cooling';
    } else {
      const premium = Math.min(0.25, 0.05 * (r.want / Math.max(r.have, 1)));
      value = S * (1 + (r.want >= 20 ? premium : 0));
      why.push(r.want >= 20 ? `Nobody is selling a copy right now while ${r.want} people want it, so a small scarcity premium is added.` : 'No copies for sale right now.');
      if (r.want >= 20) trend = 'Scarce';
    }
    confidence = N >= 3 ? 'High' : 'Medium';
  } else if (L && N) {
    value = N === 1 ? Math.max(L / 2, Math.min(L, FLOOR)) : L;
    confidence = 'Low';
    why.push(`No recent sales data. Estimated from the cheapest of ${N} listing${N > 1 ? 's' : ''} (${euro(L)}), adjusted for how many are for sale.`);
  } else {
    return null;
  }

  // Your copy: scale by the condition in your Discogs notes when Discogs has a price for that grade.
  const own = r.notes?.['Media Condition'];
  const ownValue = own && S && s[own] ? value * (s[own] / S) : null;
  if (ownValue) why.push(`Your copy is ${short(own)}: about ${euro(ownValue)}.`);

  return { value, ownValue, confidence, trend, heat, why, sales: S, grades: s };
}
