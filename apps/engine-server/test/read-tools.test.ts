import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, type AgentTask } from '@orbital/contracts';
import { travelCycles } from '@orbital/engine';
import { MarketBoards, readToolsFor, runReadTool } from '../src/read-tools.js';

const policy = { tariffsBp: {}, quotas: {}, embargoes: [] as string[], policyRateBp: 100 };

function task(over: Partial<AgentTask> & Pick<AgentTask, 'planet' | 'role' | 'agentId'>, markets: AgentTask['observation']['markets'], extra: Partial<AgentTask['observation']> = {}): AgentTask {
  return {
    universeId: 'u0', cycle: 4, allowedActions: ['ship', 'place_order', 'pass'], deadlineMs: 5_000,
    observation: { purse: {}, inventory: {}, openOrders: [], loans: [], shipments: [], markets, fx: [{ base: 'HLX', quote: 'VRD', lastRatePpm: 2_000_000 }], policy, headlines: [], ...extra },
    ...over,
  };
}

const trader = task({ planet: 'helion', role: 'trader', agentId: 'helion:trader:0' }, [
  { good: 'iron', bids: [{ price: 95, qty: 2 }], asks: [{ price: 100, qty: 5 }], lastPrice: 98, trend: [97, 98] },
]);
const verdanColonist = task({ planet: 'verdan', role: 'colonist', agentId: 'verdan:colonist:0' }, [
  { good: 'iron', bids: [{ price: 300, qty: 4 }], asks: [{ price: 320, qty: 4 }], lastPrice: 310, trend: [305, 310] },
], { policy: { ...policy, tariffsBp: { iron: 1_000 } } });

function setup(tasks: AgentTask[] = [trader, verdanColonist]) {
  const boards = new MarketBoards(DEFAULT_WORLD);
  boards.update(tasks);
  return runReadTool(boards, DEFAULT_WORLD);
}

describe('read tools', () => {
  it('gives traders both tools, governments planet_prices, colonists none', () => {
    expect(readToolsFor(trader).map((t) => t.name)).toEqual(['planet_prices', 'quote_route']);
    expect(readToolsFor({ ...trader, role: 'government' }).map((t) => t.name)).toEqual(['planet_prices']);
    expect(readToolsFor(verdanColonist)).toEqual([]);
  });

  it("planet_prices shows another planet's books and tariffs", async () => {
    const res = (await setup()('planet_prices', { planet: 'verdan' }, trader)) as Record<string, unknown>;
    expect(res).toMatchObject({ planet: 'verdan', currency: 'VRD', tariffsBp: { iron: 1_000 } });
    expect(res.markets).toEqual([{ good: 'iron', last: 310, bestBid: 300, bestAsk: 320, trend: [305, 310] }]);
  });

  it('quote_route converts the destination bid through FX, nets the tariff and adds travel time', async () => {
    const res = (await setup()('quote_route', { to: 'verdan', good: 'iron', qty: 3 }, trader)) as Record<string, number>;
    const travel = travelCycles(DEFAULT_WORLD, 'helion', 'verdan', 4);
    // 300 VRD at 2 VRD/HLX = 150 HLX; minus 10% tariff = 135; ×3 = 405 vs cost 300.
    expect(res).toMatchObject({ fxSource: 'market', buyPrice: 100, buyPriceSource: 'ask', destPrice: 300, destPriceSource: 'bid', destPriceInHomeCurrency: 150, revenueAfterTariffInHome: 405, costInHome: 300, marginInHome: 105, travelCycles: travel, arrivesCycle: 4 + travel });
  });

  it('returns errors the model can act on instead of throwing', async () => {
    const run = setup();
    expect(await run('quote_route', { to: 'pluto', good: 'iron', qty: 1 }, trader)).toMatchObject({ error: expect.stringContaining('unknown planet') });
    expect(await run('quote_route', { to: 'helion', good: 'iron', qty: 1 }, trader)).toMatchObject({ error: expect.stringContaining('own planet') });
    // No market data or FX for tethys this cycle: base price and FX parity, flagged as an estimate.
    expect(await run('quote_route', { to: 'tethys', good: 'iron', qty: 1 }, trader)).toMatchObject({ destPriceSource: 'base', fxSource: 'parity', note: expect.stringContaining('estimate') });
    expect(await run('quote_route', { to: 'verdan', good: 'unobtainium', qty: 1 }, trader)).toMatchObject({ error: expect.stringContaining('unknown good') });
    expect(await run('quote_route', { to: 'verdan', good: 'iron', qty: 1 }, { ...trader, role: 'government' })).toMatchObject({ error: expect.stringContaining('not available') });
  });

  it('keeps universes apart so concurrent forks never read each other', async () => {
    const boards = new MarketBoards(DEFAULT_WORLD);
    boards.update([trader, verdanColonist]);
    const forkColonist = { ...verdanColonist, universeId: 'u0-fork', observation: { ...verdanColonist.observation, markets: [{ ...verdanColonist.observation.markets[0]!, bids: [{ price: 900, qty: 1 }] }] } };
    boards.update([{ ...trader, universeId: 'u0-fork' }, forkColonist]);
    const run = runReadTool(boards, DEFAULT_WORLD);
    expect(await run('planet_prices', { planet: 'verdan' }, trader)).toMatchObject({ markets: [{ bestBid: 300 }] });
    expect(await run('planet_prices', { planet: 'verdan' }, { ...trader, universeId: 'u0-fork' })).toMatchObject({ markets: [{ bestBid: 900 }] });
  });

  it('falls back to base prices when books are empty (early cycles) and says so', async () => {
    const empty = (t: AgentTask): AgentTask => ({ ...t, observation: { ...t.observation, markets: [{ good: 'iron', bids: [], asks: [], lastPrice: null, trend: [] }] } });
    const res = (await setup([empty(trader), empty(verdanColonist)])('quote_route', { to: 'verdan', good: 'iron', qty: 2 }, empty(trader))) as Record<string, unknown>;
    expect(res).toMatchObject({ buyPriceSource: 'base', destPriceSource: 'base' });
    expect(typeof res.marginInHome).toBe('number');
    expect(res.note).toMatch(/base price/);
  });
});
