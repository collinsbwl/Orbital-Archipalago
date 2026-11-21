import { describe, expect, it } from 'vitest';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import { AgentTaskSchema } from '@orbital/contracts';
import { COLONIST_ACTIONS, MarketBook, TRADER_ACTIONS, validateDecisions } from '../src/index.js';
import { makeUniverse, scripted } from './helpers.js';

const goods = { goods: new Set(['iron', 'grain']), planets: new Set(['helion', 'verdan']), currencies: new Set(['HLX', 'VRD']) };
const task = (agentId: string, allowed = COLONIST_ACTIONS): AgentTask => ({
  universeId: 'u0', cycle: 0, agentId, role: 'colonist', planet: 'helion',
  observation: { purse: { HLX: 100 }, inventory: {}, openOrders: [], loans: [], shipments: [], markets: [], fx: [], policy: { tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 }, headlines: [] },
  allowedActions: allowed, deadlineMs: 1000,
});
const dec = (agentId: string, actions: AgentDecision['actions']): AgentDecision => ({ agentId, actions, reason: 'x', source: 'stub' });
const buy = { kind: 'place_order', good: 'iron', side: 'buy', qty: 1, limitPrice: 10 } as const;

describe('validateDecisions', () => {
  const book = new MarketBook();
  book.add({ orderId: 'o1', agentId: 'a', planet: 'helion', good: 'iron', side: 'buy', qty: 1, limitPrice: 5, cycle: 0 });
  book.add({ orderId: 'o2', agentId: 'b', planet: 'helion', good: 'iron', side: 'buy', qty: 1, limitPrice: 5, cycle: 0 });
  const tasks = [task('a'), task('b')];

  it('drops schema-invalid, unscheduled and duplicate decisions', () => {
    const r = validateDecisions([{ agentId: 'a', actions: 'nope' }, dec('zzz', [buy]), dec('a', [buy]), dec('a', [buy])], tasks, book, goods);
    expect(r.rejections.map((x) => x.reason)).toEqual(['schema_invalid', 'unscheduled_agent', 'duplicate_decision']);
    expect(r.rejections[0]!.agentId).toBe('a');
    expect(r.decisions).toHaveLength(1);
  });

  it('rejects disallowed actions and unknown goods', () => {
    const r = validateDecisions(
      [dec('a', [{ kind: 'borrow', amount: 5, termCycles: 2 }, { ...buy, good: 'gold' }, buy])],
      tasks, book, goods,
    );
    expect(r.rejections.map((x) => x.reason)).toEqual(['not_allowed', 'unknown_good']);
    expect(r.decisions[0]!.orders).toHaveLength(1);
    expect(r.decisions[0]!.orders[0]).toMatchObject({ agentId: 'a', planet: 'helion', good: 'iron' });
  });

  it('caps actions at 10 per agent', () => {
    const r = validateDecisions([dec('a', Array.from({ length: 13 }, () => buy))], tasks, book, goods);
    expect(r.decisions[0]!.orders).toHaveLength(10);
    expect(r.rejections.filter((x) => x.reason === 'action_cap')).toHaveLength(3);
  });

  it('allows cancels only for own open orders, once', () => {
    const r = validateDecisions(
      [dec('a', [{ kind: 'cancel_order', orderId: 'o1' }, { kind: 'cancel_order', orderId: 'o1' }, { kind: 'cancel_order', orderId: 'o2' }, { kind: 'cancel_order', orderId: 'nope' }])],
      tasks, book, goods,
    );
    expect(r.decisions[0]!.cancels).toEqual(['o1']);
    expect(r.rejections.map((x) => x.reason)).toEqual(['duplicate_cancel', 'not_own_order', 'not_own_order']);
  });

  it('orders output by task order regardless of provider order', () => {
    const r = validateDecisions([dec('b', [buy]), dec('a', [buy])], tasks, book, goods);
    expect(r.decisions.map((d) => d.agentId)).toEqual(['a', 'b']);
  });
});

describe('Universe settlement', () => {
  it('counts rejections and ledger rejects; keeps memos; tasks are schema-valid', async () => {
    const seen: AgentTask[][] = [];
    const agents = scripted((tasks) => {
      seen.push(tasks);
      const t = tasks[0]!;
      return [
        // unaffordable buy -> ledger reject; unknown good -> validator reject
        dec(t.agentId, [{ ...buy, qty: 1, limitPrice: 10_000_000 }, { ...buy, good: 'gold' }]),
        { ...dec(tasks[1]!.agentId, [{ kind: 'pass' }]), memo: 'hello' },
      ];
    });
    const { universe } = makeUniverse({ agents });
    await universe.init();
    const r0 = await universe.step();
    expect(r0).toMatchObject({ cycle: 0, rejections: 1, placeOrdersRejected: 1 });
    await universe.step();
    for (const t of seen[0]!) AgentTaskSchema.parse(t);
    expect(seen[0]).toHaveLength(3 * (30 + 3));
    expect(seen[1]!.find((t) => t.agentId === seen[0]![1]!.agentId)!.observation.memo).toBe('hello');
    expect(universe.cycle).toBe(2);
  });
});

describe('validateDecisions: trader actions', () => {
  const book = new MarketBook();
  const trader = (): AgentTask => ({ ...task('t', TRADER_ACTIONS), role: 'trader' });
  type A = AgentDecision['actions'][number];
  const ship = (to: string, good = 'iron'): A => ({ kind: 'ship', to, cargo: [{ good, qty: 2 }] });
  const fx = (give: string, want: string): A => ({ kind: 'place_fx_order', give, giveAmount: 10, want, minReceive: 5 });

  it('accepts one valid ship from the docked planet and valid fx orders', () => {
    const r = validateDecisions([dec('t', [ship('verdan'), fx('HLX', 'VRD'), fx('VRD', 'HLX')])], [trader()], book, goods);
    expect(r.rejections).toEqual([]);
    expect(r.decisions[0]!.ship).toEqual({ from: 'helion', to: 'verdan', cargo: [{ good: 'iron', qty: 2 }] });
    expect(r.decisions[0]!.fxOrders).toEqual([
      { agentId: 't', give: 'HLX', giveAmount: 10, want: 'VRD', minReceive: 5 },
      { agentId: 't', give: 'VRD', giveAmount: 10, want: 'HLX', minReceive: 5 },
    ]);
  });

  it('rejects a second ship, shipping to the docked planet, unknown planets and unknown cargo goods', () => {
    const r = validateDecisions([dec('t', [ship('verdan'), ship('verdan')])], [trader()], book, goods);
    expect(r.rejections.map((x) => x.reason)).toEqual(['duplicate_ship']);
    const r2 = validateDecisions([dec('t', [ship('helion'), ship('mars'), ship('verdan', 'gold')])], [trader()], book, goods);
    expect(r2.rejections.map((x) => x.reason)).toEqual(['ship_to_self', 'unknown_planet', 'unknown_good']);
    expect(r2.decisions[0]!.ship).toBeUndefined();
  });

  it('rejects fx orders with unknown or identical currencies', () => {
    const r = validateDecisions([dec('t', [fx('HLX', 'XXX'), fx('XXX', 'VRD'), fx('HLX', 'HLX')])], [trader()], book, goods);
    expect(r.rejections.map((x) => x.reason)).toEqual(['unknown_currency', 'unknown_currency', 'same_currency']);
    expect(r.decisions[0]!.fxOrders).toEqual([]);
  });

  it('colonists may not ship or trade FX', () => {
    const r = validateDecisions([dec('a', [ship('verdan'), fx('HLX', 'VRD')])], [task('a')], book, goods);
    expect(r.rejections.map((x) => x.reason)).toEqual(['not_allowed', 'not_allowed']);
  });
});
