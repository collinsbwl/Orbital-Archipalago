import { describe, expect, it } from 'vitest';
import { makeUniverse } from './helpers.js';

describe('MarketBook', () => {
  it('mirrors ledger.openOrders after every cycle', async () => {
    const { universe, ledger, world } = makeUniverse();
    await universe.init();
    const agents = world.planets.flatMap((p) =>
      (['colonist', 'trader'] as const).flatMap((role) => Array.from({ length: p.agents[role] }, (_, i) => `${p.id}:${role}:${i}`)),
    );
    for (let c = 0; c < 15; c++) {
      await universe.step();
      for (const id of agents) {
        const fromLedger = await ledger.openOrders(id);
        expect(universe.book.ordersOf(id)).toEqual(fromLedger);
      }
    }
    expect(universe.book.all().length).toBeGreaterThan(0);
  });

  it('aggregates top-3 levels, last price and a 5-price trend', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    for (let c = 0; c < 12; c++) await universe.step();
    let checked = 0;
    for (const planet of ['helion', 'verdan', 'tethys']) {
      for (const good of ['iron', 'grain', 'water', 'fuel', 'tools']) {
        const v = universe.book.view(planet, good);
        expect(v.bids.length).toBeLessThanOrEqual(3);
        expect(v.trend.length).toBeLessThanOrEqual(5);
        expect(v.lastPrice).toBe(v.trend.length ? v.trend[v.trend.length - 1] : null);
        for (let i = 1; i < v.bids.length; i++) expect(v.bids[i - 1]!.price).toBeGreaterThan(v.bids[i]!.price);
        for (let i = 1; i < v.asks.length; i++) expect(v.asks[i - 1]!.price).toBeLessThan(v.asks[i]!.price);
        // Aggregate qty at a level equals the sum of resting orders there.
        for (const b of v.bids) {
          const sum = universe.book.all().filter((o) => o.planet === planet && o.good === good && o.side === 'buy' && o.limitPrice === b.price).reduce((s, o) => s + o.qty, 0);
          expect(b.qty).toBe(sum);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
