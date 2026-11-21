/**
 * The FX pair auction in TypeScript, a port of programs/orbital/src/fx.rs (Track A's pinned rules).
 * Rates are ppm: quote units per base unit, times 1_000_000. Like the local auction port, the program recomputes this
 * on-chain; the adapter needs it to know which purses a clear touches and to report the fills.
 */
const SCALE = 1_000_000n;
const MAX_RATE = (1n << 53n) - 1n;

/** "Sellers" give the base currency, "buyers" give the quote currency. */
export interface FxBid {
  givesBase: boolean;
  give: bigint;
  minReceive: bigint;
}

export interface FxOutcome {
  rate: bigint | null;
  /** Sellers in priority order, then buyers in priority order. `spent` is what the order gives up (the rest is refunded). */
  fills: { index: number; spent: bigint; received: bigint }[];
  dust: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const sellerLimit = (b: FxBid) => ceilDiv(b.minReceive * SCALE, b.give);
/** null = uncapped (minReceive 0) */
const buyerLimit = (b: FxBid): bigint | null => (b.minReceive === 0n ? null : (b.give * SCALE) / b.minReceive);
const capacity = (b: FxBid, r: bigint) => (b.give * SCALE) / r;

export function clearFx(orders: FxBid[]): FxOutcome {
  const eligibleSeller = (b: FxBid, r: bigint) => b.givesBase && sellerLimit(b) <= r;
  const eligibleBuyer = (b: FxBid, r: bigint) => {
    if (b.givesBase) return false;
    const l = buyerLimit(b);
    return l === null || l >= r;
  };

  const limits = orders.map((b) => (b.givesBase ? sellerLimit(b) : buyerLimit(b))).filter((l): l is bigint => l !== null && l >= 1n && l <= MAX_RATE);
  const rates = [...new Set(limits)].sort(cmp);

  let best: { volume: bigint; gap: bigint; rate: bigint } | null = null;
  for (const r of rates) {
    let s = 0n;
    let d = 0n;
    for (const b of orders) {
      if (eligibleSeller(b, r)) s += b.give;
      else if (eligibleBuyer(b, r)) d += capacity(b, r);
    }
    const volume = s < d ? s : d;
    const gap = s > d ? s - d : d - s;
    if (best === null || volume > best.volume || (volume === best.volume && gap < best.gap)) best = { volume, gap, rate: r };
  }
  if (best === null || best.volume === 0n) return { rate: null, fills: [], dust: 0n };

  const { rate: r, volume } = best;
  const all = orders.map((_, i) => i);
  const sellers = all.filter((i) => eligibleSeller(orders[i]!, r)).sort((x, y) => cmp(sellerLimit(orders[x]!), sellerLimit(orders[y]!)) || x - y);
  // highest limit first, uncapped (null) before any cap
  const buyers = all.filter((i) => eligibleBuyer(orders[i]!, r)).sort((x, y) => {
    const lx = buyerLimit(orders[x]!);
    const ly = buyerLimit(orders[y]!);
    if (lx === null && ly !== null) return -1;
    if (lx !== null && ly === null) return 1;
    return (lx !== null && ly !== null ? cmp(ly, lx) : 0) || x - y;
  });

  const fills: FxOutcome['fills'] = [];
  let paid = 0n;
  let got = 0n;
  let left = volume;
  for (const index of sellers) {
    if (left === 0n) break;
    const s = orders[index]!.give < left ? orders[index]!.give : left;
    const received = (s * r) / SCALE; // sellers round down
    fills.push({ index, spent: s, received });
    got += received;
    left -= s;
  }
  left = volume;
  for (const index of buyers) {
    if (left === 0n) break;
    const cap = capacity(orders[index]!, r);
    const b = cap < left ? cap : left;
    if (b === 0n) continue;
    const pay = ceilDiv(b * r, SCALE); // buyers round up, never above their escrow
    fills.push({ index, spent: pay, received: b });
    paid += pay;
    left -= b;
  }
  return { rate: r, fills, dust: paid - got };
}
