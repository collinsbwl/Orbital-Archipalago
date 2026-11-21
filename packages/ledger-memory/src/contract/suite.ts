import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, WorldConfigSchema } from '@orbital/contracts';
import type { Cargo, Ledger, LedgerErrorCode, Order, WorldConfig } from '@orbital/contracts';

/**
 * Behavioural contract for any `Ledger` implementation. Uses ONLY the `Ledger` interface, so the same suite runs
 * unchanged against InMemoryLedger and SolanaLedger. See README.md for the pinned semantics.
 */

const TINY: WorldConfig = WorldConfigSchema.parse({
  name: 'Tiny', universeId: 'tiny', seed: 1, cycles: 10, cycleDeadlineMs: 1000, gatewayProfile: 'stub',
  goods: [{ id: 'ore', name: 'Ore', basePrice: 10 }, { id: 'grain', name: 'Grain', basePrice: 5 }],
  recipes: [{ id: 'smelt', inputs: [{ good: 'ore', qty: 2 }], output: { good: 'grain', qty: 1 } }],
  colonistNeeds: [{ good: 'grain', qty: 1 }],
  travel: { speedUnitsPerCycle: 10, minCycles: 1 },
  planets: ['alpha', 'beta', 'gamma'].map((id, i) => ({
    id, name: id, currency: ['ALP', 'BET', 'GAM'][i], orbit: { radius: 10 * (i + 1), periodCycles: 10, phaseCycles: 0 },
    recipes: [{ recipe: 'smelt', batchesPerCycle: 1 }],
    agents: { colonist: 1, trader: 1, government: 1, reserve_bank: 1 }, purses: { colonist: 0, trader: 0, treasury: 0 },
  })),
});
const PLANETS = ['alpha', 'beta', 'gamma'];
const CUR: Record<string, string> = { alpha: 'ALP', beta: 'BET', gamma: 'GAM' };
const AGENTS = ['a1', 'a2', 'a3'];
const WEALTH = 10_000;

async function expectCode(p: Promise<unknown>, code: LedgerErrorCode): Promise<void> {
  await expect(p).rejects.toMatchObject({ name: 'LedgerError', code });
}
async function inv(l: Ledger): Promise<void> {
  const r = await l.checkInvariants();
  expect(r.violations).toEqual([]);
  expect(r.ok).toBe(true);
}
const order = (agentId: string, side: 'buy' | 'sell', qty: number, limitPrice: number, planet = 'alpha', good = 'ore'): Order => ({
  agentId, planet, good, side, qty, limitPrice,
});

/** Opens the three treasuries and agents a1..a3 (home alpha) holding WEALTH of every currency and 100 ore/grain. */
async function fresh(make: (w: WorldConfig) => Promise<Ledger>, opts: { treasuries?: boolean } = {}): Promise<Ledger> {
  const l = await make(TINY);
  if (opts.treasuries !== false) for (const p of PLANETS) await l.openAccount({ owner: p, planet: p, purse: { [CUR[p]!]: 1_000 } });
  for (const a of AGENTS) {
    await l.openAccount({ owner: a, planet: 'alpha', purse: { ALP: WEALTH, BET: WEALTH, GAM: WEALTH }, inventory: { ore: 100, grain: 100 } });
  }
  return l;
}
async function place(l: Ledger, orders: Order[], cycle = 1): Promise<string[]> {
  const r = await l.placeOrders(orders, cycle);
  expect(r.rejected).toEqual([]);
  return r.accepted.map((a) => a.orderId);
}

export function runLedgerContractSuite(name: string, makeLedger: (world: WorldConfig) => Promise<Ledger>): void {
  const mk = (opts?: { treasuries?: boolean }) => fresh(makeLedger, opts);

  describe(`${name}: ledger contract`, () => {
    describe('accounts', () => {
      it('reads initial purses and inventory; missing balances are 0', async () => {
        const l = await mk();
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        expect(await l.getPurse('alpha', 'BET')).toBe(0);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(0);
        const r = await l.checkInvariants();
        expect(r.totals.currency).toEqual({ ALP: 1_000 + 3 * WEALTH, BET: 1_000 + 3 * WEALTH, GAM: 1_000 + 3 * WEALTH });
        expect(r.totals.goods).toEqual({ ore: 300, grain: 300 });
        await inv(l);
      });

      it('opening an owner twice is invalid_state', async () => {
        const l = await mk();
        await expectCode(l.openAccount({ owner: 'a1', planet: 'alpha' }), 'invalid_state');
        await expectCode(l.openAccount({ owner: 'alpha', planet: 'alpha' }), 'invalid_state');
        await inv(l);
      });

      it('rejects invalid opening balances and unknown ids with invalid_amount', async () => {
        const l = await mk();
        await expectCode(l.openAccount({ owner: 'z1', planet: 'nowhere' }), 'invalid_amount');
        await expectCode(l.openAccount({ owner: 'z1', planet: 'alpha', purse: { ALP: -1 } }), 'invalid_amount');
        await expectCode(l.openAccount({ owner: 'z1', planet: 'alpha', purse: { ALP: 1.5 } }), 'invalid_amount');
        await expectCode(l.openAccount({ owner: 'z1', planet: 'alpha', purse: { XXX: 1 } }), 'invalid_amount');
        await expectCode(l.openAccount({ owner: 'z1', planet: 'alpha', purse: { ALP: Number.MAX_SAFE_INTEGER + 1 } }), 'invalid_amount');
        await expectCode(l.openAccount({ owner: 'z1', planet: 'alpha', inventory: { nothing: 1 } }), 'invalid_amount');
        await expectCode(l.openAccount({ owner: 'z1', planet: 'alpha', inventory: { ore: -1 } }), 'invalid_amount');
        await expectCode(l.getPurse('z1', 'ALP'), 'unknown_account'); // failed opens leave no account behind
        await inv(l);
      });

      it('any method on an unopened owner is unknown_account', async () => {
        const l = await mk();
        await expectCode(l.getPurse('ghost', 'ALP'), 'unknown_account');
        await expectCode(l.getInventory('ghost', 'alpha', 'ore'), 'unknown_account');
        await expectCode(l.transfer({ from: 'ghost', to: 'a1', currency: 'ALP', amount: 1 }), 'unknown_account');
        await expectCode(l.transfer({ from: 'a1', to: 'ghost', currency: 'ALP', amount: 1 }), 'unknown_account');
        await expectCode(l.produce({ owner: 'ghost', planet: 'alpha', inputs: [], outputs: [{ good: 'ore', qty: 1 }] }), 'unknown_account');
        await expectCode(l.consume({ owner: 'ghost', planet: 'alpha', cargo: [{ good: 'ore', qty: 1 }] }), 'unknown_account');
        await expectCode(l.openOrders('ghost'), 'unknown_account');
        await expectCode(l.depart({ owner: 'ghost', from: 'alpha', to: 'beta', cargo: [{ good: 'ore', qty: 1 }], cycle: 1, arriveCycle: 2 }), 'unknown_account');
        await expectCode(l.borrow({ borrower: 'ghost', planet: 'alpha', amount: 10, termCycles: 5, cycle: 1 }), 'unknown_account');
        const r = await l.placeOrders([order('ghost', 'buy', 1, 1)], 1);
        expect(r.accepted).toEqual([]);
        expect(r.rejected).toMatchObject([{ index: 0, error: { code: 'unknown_account' } }]);
        const fx = await l.placeFxOrders([{ agentId: 'ghost', give: 'ALP', giveAmount: 1, want: 'BET', minReceive: 1 }], 1);
        expect(fx.rejected).toMatchObject([{ index: 0, error: { code: 'unknown_account' } }]);
        await inv(l);
      });

      it('rejects unknown planet, good and currency in queries as invalid_amount', async () => {
        const l = await mk();
        await expectCode(l.getPurse('a1', 'XXX'), 'invalid_amount');
        await expectCode(l.getInventory('a1', 'nowhere', 'ore'), 'invalid_amount');
        await expectCode(l.getInventory('a1', 'alpha', 'nothing'), 'invalid_amount');
        await expectCode(l.getPolicy('nowhere'), 'invalid_amount');
      });
    });

    describe('transfer, produce, consume', () => {
      it('transfers between agents and treasuries', async () => {
        const l = await mk();
        await l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: 2_500 });
        await l.transfer({ from: 'a2', to: 'alpha', currency: 'ALP', amount: 100 });
        await l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: 0 });
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 2_500);
        expect(await l.getPurse('a2', 'ALP')).toBe(WEALTH + 2_400);
        expect(await l.getPurse('alpha', 'ALP')).toBe(1_100);
        await inv(l);
      });

      it('insufficient_funds leaves balances untouched; bad amounts are invalid_amount', async () => {
        const l = await mk();
        await expectCode(l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: WEALTH + 1 }), 'insufficient_funds');
        await expectCode(l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: -1 }), 'invalid_amount');
        await expectCode(l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: 0.5 }), 'invalid_amount');
        await expectCode(l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: Number.NaN }), 'invalid_amount');
        await expectCode(l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: Number.MAX_SAFE_INTEGER + 2 }), 'invalid_amount');
        await expectCode(l.transfer({ from: 'a1', to: 'a2', currency: 'XXX', amount: 1 }), 'invalid_amount');
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        expect(await l.getPurse('a2', 'ALP')).toBe(WEALTH);
        await inv(l);
      });

      it('produce consumes inputs and creates outputs atomically', async () => {
        const l = await mk();
        await l.produce({ owner: 'a1', planet: 'alpha', inputs: [{ good: 'ore', qty: 40 }], outputs: [{ good: 'grain', qty: 20 }] });
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(60);
        expect(await l.getInventory('a1', 'alpha', 'grain')).toBe(120);
        // outputs on a planet where the owner has nothing; no inputs needed
        await l.produce({ owner: 'a1', planet: 'beta', inputs: [], outputs: [{ good: 'ore', qty: 7 }] });
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(7);
        await inv(l);
      });

      it('produce with short inputs fails with insufficient_inventory and changes nothing', async () => {
        const l = await mk();
        const bad = [{ good: 'ore', qty: 50 }, { good: 'ore', qty: 51 }]; // duplicates are aggregated: 101 > 100
        await expectCode(l.produce({ owner: 'a1', planet: 'alpha', inputs: bad, outputs: [{ good: 'grain', qty: 5 }] }), 'insufficient_inventory');
        await expectCode(l.produce({ owner: 'a1', planet: 'beta', inputs: [{ good: 'ore', qty: 1 }], outputs: [] }), 'insufficient_inventory');
        await expectCode(l.produce({ owner: 'a1', planet: 'alpha', inputs: [], outputs: [{ good: 'grain', qty: 0 }] }), 'invalid_amount');
        await expectCode(l.produce({ owner: 'a1', planet: 'alpha', inputs: [{ good: 'nothing', qty: 1 }], outputs: [] }), 'invalid_amount');
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        expect(await l.getInventory('a1', 'alpha', 'grain')).toBe(100);
        await inv(l);
      });

      it('consume destroys goods; short stock fails atomically', async () => {
        const l = await mk();
        await l.consume({ owner: 'a1', planet: 'alpha', cargo: [{ good: 'ore', qty: 30 }, { good: 'grain', qty: 100 }] });
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(70);
        expect(await l.getInventory('a1', 'alpha', 'grain')).toBe(0);
        expect((await l.checkInvariants()).totals.goods).toEqual({ ore: 270, grain: 200 });
        await expectCode(l.consume({ owner: 'a1', planet: 'alpha', cargo: [{ good: 'ore', qty: 10 }, { good: 'grain', qty: 1 }] }), 'insufficient_inventory');
        await expectCode(l.consume({ owner: 'a1', planet: 'alpha', cargo: [{ good: 'ore', qty: -1 }] }), 'invalid_amount');
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(70);
        await inv(l);
      });
    });

    describe('local orders', () => {
      it('escrows funds for buys and goods for sells', async () => {
        const l = await mk();
        const ids = await place(l, [order('a1', 'buy', 5, 12), order('a1', 'sell', 30, 20)]);
        expect(new Set(ids).size).toBe(2);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 60);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(70);
        // a sell escrows only the good on that planet
        expect(await l.getPurse('a1', 'BET')).toBe(WEALTH);
        await inv(l);
      });

      it('buys escrow the currency of the order planet', async () => {
        const l = await mk();
        await l.produce({ owner: 'a1', planet: 'beta', inputs: [], outputs: [{ good: 'ore', qty: 5 }] });
        await place(l, [order('a1', 'buy', 2, 50, 'beta'), order('a1', 'sell', 5, 50, 'beta')]);
        expect(await l.getPurse('a1', 'BET')).toBe(WEALTH - 100);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(0);
        await inv(l);
      });

      it('validates each order independently and reports rejects by index without throwing', async () => {
        const l = await mk();
        const r = await l.placeOrders([
          order('a1', 'buy', 1, 10), // ok
          order('a1', 'buy', 0, 10), // zero qty
          order('a1', 'buy', 1, -1), // negative price
          order('a1', 'buy', 1, 1.5), // fractional price
          order('a1', 'buy', WEALTH + 1, 1), // insufficient funds
          order('a1', 'sell', 101, 1), // insufficient inventory
          order('a1', 'sell', 1, 10, 'nowhere'), // unknown planet
          order('a1', 'sell', 1, 10, 'alpha', 'nothing'), // unknown good
          order('a1', 'sell', 100, 10), // ok, uses the full stock
          order('a1', 'sell', 1, 10), // now short: earlier escrow counts
          order('a1', 'buy', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), // product overflows
        ], 1);
        expect(r.accepted.map((a) => a.index)).toEqual([0, 8]);
        expect(r.rejected.map((x) => [x.index, x.error.code])).toEqual([
          [1, 'invalid_amount'], [2, 'invalid_amount'], [3, 'invalid_amount'], [4, 'insufficient_funds'], [5, 'insufficient_inventory'],
          [6, 'invalid_amount'], [7, 'invalid_amount'], [9, 'insufficient_inventory'], [10, 'invalid_amount'],
        ]);
        expect((await l.openOrders('a1')).length).toBe(2);
        await inv(l);
      });

      it('cancel refunds the remaining escrow; a second cancel is unknown_order', async () => {
        const l = await mk();
        const [b, s] = await place(l, [order('a1', 'buy', 5, 12), order('a1', 'sell', 30, 20)]);
        await l.cancelOrder(b!);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        await l.cancelOrder(s!);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        expect(await l.openOrders('a1')).toEqual([]);
        await expectCode(l.cancelOrder(b!), 'unknown_order');
        await expectCode(l.cancelOrder('nope'), 'unknown_order');
        await inv(l);
      });

      it('cancelling a partially filled order refunds only what remains', async () => {
        const l = await mk();
        const [b] = await place(l, [order('a1', 'buy', 10, 20)]);
        await place(l, [order('a2', 'sell', 4, 10)]);
        await l.clearLocalAuction('alpha', 'ore', 1); // 4 @ 10 (buyer's 20 only needed for escrow)
        await l.cancelOrder(b!);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 40);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(104);
        await inv(l);
      });

      it('openOrders lists remaining qty ordered by placement, only for that agent', async () => {
        const l = await mk();
        await place(l, [order('a1', 'sell', 5, 30), order('a2', 'buy', 1, 1), order('a1', 'buy', 3, 4, 'beta', 'grain'), order('a1', 'sell', 2, 9)], 4);
        const open = await l.openOrders('a1');
        expect(open.map((o) => [o.side, o.qty, o.limitPrice, o.planet, o.good, o.cycle])).toEqual([
          ['sell', 5, 30, 'alpha', 'ore', 4], ['buy', 3, 4, 'beta', 'grain', 4], ['sell', 2, 9, 'alpha', 'ore', 4],
        ]);
        expect(open.every((o) => o.agentId === 'a1' && typeof o.orderId === 'string')).toBe(true);
        expect(await l.openOrders('a3')).toEqual([]);
      });
    });

    describe('local auction', () => {
      it('returns a null price and no fills for an empty or non-crossing book', async () => {
        const l = await mk();
        expect(await l.clearLocalAuction('alpha', 'ore', 1)).toEqual({ planet: 'alpha', good: 'ore', cycle: 1, clearingPrice: null, volume: 0, fills: [] });
        await place(l, [order('a1', 'buy', 5, 5), order('a2', 'sell', 5, 6)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 2);
        expect(r.clearingPrice).toBeNull();
        expect(r.volume).toBe(0);
        expect(r.fills).toEqual([]);
        expect(await l.openOrders('a1')).toHaveLength(1);
        expect(await l.openOrders('a2')).toHaveLength(1);
        await inv(l);
      });

      it('rejects unknown planet/good in clearLocalAuction', async () => {
        const l = await mk();
        await expectCode(l.clearLocalAuction('nowhere', 'ore', 1), 'invalid_amount');
        await expectCode(l.clearLocalAuction('alpha', 'nothing', 1), 'invalid_amount');
      });

      it('clears at a uniform price, refunding price improvement, and reports fills', async () => {
        const l = await mk();
        const [b] = await place(l, [order('a1', 'buy', 10, 20)]);
        const [s] = await place(l, [order('a2', 'sell', 10, 10)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 3);
        // candidates 10 and 20: both give V=10 with imbalance 0, lowest wins
        expect(r).toMatchObject({ planet: 'alpha', good: 'ore', cycle: 3, clearingPrice: 10, volume: 10 });
        expect(r.fills).toEqual([
          { orderId: b, agentId: 'a1', good: 'ore', side: 'buy', qty: 10, price: 10, total: 100 },
          { orderId: s, agentId: 'a2', good: 'ore', side: 'sell', qty: 10, price: 10, total: 100 },
        ]);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 100);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(110);
        expect(await l.getPurse('a2', 'ALP')).toBe(WEALTH + 100);
        expect(await l.getInventory('a2', 'alpha', 'ore')).toBe(90);
        expect(await l.openOrders('a1')).toEqual([]);
        expect(await l.openOrders('a2')).toEqual([]);
        await inv(l);
      });

      it('picks the volume-maximising price; ties go to the lowest price when equally balanced', async () => {
        const l = await mk();
        // candidates 6,8,9,10 -> V = 4,4,5,5 ; |D-S| = 6,6,3,3 -> price 9
        await place(l, [order('a1', 'buy', 5, 10), order('a2', 'buy', 5, 8), order('a3', 'sell', 4, 6), order('a3', 'sell', 4, 9)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r.clearingPrice).toBe(9);
        expect(r.volume).toBe(5);
        // buys by limit desc: a1 5 @ 9 (refund 5); sells by limit asc: first sell 4, second sell 1
        expect(r.fills.map((f) => [f.agentId, f.side, f.qty])).toEqual([['a1', 'buy', 5], ['a3', 'sell', 4], ['a3', 'sell', 1]]);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 45);
        expect(await l.getPurse('a2', 'ALP')).toBe(WEALTH - 40); // untouched buy still escrowed
        expect((await l.openOrders('a3')).map((o) => [o.qty, o.limitPrice])).toEqual([[3, 9]]); // remainder keeps resting
        await inv(l);
      });

      it('equal volume: the smaller imbalance beats a lower price', async () => {
        const l = await mk();
        // p=4: D=4,S=2 ; p=6: D=4,S=2 ; p=8: D=2,S=3 ; p=10: D=2,S=3 -> V=2 everywhere, gap 2,2,1,1 -> 8
        await place(l, [order('a1', 'buy', 2, 10), order('a2', 'buy', 2, 6), order('a3', 'sell', 2, 4), order('a3', 'sell', 1, 8)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r.clearingPrice).toBe(8);
        expect(r.volume).toBe(2);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 16);
        expect(await l.getPurse('a3', 'ALP')).toBe(WEALTH + 16);
        expect((await l.openOrders('a2')).map((o) => o.qty)).toEqual([2]);
        expect((await l.openOrders('a3')).map((o) => [o.limitPrice, o.qty])).toEqual([[8, 1]]);
        await inv(l);
      });

      it('rations the long buy side by limit price, then time', async () => {
        const l = await mk();
        const [b1, b2, b3] = await place(l, [order('a1', 'buy', 3, 10), order('a2', 'buy', 3, 10), order('a3', 'buy', 3, 12)]);
        await place(l, [order('a3', 'sell', 4, 5)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r.clearingPrice).toBe(5);
        expect(r.volume).toBe(4);
        const buys = r.fills.filter((f) => f.side === 'buy').map((f) => [f.orderId, f.qty]);
        expect(buys).toEqual([[b3, 3], [b1, 1]]); // b3 has the best limit, b1 beats b2 on time; b2 gets nothing
        expect(r.fills.find((f) => f.orderId === b2)).toBeUndefined();
        expect((await l.openOrders('a1'))[0]).toMatchObject({ orderId: b1, qty: 2 });
        expect((await l.openOrders('a2'))[0]).toMatchObject({ orderId: b2, qty: 3 });
        expect(await l.openOrders('a3')).toEqual([]); // a3's b3 buy and its 4-unit sell both filled completely
        await inv(l);
      });

      it('rations the long sell side by lowest limit, then time', async () => {
        const l = await mk();
        const [s1, s2, s3] = await place(l, [order('a1', 'sell', 3, 8), order('a2', 'sell', 3, 8), order('a3', 'sell', 3, 6)]);
        await place(l, [order('a3', 'buy', 5, 9)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r.clearingPrice).toBe(8); // p=6: V=3 ; p=8 and p=9: V=5 with D=5,S=9 (equal gap) -> lowest, 8
        expect(r.fills.filter((f) => f.side === 'sell').map((f) => [f.orderId, f.qty])).toEqual([[s3, 3], [s1, 2]]);
        expect(r.fills.find((f) => f.orderId === s2)).toBeUndefined();
        expect(await l.getInventory('a3', 'alpha', 'ore')).toBe(100 - 3 + 5);
        await inv(l);
      });

      it('orders rest across cycles and fill later; only the requested planet/good is cleared', async () => {
        const l = await mk();
        await place(l, [order('a1', 'buy', 5, 10), order('a1', 'buy', 5, 10, 'alpha', 'grain')], 1);
        expect((await l.clearLocalAuction('alpha', 'ore', 1)).clearingPrice).toBeNull();
        await place(l, [order('a2', 'sell', 5, 10), order('a2', 'sell', 5, 10, 'alpha', 'grain')], 2);
        const r = await l.clearLocalAuction('alpha', 'ore', 2);
        expect(r.volume).toBe(5);
        expect(await l.getInventory('a1', 'alpha', 'grain')).toBe(100); // grain book untouched
        expect(await l.openOrders('a1')).toHaveLength(1);
        expect((await l.clearLocalAuction('alpha', 'grain', 2)).clearingPrice).toBe(10);
        await inv(l);
      });

      it('goods are delivered on the planet where the order rests', async () => {
        const l = await mk();
        await l.produce({ owner: 'a2', planet: 'beta', inputs: [], outputs: [{ good: 'ore', qty: 3 }] });
        await place(l, [order('a1', 'buy', 3, 7, 'beta'), order('a2', 'sell', 3, 7, 'beta')]);
        const r = await l.clearLocalAuction('beta', 'ore', 1);
        expect(r.clearingPrice).toBe(7);
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(3);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        expect(await l.getPurse('a2', 'BET')).toBe(WEALTH + 21);
        await inv(l);
      });

      it('a zero-priced cross clears at 0 for free', async () => {
        const l = await mk();
        await place(l, [order('a1', 'buy', 2, 0), order('a2', 'sell', 2, 0)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r).toMatchObject({ clearingPrice: 0, volume: 2 });
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(102);
        await inv(l);
      });

      it('a self-trade settles cleanly', async () => {
        const l = await mk();
        await place(l, [order('a1', 'buy', 4, 10), order('a1', 'sell', 4, 6)]);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r.volume).toBe(4);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        await inv(l);
      });

      it('handles large quantities without losing precision', async () => {
        const l = await makeLedger(TINY);
        const big = 2 ** 40;
        await l.openAccount({ owner: 'rich', planet: 'alpha', purse: { ALP: 2 ** 52 } });
        await l.openAccount({ owner: 'miner', planet: 'alpha', inventory: { ore: big } });
        await l.placeOrders([order('rich', 'buy', big, 2 ** 11), order('miner', 'sell', big, 3)], 1);
        const r = await l.clearLocalAuction('alpha', 'ore', 1);
        expect(r.clearingPrice).toBe(3);
        expect(await l.getPurse('miner', 'ALP')).toBe(big * 3);
        expect(await l.getPurse('rich', 'ALP')).toBe(2 ** 52 - big * 3);
        await inv(l);
      });
    });

    describe('fx auction', () => {
      const fx = (agentId: string, give: string, giveAmount: number, want: string, minReceive: number) => ({ agentId, give, giveAmount, want, minReceive });

      it('validates orders individually', async () => {
        const l = await mk();
        const r = await l.placeFxOrders([
          fx('a1', 'ALP', 10, 'BET', 10), // ok
          fx('a1', 'ALP', 10, 'ALP', 10), // give == want
          fx('a1', 'ALP', 0, 'BET', 1), // zero amount
          fx('a1', 'ALP', 1.5, 'BET', 1), // fractional
          fx('a1', 'ALP', 1, 'BET', -1), // negative min
          fx('a1', 'XXX', 1, 'BET', 1), // unknown currency
          fx('a1', 'ALP', WEALTH, 'BET', 1), // only 9_990 left
        ], 1);
        expect(r.accepted.map((a) => a.index)).toEqual([0]);
        expect(r.rejected.map((x) => [x.index, x.error.code])).toEqual([
          [1, 'invalid_amount'], [2, 'invalid_amount'], [3, 'invalid_amount'], [4, 'invalid_amount'], [5, 'invalid_amount'], [6, 'insufficient_funds'],
        ]);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 10);
        await inv(l);
      });

      it('FX order ids are distinct from local order ids', async () => {
        const l = await mk();
        const [o] = await place(l, [order('a1', 'buy', 1, 1)]);
        const r = await l.placeFxOrders([fx('a1', 'ALP', 1, 'BET', 1)], 1);
        expect(r.accepted[0]!.orderId).not.toBe(o);
        expect(await l.openOrders('a1')).toHaveLength(1); // FX orders are not listed by openOrders
      });

      it('clears at the rate where supply and demand balance', async () => {
        const l = await mk();
        // seller limit 2.0, buyer limit 3.0 -> at 3.0: S=100, D=100
        const r = await l.placeFxOrders([fx('a1', 'ALP', 100, 'BET', 200), fx('a2', 'BET', 300, 'ALP', 100)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        expect(res).toMatchObject({ base: 'ALP', quote: 'BET', cycle: 1, ratePpm: 3_000_000 });
        expect(res.fills).toEqual([
          { orderId: r.accepted[0]!.orderId, agentId: 'a1', give: 'ALP', giveAmount: 100, want: 'BET', receiveAmount: 300 },
          { orderId: r.accepted[1]!.orderId, agentId: 'a2', give: 'BET', giveAmount: 300, want: 'ALP', receiveAmount: 100 },
        ]);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 100);
        expect(await l.getPurse('a1', 'BET')).toBe(WEALTH + 300);
        expect(await l.getPurse('a2', 'ALP')).toBe(WEALTH + 100);
        expect(await l.getPurse('a2', 'BET')).toBe(WEALTH - 300);
        await inv(l);
      });

      it('picks the lowest rate when both sides are equally balanced and refunds unfilled remainders', async () => {
        const l = await mk();
        // seller limit 1.0 gives 100 ALP ; buyer limit 1.0 gives 40 BET -> V=40 at r=1.0
        await l.placeFxOrders([fx('a1', 'ALP', 100, 'BET', 100), fx('a2', 'BET', 40, 'ALP', 40)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        expect(res.ratePpm).toBe(1_000_000);
        expect(res.fills.map((f) => [f.agentId, f.giveAmount, f.receiveAmount])).toEqual([['a1', 40, 40], ['a2', 40, 40]]);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 40); // 60 refunded
        expect(await l.getPurse('a1', 'BET')).toBe(WEALTH + 40);
        await inv(l);
        // IOC: both orders are gone, nothing left to clear or cancel
        expect((await l.clearFxAuction('ALP', 'BET', 2)).ratePpm).toBeNull();
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH - 40);
      });

      it('no crossing: null rate, every escrow refunded, orders removed', async () => {
        const l = await mk();
        const r = await l.placeFxOrders([fx('a1', 'ALP', 100, 'BET', 300), fx('a2', 'BET', 100, 'ALP', 100)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        expect(res.ratePpm).toBeNull();
        expect(res.fills).toEqual([]);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        expect(await l.getPurse('a2', 'BET')).toBe(WEALTH);
        await expectCode(l.cancelOrder(r.accepted[0]!.orderId), 'unknown_order');
        await inv(l);
      });

      it('rounds sellers down and buyers up; the quote dust goes to the quote planet treasury', async () => {
        const l = await mk();
        // seller limit ceil(1e6/3)=333_334 ; buyer limit floor(10e6/3)=3_333_333 -> r=3_333_333
        await l.placeFxOrders([fx('a1', 'ALP', 3, 'BET', 1), fx('a2', 'BET', 10, 'ALP', 3)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        expect(res.ratePpm).toBe(3_333_333);
        expect(res.fills.map((f) => [f.agentId, f.giveAmount, f.receiveAmount])).toEqual([['a1', 3, 9], ['a2', 10, 3]]); // floor(9.99..)=9, ceil=10
        expect(await l.getPurse('beta', 'BET')).toBe(1_001); // dust of 1
        expect(await l.getPurse('alpha', 'ALP')).toBe(1_000);
        await inv(l);
      });

      it('rations the long side by limit rate then time; unmatched orders are refunded', async () => {
        const l = await mk();
        // buyer limits: a1 5.0, a2 3.0 ; seller (limit 1.0) gives 10 ALP.
        const r = await l.placeFxOrders([fx('a3', 'ALP', 10, 'BET', 10), fx('a2', 'BET', 30, 'ALP', 10), fx('a1', 'BET', 50, 'ALP', 10)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        // r=1e6: D=30+50=80 >S=10 -> V=10 gap70 ; r=3e6: D=10+16=26 ->V10 gap16 ; r=5e6: D=10, S=10 gap0 -> 5.0
        expect(res.ratePpm).toBe(5_000_000);
        expect(res.fills).toEqual([
          { orderId: r.accepted[0]!.orderId, agentId: 'a3', give: 'ALP', giveAmount: 10, want: 'BET', receiveAmount: 50 },
          { orderId: r.accepted[2]!.orderId, agentId: 'a1', give: 'BET', giveAmount: 50, want: 'ALP', receiveAmount: 10 },
        ]);
        expect(await l.getPurse('a2', 'BET')).toBe(WEALTH); // never matched, fully refunded
        await inv(l);
      });

      it('only the requested pair is cleared and direction determines who is the base seller', async () => {
        const l = await mk();
        const r = await l.placeFxOrders([fx('a1', 'ALP', 10, 'GAM', 10), fx('a2', 'GAM', 10, 'ALP', 10), fx('a1', 'BET', 10, 'ALP', 10), fx('a2', 'ALP', 10, 'BET', 10)], 1);
        const res = await l.clearFxAuction('GAM', 'ALP', 1); // GAM is the base here
        expect(res.ratePpm).toBe(1_000_000);
        expect(res.fills.map((f) => f.agentId).sort()).toEqual(['a1', 'a2']);
        expect(res.fills.find((f) => f.give === 'GAM')!.orderId).toBe(r.accepted[1]!.orderId);
        await l.cancelOrder(r.accepted[2]!.orderId); // the BET/ALP orders still rest
        await l.cancelOrder(r.accepted[3]!.orderId);
        await inv(l);
      });

      it('an uncapped buyer (minReceive 0) buys at any candidate rate', async () => {
        const l = await mk();
        await l.placeFxOrders([fx('a1', 'ALP', 10, 'BET', 20), fx('a2', 'BET', 100, 'ALP', 0)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        expect(res.ratePpm).toBe(2_000_000);
        expect(res.fills.map((f) => [f.agentId, f.giveAmount, f.receiveAmount])).toEqual([['a1', 10, 20], ['a2', 20, 10]]);
        expect(await l.getPurse('a2', 'BET')).toBe(WEALTH - 20); // surplus escrow refunded
        await inv(l);
      });

      it('rejects bad pairs; a seller only guarantees the rate, not the exact minReceive', async () => {
        const l = await mk();
        await expectCode(l.clearFxAuction('ALP', 'ALP', 1), 'invalid_amount');
        await expectCode(l.clearFxAuction('ALP', 'XXX', 1), 'invalid_amount');
        // seller limit ceil(5e6/3) = 1_666_667 (>= 5/3): at that rate 3 base receives floor(3*1.666667)=5 ...
        await l.placeFxOrders([fx('a1', 'ALP', 3, 'BET', 5), fx('a2', 'BET', 100, 'ALP', 50)], 1);
        const res = await l.clearFxAuction('ALP', 'BET', 1);
        expect(res.ratePpm).not.toBeNull();
        expect(res.ratePpm!).toBeGreaterThanOrEqual(1_666_667);
        await inv(l);
      });

      it('cancelling an FX order refunds its escrow', async () => {
        const l = await mk();
        const r = await l.placeFxOrders([fx('a1', 'ALP', 10, 'BET', 10)], 1);
        await l.cancelOrder(r.accepted[0]!.orderId);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        await inv(l);
      });
    });

    describe('shipping', () => {
      const cargo = (qty: number, good = 'ore'): Cargo[] => [{ good, qty }];
      const depart = (l: Ledger, qty = 10, owner = 'a1', from = 'alpha', to = 'beta', cycle = 1, arriveCycle = 3) =>
        l.depart({ owner, from, to, cargo: cargo(qty), cycle, arriveCycle });

      it('depart moves cargo into flight and records the shipment', async () => {
        const l = await mk();
        const s = await depart(l);
        expect(s).toMatchObject({ owner: 'a1', from: 'alpha', to: 'beta', cargo: cargo(10), departCycle: 1, arriveCycle: 3, status: 'in_flight' });
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(90);
        expect((await l.checkInvariants()).totals.goods.ore).toBe(300); // in-flight cargo counts
        await inv(l);
      });

      it('validates departures', async () => {
        const l = await mk();
        await expectCode(depart(l, 101), 'insufficient_inventory');
        await expectCode(depart(l, 10, 'a1', 'alpha', 'alpha'), 'invalid_amount');
        await expectCode(depart(l, 10, 'a1', 'alpha', 'beta', 5, 5), 'invalid_amount');
        await expectCode(depart(l, 10, 'a1', 'alpha', 'beta', 5, 4), 'invalid_amount');
        await expectCode(depart(l, 10, 'a1', 'alpha', 'nowhere'), 'invalid_amount');
        await expectCode(depart(l, 0), 'invalid_amount');
        await expectCode(l.depart({ owner: 'a1', from: 'alpha', to: 'beta', cargo: [], cycle: 1, arriveCycle: 2 }), 'invalid_amount');
        await expectCode(depart(l, 10, 'a1', 'beta', 'gamma'), 'insufficient_inventory'); // owner holds nothing on beta
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        await inv(l);
      });

      it('arrival delivers cargo to the owner on the destination', async () => {
        const l = await mk();
        const s = await depart(l);
        const r = await l.arrive(s.id, 3);
        expect(r.delivered).toEqual(cargo(10));
        expect(r.withheld).toEqual([]);
        expect(r.duty).toEqual({ currency: 'BET', amount: 0 });
        expect(r.shipment).toMatchObject({ id: s.id, status: 'arrived' });
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(10);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(90);
        await inv(l);
        await l.arrive((await depart(l, 5)).id, 9); // late arrival is fine
      });

      it('arrive errors: unknown shipment, too early, already arrived', async () => {
        const l = await mk();
        const s = await depart(l);
        await expectCode(l.arrive('nope', 3), 'unknown_shipment');
        await expectCode(l.arrive(s.id, 2), 'invalid_state');
        await l.arrive(s.id, 3);
        await expectCode(l.arrive(s.id, 4), 'invalid_state');
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(10);
        await inv(l);
      });

      it('an embargo on the origin withholds everything back to the origin planet', async () => {
        const l = await mk();
        const s = await l.depart({ owner: 'a1', from: 'alpha', to: 'beta', cargo: [{ good: 'ore', qty: 10 }, { good: 'grain', qty: 5 }], cycle: 1, arriveCycle: 2 });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'alpha', active: true });
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 5000 });
        const r = await l.arrive(s.id, 2);
        expect(r.delivered).toEqual([]);
        expect(r.withheld).toEqual([{ good: 'ore', qty: 10 }, { good: 'grain', qty: 5 }]);
        expect(r.duty.amount).toBe(0);
        expect(await l.getInventory('a1', 'alpha', 'ore')).toBe(100);
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(0);
        await inv(l);
      });

      it('embargo is checked on arrival only; other embargoes do not matter', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'alpha', active: true });
        const s1 = await depart(l, 5); // allowed at departure
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'alpha', active: false });
        expect((await l.arrive(s1.id, 3)).delivered).toEqual(cargo(5)); // lifted before arrival
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'gamma', active: true });
        expect((await l.arrive((await depart(l, 5)).id, 3)).delivered).toEqual(cargo(5));
        await l.applyPolicy({ kind: 'set_embargo', planet: 'alpha', target: 'beta', active: true }); // wrong direction
        expect((await l.arrive((await depart(l, 5)).id, 3)).delivered).toEqual(cargo(5));
        await inv(l);
      });

      it('quota caps units per good per destination per cycle across shipments', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_quota', planet: 'beta', good: 'ore', maxPerCycle: 8 });
        const [a, b, c, d] = [await depart(l, 5), await depart(l, 5, 'a2'), await depart(l, 5, 'a3'), await depart(l, 5)];
        const r1 = await l.arrive(a.id, 3);
        expect([r1.delivered, r1.withheld]).toEqual([cargo(5), []]);
        const r2 = await l.arrive(b.id, 3);
        expect([r2.delivered, r2.withheld]).toEqual([cargo(3), cargo(2)]);
        const r3 = await l.arrive(c.id, 3);
        expect([r3.delivered, r3.withheld]).toEqual([[], cargo(5)]);
        expect(await l.getInventory('a2', 'beta', 'ore')).toBe(3);
        expect(await l.getInventory('a3', 'beta', 'ore')).toBe(0);
        expect(await l.getInventory('a3', 'alpha', 'ore')).toBe(100); // withheld goods go home
        const r4 = await l.arrive(d.id, 4); // new cycle, fresh allowance
        expect(r4.delivered).toEqual(cargo(5));
        await inv(l);
      });

      it('quota 0 blocks a good; other goods are unaffected', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_quota', planet: 'beta', good: 'grain', maxPerCycle: 0 });
        const s = await l.depart({ owner: 'a1', from: 'alpha', to: 'beta', cargo: [{ good: 'ore', qty: 3 }, { good: 'grain', qty: 4 }], cycle: 1, arriveCycle: 2 });
        const r = await l.arrive(s.id, 2);
        expect(r.delivered).toEqual(cargo(3));
        expect(r.withheld).toEqual(cargo(4, 'grain'));
        await inv(l);
      });

      it('collects tariffs from the owner into the destination treasury using the base price', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 1_000 }); // 10% of 10 * 10 units
        const r = await l.arrive((await depart(l, 10)).id, 3);
        expect(r.duty).toEqual({ currency: 'BET', amount: 10 });
        expect(await l.getPurse('a1', 'BET')).toBe(WEALTH - 10);
        expect(await l.getPurse('beta', 'BET')).toBe(1_010);
        await inv(l);
      });

      it('tariff duty rounds down per good and uses the last non-null local clearing price', async () => {
        const l = await mk();
        await l.produce({ owner: 'a2', planet: 'beta', inputs: [], outputs: [{ good: 'ore', qty: 5 }] });
        await place(l, [order('a1', 'buy', 5, 40, 'beta'), order('a2', 'sell', 5, 40, 'beta')]);
        expect((await l.clearLocalAuction('beta', 'ore', 1)).clearingPrice).toBe(40);
        await place(l, [order('a1', 'buy', 1, 1, 'beta')], 2);
        expect((await l.clearLocalAuction('beta', 'ore', 2)).clearingPrice).toBeNull(); // does not overwrite the last price
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 333 });
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'grain', rateBp: 10_000 });
        const s = await l.depart({ owner: 'a3', from: 'alpha', to: 'beta', cargo: [{ good: 'ore', qty: 7 }, { good: 'grain', qty: 2 }], cycle: 3, arriveCycle: 3 + 1 });
        const r = await l.arrive(s.id, 4);
        // ore: floor(7*40*333/10000) = 9 ; grain: base price 5 -> 2*5*100% = 10
        expect(r.duty.amount).toBe(19);
        await inv(l);
      });

      it('the duty is capped by the owner purse and not charged on withheld cargo', async () => {
        const l = await mk();
        await l.transfer({ from: 'a1', to: 'a2', currency: 'BET', amount: WEALTH - 4 });
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 10_000 });
        const r = await l.arrive((await depart(l, 10)).id, 3); // owes 100, holds 4
        expect(r.delivered).toEqual(cargo(10));
        expect(r.duty.amount).toBe(4);
        expect(await l.getPurse('a1', 'BET')).toBe(0);
        await l.applyPolicy({ kind: 'set_quota', planet: 'beta', good: 'ore', maxPerCycle: 0 });
        expect((await l.arrive((await depart(l, 10)).id, 3)).duty.amount).toBe(0);
        await inv(l);
      });

      it('a tariff needs the destination treasury account to exist (unknown_account, nothing changes)', async () => {
        const l = await mk({ treasuries: false });
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 1_000 });
        const s = await depart(l, 10);
        await expectCode(l.arrive(s.id, 3), 'unknown_account');
        expect(await l.getInventory('a1', 'beta', 'ore')).toBe(0);
        await l.openAccount({ owner: 'beta', planet: 'beta' });
        expect((await l.arrive(s.id, 3)).duty.amount).toBe(10);
        await inv(l);
      });
    });

    describe('credit', () => {
      const loanReq = (borrower = 'a1', amount = 10_000, planet = 'alpha', termCycles = 10, cycle = 0) => ({ borrower, planet, amount, termCycles, cycle });

      it('borrow mints the planet currency and snapshots the policy rate', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_policy_rate', planet: 'alpha', rateBp: 100 });
        const before = (await l.checkInvariants()).totals.currency;
        const loan = await l.borrow(loanReq('a1', 10_000, 'alpha', 10, 2));
        expect(loan).toMatchObject({ borrower: 'a1', planet: 'alpha', currency: 'ALP', principal: 10_000, outstanding: 10_000, rateBp: 100, issuedCycle: 2, dueCycle: 12 });
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH + 10_000);
        const after = (await l.checkInvariants()).totals.currency;
        expect(after.ALP).toBe(before.ALP! + 10_000);
        expect(after.BET).toBe(before.BET);
        await l.applyPolicy({ kind: 'set_policy_rate', planet: 'alpha', rateBp: 500 });
        expect((await l.borrow(loanReq('a2'))).rateBp).toBe(500);
        await inv(l);
      });

      it('rejects bad borrow requests', async () => {
        const l = await mk();
        await expectCode(l.borrow(loanReq('a1', 0)), 'invalid_amount');
        await expectCode(l.borrow(loanReq('a1', -5)), 'invalid_amount');
        await expectCode(l.borrow(loanReq('a1', 1.5)), 'invalid_amount');
        await expectCode(l.borrow(loanReq('a1', 10, 'nowhere')), 'invalid_amount');
        await expectCode(l.borrow(loanReq('a1', 10, 'alpha', 0)), 'invalid_amount');
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        await inv(l);
      });

      it('loan ids are distinct', async () => {
        const l = await mk();
        expect((await l.borrow(loanReq())).id).not.toBe((await l.borrow(loanReq())).id);
      });

      it('repay accrues simple interest on principal since the last accrual, then burns the payment', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_policy_rate', planet: 'alpha', rateBp: 100 }); // 1% per cycle
        const loan = await l.borrow(loanReq());
        const r1 = await l.repay({ loanId: loan.id, amount: 500, cycle: 5 }); // +500 interest, pay 500
        expect(r1.outstanding).toBe(10_000);
        expect(r1.principal).toBe(10_000);
        const r2 = await l.repay({ loanId: loan.id, amount: 100, cycle: 7 }); // +200 interest, pay 100
        expect(r2.outstanding).toBe(10_100);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH + 10_000 - 600);
        const t = (await l.checkInvariants()).totals.currency;
        expect(t.ALP).toBe(1_000 + 3 * WEALTH + 10_000 - 600); // burned payments leave the supply
        await inv(l);
      });

      it('interest is floored', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_policy_rate', planet: 'alpha', rateBp: 33 });
        const loan = await l.borrow(loanReq('a1', 1_000));
        expect((await l.repay({ loanId: loan.id, amount: 1, cycle: 1 })).outstanding).toBe(1_002); // floor(3.3)=3, minus 1
      });

      it('an overpayment pays only what is owed; a settled loan cannot be repaid again', async () => {
        const l = await mk();
        const loan = await l.borrow(loanReq('a1', 1_000));
        const r = await l.repay({ loanId: loan.id, amount: 5_000, cycle: 1 });
        expect(r.outstanding).toBe(0);
        expect(await l.getPurse('a1', 'ALP')).toBe(WEALTH);
        await expectCode(l.repay({ loanId: loan.id, amount: 1, cycle: 2 }), 'invalid_state');
        await inv(l);
      });

      it('repay errors: unknown loan, bad amount, early cycle, insufficient funds', async () => {
        const l = await mk();
        await expectCode(l.repay({ loanId: 'nope', amount: 1, cycle: 1 }), 'unknown_loan');
        const loan = await l.borrow(loanReq('a1', 1_000, 'alpha', 10, 5));
        await expectCode(l.repay({ loanId: loan.id, amount: 0, cycle: 6 }), 'invalid_amount');
        await expectCode(l.repay({ loanId: loan.id, amount: 1.5, cycle: 6 }), 'invalid_amount');
        await expectCode(l.repay({ loanId: loan.id, amount: 1, cycle: 4 }), 'invalid_state');
        await l.transfer({ from: 'a1', to: 'a2', currency: 'ALP', amount: WEALTH + 1_000 });
        await expectCode(l.repay({ loanId: loan.id, amount: 1, cycle: 6 }), 'insufficient_funds');
        await l.transfer({ from: 'a2', to: 'a1', currency: 'ALP', amount: 1_000 });
        expect((await l.repay({ loanId: loan.id, amount: 1_000, cycle: 6 })).outstanding).toBe(0);
        await inv(l);
      });
    });

    describe('policy', () => {
      it('defaults to an empty policy and returns copies', async () => {
        const l = await mk();
        expect(await l.getPolicy('alpha')).toEqual({ tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 });
        const p = await l.getPolicy('alpha');
        p.tariffsBp.ore = 1;
        p.embargoes.push('beta');
        expect(await l.getPolicy('alpha')).toEqual({ tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 });
      });

      it('sets tariffs (0 deletes), quotas, embargoes (sorted, no duplicates) and the policy rate per planet', async () => {
        const l = await mk();
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 250 });
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'grain', rateBp: 10_000 });
        await l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'grain', rateBp: 0 });
        await l.applyPolicy({ kind: 'set_quota', planet: 'beta', good: 'ore', maxPerCycle: 12 });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'gamma', active: true });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'alpha', active: true });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'gamma', active: true });
        await l.applyPolicy({ kind: 'set_policy_rate', planet: 'beta', rateBp: 75 });
        expect(await l.getPolicy('beta')).toEqual({ tariffsBp: { ore: 250 }, quotas: { ore: 12 }, embargoes: ['alpha', 'gamma'], policyRateBp: 75 });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'alpha', active: false });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'alpha', active: false });
        expect((await l.getPolicy('beta')).embargoes).toEqual(['gamma']);
        expect(await l.getPolicy('alpha')).toEqual({ tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 });
        await inv(l);
      });

      it('rejects invalid instructions with invalid_amount', async () => {
        const l = await mk();
        await expectCode(l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'beta', active: true }), 'invalid_amount');
        await expectCode(l.applyPolicy({ kind: 'set_embargo', planet: 'beta', target: 'nowhere', active: true }), 'invalid_amount');
        await expectCode(l.applyPolicy({ kind: 'set_tariff', planet: 'nowhere', good: 'ore', rateBp: 1 }), 'invalid_amount');
        await expectCode(l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'nothing', rateBp: 1 }), 'invalid_amount');
        await expectCode(l.applyPolicy({ kind: 'set_tariff', planet: 'beta', good: 'ore', rateBp: 10_001 }), 'invalid_amount');
        await expectCode(l.applyPolicy({ kind: 'set_quota', planet: 'beta', good: 'ore', maxPerCycle: -1 }), 'invalid_amount');
        await expectCode(l.applyPolicy({ kind: 'set_policy_rate', planet: 'beta', rateBp: -1 }), 'invalid_amount');
        expect(await l.getPolicy('beta')).toEqual({ tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 });
      });
    });

    describe('invariants and isolation', () => {
      it('reports a clean, consistent state after a mixed sequence of operations', async () => {
        const l = await mk();
        const steps: (() => Promise<unknown>)[] = [
          () => place(l, [order('a1', 'buy', 5, 12), order('a2', 'sell', 8, 9)]),
          () => l.clearLocalAuction('alpha', 'ore', 1),
          () => l.placeFxOrders([{ agentId: 'a1', give: 'ALP', giveAmount: 50, want: 'BET', minReceive: 40 }, { agentId: 'a2', give: 'BET', giveAmount: 80, want: 'ALP', minReceive: 40 }], 1),
          () => l.clearFxAuction('ALP', 'BET', 1),
          () => l.depart({ owner: 'a3', from: 'alpha', to: 'gamma', cargo: [{ good: 'grain', qty: 20 }], cycle: 1, arriveCycle: 2 }),
          () => l.borrow({ borrower: 'a3', planet: 'gamma', amount: 700, termCycles: 4, cycle: 1 }),
          () => l.consume({ owner: 'a2', planet: 'alpha', cargo: [{ good: 'grain', qty: 10 }] }),
        ];
        for (const step of steps) {
          await step();
          await inv(l);
        }
      });

      it('returned objects are copies: mutating them never changes ledger state', async () => {
        const l = await mk();
        await place(l, [order('a1', 'sell', 5, 30)]);
        const open = await l.openOrders('a1');
        open[0]!.qty = 999;
        expect((await l.openOrders('a1'))[0]!.qty).toBe(5);

        const s = await l.depart({ owner: 'a1', from: 'alpha', to: 'beta', cargo: [{ good: 'ore', qty: 4 }], cycle: 1, arriveCycle: 2 });
        s.cargo[0]!.qty = 999;
        s.status = 'arrived';
        const arr = await l.arrive(s.id, 2);
        expect(arr.delivered).toEqual([{ good: 'ore', qty: 4 }]);
        arr.shipment.cargo[0]!.qty = 1;
        arr.delivered[0]!.qty = 1;

        const loan = await l.borrow({ borrower: 'a1', planet: 'alpha', amount: 100, termCycles: 3, cycle: 1 });
        loan.outstanding = 0;
        expect((await l.repay({ loanId: loan.id, amount: 10, cycle: 1 })).outstanding).toBe(90);

        const report = await l.checkInvariants();
        report.totals.currency.ALP = 0;
        report.totals.goods.ore = 0;
        expect((await l.checkInvariants()).totals.goods.ore).toBe(300);
        await inv(l);
      });

      it('is deterministic: replaying the same operations gives identical results', async () => {
        const run = async () => {
          const l = await mk();
          const out: unknown[] = [];
          out.push(await l.placeOrders([order('a1', 'buy', 5, 12), order('a2', 'sell', 8, 9), order('a3', 'buy', 2, 9)], 1));
          out.push(await l.clearLocalAuction('alpha', 'ore', 1));
          out.push(await l.placeFxOrders([{ agentId: 'a1', give: 'ALP', giveAmount: 50, want: 'BET', minReceive: 40 }], 1));
          out.push(await l.clearFxAuction('ALP', 'BET', 1));
          out.push(await l.depart({ owner: 'a3', from: 'alpha', to: 'gamma', cargo: [{ good: 'grain', qty: 20 }], cycle: 1, arriveCycle: 2 }));
          out.push(await l.borrow({ borrower: 'a3', planet: 'gamma', amount: 700, termCycles: 4, cycle: 1 }));
          out.push(await l.checkInvariants());
          return JSON.stringify(out);
        };
        expect(await run()).toBe(await run());
      });
    });

    describe('default world smoke test', () => {
      it('runs trade, FX, shipping, tariffs and credit on DEFAULT_WORLD with invariants intact', async () => {
        const l = await makeLedger(DEFAULT_WORLD);
        for (const p of DEFAULT_WORLD.planets) await l.openAccount({ owner: p.id, planet: p.id, purse: { [p.currency]: p.purses.treasury } });
        await l.openAccount({ owner: 'helion:trader:1', planet: 'helion', purse: { HLX: 10_000, VRD: 5_000, TTH: 500 }, inventory: { iron: 50 } });
        await l.openAccount({ owner: 'helion:colonist:1', planet: 'helion', purse: { HLX: 1_000 } });
        await l.openAccount({ owner: 'verdan:trader:1', planet: 'verdan', purse: { VRD: 10_000, HLX: 2_000 }, inventory: { grain: 40 } });
        await inv(l);

        const placed = await l.placeOrders([
          { agentId: 'helion:trader:1', planet: 'helion', good: 'iron', side: 'sell', qty: 20, limitPrice: 90 },
          { agentId: 'helion:colonist:1', planet: 'helion', good: 'iron', side: 'buy', qty: 5, limitPrice: 120 },
        ], 1);
        expect(placed.rejected).toEqual([]);
        const auction = await l.clearLocalAuction('helion', 'iron', 1);
        expect(auction).toMatchObject({ clearingPrice: 90, volume: 5 });
        await inv(l);

        await l.placeFxOrders([
          { agentId: 'helion:trader:1', give: 'HLX', giveAmount: 1_000, want: 'VRD', minReceive: 800 },
          { agentId: 'verdan:trader:1', give: 'VRD', giveAmount: 1_000, want: 'HLX', minReceive: 1_000 },
        ], 1);
        const fx = await l.clearFxAuction('HLX', 'VRD', 1);
        expect(fx.ratePpm).not.toBeNull();
        await inv(l);

        await l.applyPolicy({ kind: 'set_tariff', planet: 'tethys', good: 'iron', rateBp: 500 });
        await l.applyPolicy({ kind: 'set_embargo', planet: 'verdan', target: 'tethys', active: true });
        const ship = await l.depart({ owner: 'helion:trader:1', from: 'helion', to: 'tethys', cargo: [{ good: 'iron', qty: 10 }], cycle: 1, arriveCycle: 4 });
        await inv(l);
        const arrival = await l.arrive(ship.id, 4);
        expect(arrival.delivered).toEqual([{ good: 'iron', qty: 10 }]);
        expect(arrival.duty).toEqual({ currency: 'TTH', amount: 50 });
        await inv(l);

        const loan = await l.borrow({ borrower: 'verdan:trader:1', planet: 'verdan', amount: 3_000, termCycles: 20, cycle: 4 });
        await l.repay({ loanId: loan.id, amount: 3_000, cycle: 6 });
        await inv(l);
      });
    });
  });
}
