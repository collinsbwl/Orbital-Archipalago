import { describe, expect, it, vi } from 'vitest';
import { ActionSchema, AgentDecisionSchema, DEFAULT_WORLD, type AgentTask, type DecisionAnswer } from '@orbital/contracts';
import { StubDecisionGateway, StubGateway } from '@orbital/gateway';
import { traderCandidates } from '../src/candidates/trader.js';
import { governmentCandidates, MAX_GOV_TARIFF_BP } from '../src/candidates/government.js';
import { DecisionPolicy } from '../src/policies/decision.js';
import type { Policy } from '../src/policy.js';
import { DefaultAgentRuntime } from '../src/runtime.js';
import { rngFor } from '../src/rng.js';

const policy = { tariffsBp: {} as Record<string, number>, quotas: {}, embargoes: [] as string[], policyRateBp: 100 };
const fx = [
  { base: 'HLX', quote: 'VRD', lastRatePpm: 1_000_000 },
  { base: 'HLX', quote: 'TTH', lastRatePpm: 1_000_000 },
  { base: 'TTH', quote: 'VRD', lastRatePpm: 1_000_000 },
];

function trader(over: Partial<AgentTask['observation']> = {}): AgentTask {
  return {
    universeId: 'u0', cycle: 7, agentId: 'helion:trader:0', role: 'trader', planet: 'helion',
    observation: {
      purse: { HLX: 2_000 }, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'iron', bids: [{ price: 90, qty: 5 }], asks: [{ price: 95, qty: 10 }], lastPrice: 92, trend: [92] },
        { good: 'grain', bids: [{ price: 60, qty: 5 }], asks: [{ price: 65, qty: 10 }], lastPrice: 62, trend: [62] },
      ],
      elsewhere: [
        { planet: 'verdan', travelCycles: 2, goods: [{ good: 'iron', lastPrice: 160, tariffBp: 0 }, { good: 'grain', lastPrice: 30, tariffBp: 0 }] },
        { planet: 'tethys', travelCycles: 4, goods: [{ good: 'iron', lastPrice: 170, tariffBp: 2_000 }, { good: 'grain', lastPrice: 50, tariffBp: 0 }] },
      ],
      fx, policy, headlines: [],
      ...over,
    },
    allowedActions: ['place_order', 'cancel_order', 'place_fx_order', 'ship', 'borrow', 'repay', 'pass'],
    deadlineMs: 5_000,
  };
}

function government(over: Partial<AgentTask['observation']> = {}): AgentTask {
  return {
    universeId: 'u0', cycle: 10, agentId: 'helion:government:0', role: 'government', planet: 'helion',
    observation: {
      purse: { HLX: 0 }, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [
        // Helion makes iron and fuel. Iron is falling (protect), grain is rising and taxed (relieve).
        { good: 'iron', bids: [], asks: [], lastPrice: 80, trend: [100, 95, 90, 85, 80] },
        { good: 'grain', bids: [], asks: [], lastPrice: 50, trend: [40, 42, 45, 48, 50] },
        { good: 'fuel', bids: [], asks: [], lastPrice: 60, trend: [60, 60, 60] },
      ],
      fx, headlines: [],
      policy: { tariffsBp: { grain: 500 }, quotas: {}, embargoes: ['verdan'], policyRateBp: 100 },
      ...over,
    },
    allowedActions: ['set_tariff', 'set_quota', 'set_embargo', 'pass'],
    deadlineMs: 5_000,
  };
}

const ctxFor = (t: AgentTask) => ({ world: DEFAULT_WORLD, rng: rngFor({ seed: 1, universeId: t.universeId, cycle: t.cycle, agentId: t.agentId }) });

function expectWellFormed(t: AgentTask, ids: string[], actions: unknown[][]) {
  expect(ids.at(-1)).toBe('hold');
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  for (const list of actions) {
    for (const a of list) {
      expect(ActionSchema.safeParse(a).success).toBe(true);
      expect(t.allowedActions).toContain((a as { kind: string }).kind);
    }
  }
}

describe('traderCandidates', () => {
  it('offers buy-for-route bundles ranked by margin per travel cycle, within the purse', () => {
    const t = trader();
    const cands = traderCandidates(t, DEFAULT_WORLD);
    expectWellFormed(t, cands.map((c) => c.id), cands.map((c) => c.actions));
    // iron → verdan: buy at 95*1.05=99, sells ~160, 2 cycles. Best score.
    expect(cands[0]!.id).toBe('buy_iron_for_verdan');
    const buy = cands[0]!.actions[0]!;
    expect(buy).toMatchObject({ kind: 'place_order', side: 'buy', good: 'iron', limitPrice: 99 });
    if (buy.kind === 'place_order') expect(buy.qty * buy.limitPrice).toBeLessThanOrEqual(2_000);
    expect(cands[0]!.memo).toBe('plan: ship iron to verdan');
    // Tethys iron: 170 less a 20% tariff = 136, still profitable but slower.
    expect(cands.map((c) => c.id)).toContain('buy_iron_for_tethys');
    // Grain is cheaper elsewhere: no grain route.
    expect(cands.some((c) => c.id.startsWith('buy_grain'))).toBe(false);
  });

  it('offers to carry held cargo, sell it here, convert foreign cash and repay loans', () => {
    const t = trader({
      purse: { HLX: 500, VRD: 300 },
      inventory: { iron: 10 },
      loans: [{ id: 'L1', borrower: 'helion:trader:0', planet: 'helion', currency: 'HLX', principal: 400, outstanding: 400, rateBp: 10, issuedCycle: 1, dueCycle: 20 } as never],
      memo: 'plan: ship iron to verdan',
    });
    const cands = traderCandidates(t, DEFAULT_WORLD);
    const ids = cands.map((c) => c.id);
    expectWellFormed(t, ids, cands.map((c) => c.actions));
    expect(ids).toContain('ship_to_verdan');
    expect(cands.find((c) => c.id === 'ship_to_verdan')!.description).toContain('matches your plan');
    expect(cands.find((c) => c.id === 'ship_to_verdan')!.actions).toEqual([{ kind: 'ship', to: 'verdan', cargo: [{ good: 'iron', qty: 10 }] }]);
    expect(cands.find((c) => c.id === 'sell_cargo_here')!.actions).toEqual([{ kind: 'place_order', good: 'iron', side: 'sell', qty: 10, limitPrice: 90 }]);
    expect(cands.find((c) => c.id === 'convert_foreign_cash')!.actions).toEqual([
      { kind: 'place_fx_order', give: 'VRD', giveAmount: 300, want: 'HLX', minReceive: 297 },
    ]);
    expect(cands.find((c) => c.id === 'repay_loans')!.actions).toEqual([{ kind: 'repay', loanId: 'L1', amount: 400 }]);
    expect(cands.length).toBeLessThanOrEqual(8);
  });

  it('cold start: estimates scarcity at parity before any market or FX pair has cleared', () => {
    const t = trader({
      fx: fx.map((f) => ({ ...f, lastRatePpm: null })),
      markets: [],
      elsewhere: [{ planet: 'verdan', travelCycles: 10, goods: DEFAULT_WORLD.goods.map((g) => ({ good: g.id, lastPrice: null, tariffBp: 0 })) }],
    });
    const cands = traderCandidates(t, DEFAULT_WORLD);
    const ids = cands.map((c) => c.id);
    // Verdan makes grain and water, not iron: iron is assumed scarce there; grain is not.
    expect(ids).toContain('buy_iron_for_verdan');
    expect(ids).not.toContain('buy_grain_for_verdan');
    expect(cands.find((c) => c.id === 'buy_iron_for_verdan')!.description).toContain('estimate');
  });

  it('falls back to hold when nothing is known about other planets', () => {
    const t = trader({ elsewhere: undefined });
    expect(traderCandidates(t, DEFAULT_WORLD).map((c) => c.id)).toEqual(['hold']);
  });
});

describe('governmentCandidates', () => {
  it('protects falling domestic goods, relieves rising taxed goods, and can lift embargoes', () => {
    const t = government();
    const cands = governmentCandidates(t, DEFAULT_WORLD);
    expectWellFormed(t, cands.map((c) => c.id), cands.map((c) => c.actions));
    const byId = Object.fromEntries(cands.map((c) => [c.id, c.actions]));
    expect(byId.raise_tariff_iron).toEqual([{ kind: 'set_tariff', good: 'iron', rateBp: 500 }]);
    expect(byId.remove_tariff_grain).toEqual([{ kind: 'set_tariff', good: 'grain', rateBp: 0 }]);
    expect(byId.lift_embargo_verdan).toEqual([{ kind: 'set_embargo', target: 'verdan', active: false }]);
    expect(byId.raise_tariff_fuel).toBeUndefined(); // flat price: no signal
  });

  it('never proposes a tariff above the cap and holds when there is no signal', () => {
    const capped = government({ policy: { tariffsBp: { iron: MAX_GOV_TARIFF_BP }, quotas: {}, embargoes: [], policyRateBp: 100 } });
    expect(governmentCandidates(capped, DEFAULT_WORLD).map((c) => c.id)).not.toContain('raise_tariff_iron');
    const quiet = government({ markets: [], policy });
    expect(governmentCandidates(quiet, DEFAULT_WORLD).map((c) => c.id)).toEqual(['hold']);
  });
});

describe('DecisionPolicy across roles', () => {
  const pick = (choice: string, p: number): Record<string, DecisionAnswer> => ({
    bundle: { type: 'choice', choice, probabilities: { [choice]: p }, confidence: p },
    confidence: { type: 'score', score: 3, probabilities: {}, confidence: 0.5 },
  });

  it('traders: returns the pick with a business survey and the route memo', async () => {
    const t = trader();
    const d = await new DecisionPolicy(new StubDecisionGateway(() => pick('buy_iron_for_verdan', 0.8))).decide(t, ctxFor(t));
    expect(d.source).toBe('decision_model');
    expect(d.survey).toEqual({ type: 'business', confidence: 75 });
    expect(d.memo).toBe('plan: ship iron to verdan');
    expect(AgentDecisionSchema.safeParse(d).success).toBe(true);
  });

  it('governments: no survey question, policy action from the pick', async () => {
    const t = government();
    let keys: string[] = [];
    const gw = new StubDecisionGateway((req) => {
      keys = Object.keys(req.questions);
      return { bundle: { type: 'choice', choice: 'raise_tariff_iron', probabilities: { raise_tariff_iron: 0.7 }, confidence: 0.7 } };
    });
    const d = await new DecisionPolicy(gw).decide(t, ctxFor(t));
    expect(keys).toEqual(['bundle']);
    expect(d.survey).toBeUndefined();
    expect(d.actions).toEqual([{ kind: 'set_tariff', good: 'iron', rateBp: 500 }]);
  });

  it('governments with only hold make no call', async () => {
    const decide = vi.fn();
    const t = government({ markets: [], policy });
    const d = await new DecisionPolicy(new StubDecisionGateway(decide)).decide(t, ctxFor(t));
    expect(decide).not.toHaveBeenCalled();
    expect(d.actions).toEqual([{ kind: 'pass' }]);
  });

  it('defers a low-confidence trader pick to the fallback, but never a colonist pick', async () => {
    const fallback: Policy = { name: 'flash', decide: vi.fn(async (task) => ({ agentId: task.agentId, actions: [{ kind: 'pass' as const }], reason: 'flash', source: 'llm' as const })) };
    const onPick = vi.fn();
    const policy = new DecisionPolicy(new StubDecisionGateway(() => pick('hold', 0.2)), { fallback, onPick });
    const t = trader();
    expect((await policy.decide(t, ctxFor(t))).source).toBe('llm');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ role: 'trader', fellBack: true }));
    const confident = new DecisionPolicy(new StubDecisionGateway(() => pick('hold', 0.9)), { fallback });
    expect((await confident.decide(t, ctxFor(t))).source).toBe('decision_model');
  });
});

describe('DefaultAgentRuntime defaults', () => {
  const llm = new StubGateway(() => ({ actions: [{ kind: 'pass' }], reason: 'llm' }));

  it('sends traders and governments to the decision model, not Flash', async () => {
    const llmSpy = vi.spyOn(llm, 'invoke');
    const decide = vi.fn(async (req: { questions: Record<string, unknown> }) => {
      const opts = Object.keys((req.questions.bundle as { criteria: Record<string, string> }).criteria);
      return { bundle: { type: 'choice' as const, choice: opts[0]!, probabilities: { [opts[0]!]: 0.9 }, confidence: 0.9 } };
    });
    const rt = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'cheap', gateway: llm, decisionGateway: new StubDecisionGateway(decide) });
    const out = await rt.decideAll([trader(), government()], new AbortController().signal);
    expect(out.map((d) => d.source)).toEqual(['decision_model', 'decision_model']);
    expect(out[0]!.actions[0]).toMatchObject({ kind: 'place_order', good: 'iron' });
    expect(out[1]!.actions[0]).toMatchObject({ kind: 'set_tariff' });
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('fork copies standing-orders memory without sharing it', async () => {
    const rt = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub' });
    const t = trader();
    await rt.decideAll([t], new AbortController().signal);
    const copy = rt.fork();
    expect(copy).not.toBe(rt);
    const prevOf = (r: DefaultAgentRuntime) => (r as unknown as { previous: Map<string, unknown> }).previous;
    expect(prevOf(copy).get('u0:helion:trader:0')).toEqual(prevOf(rt).get('u0:helion:trader:0'));
    prevOf(copy).clear();
    expect(prevOf(rt).size).toBe(1);
  });
});
