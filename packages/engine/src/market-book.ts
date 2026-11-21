import type { AuctionResult, GoodId, MarketView, Order, OrderId, OrderRecord, PlanetId } from '@orbital/contracts';

const key = (planet: PlanetId, good: GoodId) => `${planet}|${good}`;

/**
 * Engine-side mirror of resting local orders (the Ledger interface has no book query). Fed by accepted placeOrders,
 * cancelOrder and auction fills. `OrderRecord.qty` is the remaining quantity, like Ledger.openOrders.
 */
export class MarketBook {
  /** Insertion order = placement order (oldest first). */
  private orders = new Map<OrderId, OrderRecord>();
  private trends = new Map<string, number[]>();

  /** Independent deep copy. */
  clone(): MarketBook {
    const b = new MarketBook();
    b.orders = structuredClone(this.orders);
    b.trends = structuredClone(this.trends);
    return b;
  }

  add(rec: OrderRecord): void {
    this.orders.set(rec.orderId, { ...rec });
  }

  remove(orderId: OrderId): void {
    this.orders.delete(orderId);
  }

  get(orderId: OrderId): OrderRecord | undefined {
    return this.orders.get(orderId);
  }

  /** Resting orders of one agent, oldest first. */
  ordersOf(agentId: string): OrderRecord[] {
    return [...this.orders.values()].filter((o) => o.agentId === agentId).map((o) => ({ ...o }));
  }

  all(): OrderRecord[] {
    return [...this.orders.values()].map((o) => ({ ...o }));
  }

  /** Apply an auction result: reduce or remove filled orders, record the clearing price. */
  applyAuction(r: AuctionResult): void {
    for (const f of r.fills) {
      const o = this.orders.get(f.orderId);
      if (!o) continue;
      o.qty -= f.qty;
      if (o.qty <= 0) this.orders.delete(f.orderId);
    }
    if (r.clearingPrice !== null) {
      const k = key(r.planet, r.good);
      this.trends.set(k, [...(this.trends.get(k) ?? []), r.clearingPrice].slice(-5));
    }
  }

  /** Last clearing price of a market, null if it never cleared. */
  lastPrice(planet: PlanetId, good: GoodId): number | null {
    const t = this.trends.get(key(planet, good));
    return t?.length ? (t[t.length - 1] as number) : null;
  }

  view(planet: PlanetId, good: GoodId): MarketView {
    const levels = (side: Order['side']) => {
      const m = new Map<number, number>();
      for (const o of this.orders.values()) {
        if (o.planet === planet && o.good === good && o.side === side) m.set(o.limitPrice, (m.get(o.limitPrice) ?? 0) + o.qty);
      }
      const dir = side === 'buy' ? -1 : 1;
      return [...m].map(([price, qty]) => ({ price, qty })).sort((a, b) => dir * (a.price - b.price)).slice(0, 3);
    };
    const trend = this.trends.get(key(planet, good)) ?? [];
    return { good, bids: levels('buy'), asks: levels('sell'), lastPrice: trend.length ? (trend[trend.length - 1] as number) : null, trend: [...trend] };
  }
}
