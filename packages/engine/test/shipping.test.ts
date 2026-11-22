import { describe, expect, it } from 'vitest';
import type { AgentDecision, ArriveResult, PolicyInstruction } from '@orbital/contracts';
import type { CycleReport } from '../src/index.js';
import { makeUniverse, scripted } from './helpers.js';

// Treasury balances are asserted to the unit, and migration grants also draw on treasuries: keep everyone home.

const TRADER = 'helion:trader:0';
const dec = (actions: AgentDecision['actions']): AgentDecision => ({ agentId: TRADER, actions, reason: 'x', source: 'stub' });

/** helion trader holds 10 iron and 5000 VRD, ships all iron to verdan at cycle 0 (10 cycles away), then idles. */
async function shipIron(policy: PolicyInstruction[]) {
  const agents = scripted((tasks) => (tasks[0]!.cycle === 0 ? [dec([{ kind: 'ship', to: 'verdan', cargo: [{ good: 'iron', qty: 10 }] }])] : []));
  const { universe, ledger } = makeUniverse({ agents, migration: false });
  await universe.init();
  await ledger.produce({ owner: TRADER, planet: 'helion', inputs: [], outputs: [{ good: 'iron', qty: 10 }] });
  await ledger.transfer({ from: 'verdan', to: TRADER, currency: 'VRD', amount: 5_000 });
  for (const p of policy) await ledger.applyPolicy(p);
  const first = await universe.step();
  expect(first.departures).toHaveLength(1);
  expect(universe.locationOf(TRADER)).toBeNull();
  let arrival: ArriveResult | undefined;
  let report: CycleReport | undefined;
  for (let i = 0; i < 20 && !arrival; i++) {
    report = await universe.step();
    arrival = report.arrivals[0];
  }
  expect(arrival).toBeDefined();
  expect(universe.locationOf(TRADER)).toBe('verdan');
  return { universe, ledger, arrival: arrival!, report: report! };
}

describe('freighters and customs', () => {
  it('delivers cargo untouched without policy', async () => {
    const { ledger, arrival, report } = await shipIron([]);
    expect(arrival.delivered).toEqual([{ good: 'iron', qty: 10 }]);
    expect(arrival.withheld).toEqual([]);
    expect(await ledger.getInventory(TRADER, 'verdan', 'iron')).toBe(10);
    // 10 iron at basePrice 100 on both planets.
    expect(report.tradeFlows['verdan']).toEqual({ exports: 0, imports: 1_000 });
    expect(report.tradeFlows['helion']).toEqual({ exports: 1_000, imports: 0 });
  });

  it('collects tariff duty into the destination treasury', async () => {
    const { ledger, arrival } = await shipIron([{ kind: 'set_tariff', planet: 'verdan', good: 'iron', rateBp: 1_000 }]);
    expect(arrival.duty).toEqual({ currency: 'VRD', amount: 100 }); // 10% of 10 * 100
    expect(await ledger.getPurse('verdan', 'VRD')).toBe(100_000 - 5_000 + 100) // treasury funded the trader's VRD, then got the duty back;
    expect(await ledger.getPurse(TRADER, 'VRD')).toBe(4_900);
  });

  it('withholds and returns cargo from an embargoed origin', async () => {
    const { ledger, arrival } = await shipIron([{ kind: 'set_embargo', planet: 'verdan', target: 'helion', active: true }]);
    expect(arrival.delivered).toEqual([]);
    expect(arrival.withheld).toEqual([{ good: 'iron', qty: 10 }]);
    expect(await ledger.getInventory(TRADER, 'helion', 'iron')).toBe(10);
    expect(await ledger.getInventory(TRADER, 'verdan', 'iron')).toBe(0);
  });

  it('caps delivered quantity with a per-cycle quota', async () => {
    const { ledger, arrival } = await shipIron([{ kind: 'set_quota', planet: 'verdan', good: 'iron', maxPerCycle: 4 }]);
    expect(arrival.delivered).toEqual([{ good: 'iron', qty: 4 }]);
    expect(arrival.withheld).toEqual([{ good: 'iron', qty: 6 }]);
    expect(await ledger.getInventory(TRADER, 'verdan', 'iron')).toBe(4);
    expect(await ledger.getInventory(TRADER, 'helion', 'iron')).toBe(6);
  });

  it('counts ledger rejections during settlement without crashing the cycle', async () => {
    const agents = scripted(() => [
      dec([
        { kind: 'ship', to: 'verdan', cargo: [{ good: 'iron', qty: 5 }] }, // holds none -> insufficient_inventory
        { kind: 'place_fx_order', give: 'HLX', giveAmount: 1_000_000_000, want: 'VRD', minReceive: 1 }, // insufficient funds
        { kind: 'cancel_order', orderId: 'o999' }, // not own order -> validator rejection
      ]),
    ]);
    const { universe } = makeUniverse({ agents, migration: false });
    await universe.init();
    const r = await universe.step(); // invariants are checked inside step
    expect(r).toMatchObject({ rejections: 1, ledgerRejections: 1, fxOrdersRejected: 1, departures: [] });
    expect(universe.locationOf(TRADER)).toBe('helion');
    await universe.step();
  });

  it('cannot ship goods that are escrowed in a sell order', async () => {
    const agents = scripted((tasks) =>
      tasks[0]!.cycle === 0
        ? [dec([
            { kind: 'place_order', good: 'iron', side: 'sell', qty: 10, limitPrice: 1_000 },
            { kind: 'ship', to: 'verdan', cargo: [{ good: 'iron', qty: 10 }] },
          ])]
        : [],
    );
    const { universe, ledger } = makeUniverse({ agents, migration: false });
    await universe.init();
    await ledger.produce({ owner: TRADER, planet: 'helion', inputs: [], outputs: [{ good: 'iron', qty: 10 }] });
    const r = await universe.step();
    expect(r.ledgerRejections).toBe(1);
    expect(r.departures).toEqual([]);
    expect(universe.locationOf(TRADER)).toBe('helion');
  });
});
