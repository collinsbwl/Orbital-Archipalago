/**
 * The uniform-price batch auction in TypeScript, a port of programs/orbital/src/auction.rs (Track A's pinned rules).
 * The program recomputes everything on-chain; the adapter needs this copy to know which purses a clear will touch
 * and to report the fills. If the two ever disagree, the on-chain account check fails and the clear reverts.
 */
export type BidSide = 'buy' | 'sell';

export interface Bid {
  side: BidSide;
  qty: bigint;
  limit: bigint;
}

export interface AuctionOutcome {
  price: bigint | null;
  volume: bigint;
  /** All buys in priority order, then all sells in priority order. `index` points into the input array. */
  fills: { index: number; qty: bigint }[];
}

/**
 * The off-chain half of the auction: every buy as an index into `orders`, best first (highest limit, then oldest), and
 * every sell the same way (lowest limit, then oldest). The program verifies these lists in one pass instead of sorting.
 */
export function sortBook(orders: Bid[]): { buys: number[]; sells: number[] } {
  const all = orders.map((_, i) => i);
  const buys = all.filter((i) => orders[i]!.side === 'buy').sort((a, b) => cmp(orders[b]!.limit, orders[a]!.limit) || a - b);
  const sells = all.filter((i) => orders[i]!.side === 'sell').sort((a, b) => cmp(orders[a]!.limit, orders[b]!.limit) || a - b);
  return { buys, sells };
}

export function clearAuction(orders: Bid[]): AuctionOutcome {
  const prices = [...new Set(orders.map((o) => o.limit))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Best price = most volume; ties go to the smaller imbalance, then the lowest price (prices ascend, keep the first).
  let best: { volume: bigint; gap: bigint; price: bigint } | null = null;
  for (const p of prices) {
    let d = 0n;
    let s = 0n;
    for (const o of orders) {
      if (o.side === 'buy' && o.limit >= p) d += o.qty;
      else if (o.side === 'sell' && o.limit <= p) s += o.qty;
    }
    const volume = d < s ? d : s;
    const gap = d > s ? d - s : s - d;
    if (best === null || volume > best.volume || (volume === best.volume && gap < best.gap)) best = { volume, gap, price: p };
  }
  if (best === null || best.volume === 0n) return { price: null, volume: 0n, fills: [] };

  const { price, volume } = best;
  const idx = (side: BidSide, ok: (limit: bigint) => boolean) => orders.map((_, i) => i).filter((i) => orders[i]!.side === side && ok(orders[i]!.limit));
  const buys = idx('buy', (l) => l >= price).sort((a, b) => cmp(orders[b]!.limit, orders[a]!.limit) || a - b);
  const sells = idx('sell', (l) => l <= price).sort((a, b) => cmp(orders[a]!.limit, orders[b]!.limit) || a - b);

  const fills: AuctionOutcome['fills'] = [];
  for (const side of [buys, sells]) {
    let left = volume;
    for (const index of side) {
      if (left === 0n) break;
      const qty = orders[index]!.qty < left ? orders[index]!.qty : left;
      fills.push({ index, qty });
      left -= qty;
    }
  }
  return { price, volume, fills };
}

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
