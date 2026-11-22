import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, type AgentTask, type MarketView } from '@orbital/contracts';
import {
  askPrice, colonistCandidates, DEFAULT_COLONIST_CANDIDATE, HUNGER_STEP_BP, hungerPremiumBp, MAX_HUNGER_BP, MIN_ASK_SHARE_BP,
} from '../src/candidates/colonist.js';
import { applyBand } from '../src/econ.js';

const policy = { tariffsBp: {}, quotas: {}, embargoes: [] as string[], policyRateBp: 0 };

/** A Verdan colonist (Verdan makes grain and water) with an empty pantry. */
function colonist(over: Partial<AgentTask['observation']> = {}): AgentTask {
  return {
    universeId: 'u0', cycle: 9, agentId: 'verdan:colonist:0', role: 'colonist', planet: 'verdan',
    observation: {
      purse: { VRD: 1_000 }, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'grain', bids: [], asks: [], lastPrice: 40, trend: [40] },
        { good: 'water', bids: [], asks: [], lastPrice: 20, trend: [20] },
      ],
      fx: [], policy, headlines: [],
      ...over,
    },
    allowedActions: ['place_order', 'cancel_order', 'borrow', 'repay', 'pass'],
    deadlineMs: 5_000,
  };
}

// With nothing to sell, "buy now" is the default bundle (buy_needs_now is deduped into it).
const NOW = DEFAULT_COLONIST_CANDIDATE;

const buyLimit = (t: AgentTask, id: string, good: string) => {
  const c = colonistCandidates(t, DEFAULT_WORLD).find((x) => x.id === id)!;
  const a = c.actions.find((x) => x.kind === 'place_order' && x.side === 'buy' && x.good === good);
  return a && a.kind === 'place_order' ? a.limitPrice : undefined;
};

const book = (bids: [number, number][], asks: [number, number][], lastPrice: number | null = 40): MarketView => ({
  good: 'grain', bids: bids.map(([price, qty]) => ({ price, qty })), asks: asks.map(([price, qty]) => ({ price, qty })), lastPrice, trend: lastPrice ? [lastPrice] : [],
});

describe('applyBand', () => {
  it('moves a price by at least one unit for any positive band, so small rises are not floored away', () => {
    expect(applyBand(40, 100)).toBe(41); // +1% of 40 is 0.4: floored it would stay 40
    expect(applyBand(20, 100)).toBe(21);
    expect(applyBand(100, 500)).toBe(105);
    expect(applyBand(40, -200)).toBe(39);
    expect(applyBand(40, 0)).toBe(40);
    expect(applyBand(1, -5_000)).toBe(1);
  });
});

describe('colonist hunger premium', () => {
  it('bids harder for each cycle a need went unmet, only for that need', () => {
    const fed = colonist();
    const hungry = colonist({ hunger: { grain: 3 } });
    expect(buyLimit(fed, NOW, 'grain')).toBe(42); // +5%
    expect(buyLimit(hungry, NOW, 'grain')).toBe(applyBand(40, 500 + 3 * HUNGER_STEP_BP)); // +35% = 54
    expect(buyLimit(hungry, NOW, 'water')).toBe(21); // water was met: no premium
    expect(buyLimit(hungry, 'buy_needs_patient', 'grain')).toBe(applyBand(40, -200 + 3 * HUNGER_STEP_BP));
  });

  it('caps the premium and says why in the bundle description', () => {
    const starving = colonist({ hunger: { grain: 50, water: 1 } });
    expect(hungerPremiumBp(starving, 'grain')).toBe(MAX_HUNGER_BP);
    expect(buyLimit(starving, NOW, 'grain')).toBe(applyBand(40, 500 + MAX_HUNGER_BP));
    const now = colonistCandidates(starving, DEFAULT_WORLD).find((c) => c.id === NOW)!;
    expect(now.description).toMatch(/^Short of grain for 50 cycles, water for 1 cycle; bids carry a hunger premium\./);
  });
});

describe('askPrice', () => {
  it('raises over the last price when bids outnumber offers, and never asks under the best bid', () => {
    expect(askPrice(book([[42, 12]], [[40, 8]]), 40)).toBe(Math.max(42, applyBand(40, 500))); // 12 > 8: +5%
    expect(askPrice(book([[42, 20]], [[40, 8]]), 40)).toBe(applyBand(40, 1_000)); // 20 >= 2 x 8: +10%
    expect(askPrice(book([[70, 30]], []), 40)).toBe(70); // hungry buyers already bid far above: sell into the best bid
  });

  it('undercuts the cheapest ask when offers outnumber bids, down to a floor', () => {
    expect(askPrice(book([], [[20, 500]], 20), 20)).toBe(19);
    expect(askPrice(book([[30, 5]], [[38, 50]]), 40)).toBe(applyBand(30, -300)); // under both the ask and the bid
    expect(askPrice(book([], [[5, 500]], 5), 20)).toBe(Math.ceil((20 * MIN_ASK_SHARE_BP) / 10_000)); // floor: 30% of base
  });

  it('asks just over the best bid when the book is balanced, and over the last price when it is empty', () => {
    expect(askPrice(book([[42, 10]], [[44, 10]]), 40)).toBe(43);
    expect(askPrice(book([], []), 40)).toBe(41);
    expect(askPrice(undefined, null)).toBeNull();
  });

  it('a hungry bid crosses the raised ask, so scarce goods trade at climbing prices', () => {
    const ask = askPrice(book([[42, 30]], [[40, 10]]), 40)!; // 30 >= 2 x 10: squeeze, +10%
    const bid = buyLimit(colonist({ hunger: { grain: 1 } }), NOW, 'grain')!; // +5% +10%
    expect(bid).toBeGreaterThanOrEqual(ask);
  });
});
