import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORLD, type AgentDecision, type AgentTask, type DecisionGateway, type DecisionRequest } from '@orbital/contracts';
import { StubDecisionGateway } from '@orbital/gateway';
import type { Policy, PolicyCtx } from '../src/policy.js';
import { EscalatingPolicy } from '../src/policies/escalating.js';
import { StandingOrdersPolicy } from '../src/policies/standing-orders.js';
import { rngFor } from '../src/rng.js';
import { FIXTURES } from './fixtures/tasks.js';

const trader = FIXTURES.find((t) => t.role === 'trader')!;
const government = FIXTURES.find((t) => t.role === 'government')!;

const previous: AgentDecision = {
  agentId: trader.agentId,
  actions: [{ kind: 'ship', to: 'verdan', cargo: [{ good: 'iron', qty: 5 }] }],
  reason: 'iron margin', memo: 'watching iron:verdan', source: 'llm',
};

function ctx(t: AgentTask, prev?: AgentDecision): PolicyCtx {
  return { world: DEFAULT_WORLD, rng: rngFor({ seed: 1, universeId: t.universeId, cycle: t.cycle, agentId: t.agentId }), previous: prev };
}

function fakeLlm(): Policy & { decide: ReturnType<typeof vi.fn> } {
  return { name: 'llm', decide: vi.fn(async (t: AgentTask) => ({ agentId: t.agentId, actions: [{ kind: 'pass' }], reason: 'thought hard', source: 'llm' })) } as never;
}

const noul = (p: number) => new StubDecisionGateway((req) =>
  Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'noul' as const, noul: p, confidence: Math.max(p, 1 - p) }])),
);

describe('EscalatingPolicy', () => {
  it('keeps standing orders below the threshold without calling the LLM', async () => {
    const llm = fakeLlm();
    const d = await new EscalatingPolicy(noul(0.1), llm, new StandingOrdersPolicy()).decide(trader, ctx(trader, previous));
    expect(llm.decide).not.toHaveBeenCalled();
    expect(d.actions).toEqual(previous.actions);
    expect(d.source).toBe('decision_model');
    expect(d.reason).toContain('0.10');
    expect(d.memo).toBe(previous.memo);
  });

  it('escalates at or above the threshold', async () => {
    const llm = fakeLlm();
    const onCheck = vi.fn();
    const d = await new EscalatingPolicy(noul(0.6), llm, new StandingOrdersPolicy(), { onCheck }).decide(trader, ctx(trader, previous));
    expect(llm.decide).toHaveBeenCalledTimes(1);
    expect(d.source).toBe('llm');
    expect(onCheck).toHaveBeenCalledWith({ agentId: trader.agentId, pRevise: 0.6, escalated: true });
  });

  it('respects a custom threshold', async () => {
    const llm = fakeLlm();
    await new EscalatingPolicy(noul(0.6), llm, new StandingOrdersPolicy(), { threshold: 0.8 }).decide(trader, ctx(trader, previous));
    expect(llm.decide).not.toHaveBeenCalled();
  });

  it('always escalates on the first turn without asking', async () => {
    const llm = fakeLlm();
    const respond = vi.fn();
    await new EscalatingPolicy(new StubDecisionGateway(respond), llm, new StandingOrdersPolicy()).decide(trader, ctx(trader));
    expect(respond).not.toHaveBeenCalled();
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('fails open to the LLM when the check errors', async () => {
    const llm = fakeLlm();
    const gw: DecisionGateway = { decide: async () => ({ ok: false, failure: 'timeout' }) };
    await new EscalatingPolicy(gw, llm, new StandingOrdersPolicy()).decide(trader, ctx(trader, previous));
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('rethrows budget_exhausted so the runtime can degrade', async () => {
    const gw: DecisionGateway = { decide: async () => ({ ok: false, failure: 'budget_exhausted' }) };
    await expect(new EscalatingPolicy(gw, fakeLlm(), new StandingOrdersPolicy()).decide(trader, ctx(trader, previous))).rejects.toMatchObject({
      failure: 'budget_exhausted',
    });
  });

  it('asks governments an extra policy question on policy cycles and escalates on either', async () => {
    let seen: DecisionRequest | undefined;
    const gw = new StubDecisionGateway((req) => {
      seen = req;
      return { revise: { type: 'noul', noul: 0.05, confidence: 0.95 }, policy: { type: 'noul', noul: 0.7, confidence: 0.7 } };
    });
    const llm = fakeLlm();
    const prev: AgentDecision = { agentId: government.agentId, actions: [{ kind: 'pass' }], reason: 'review', source: 'llm' };
    await new EscalatingPolicy(gw, llm, new StandingOrdersPolicy()).decide(government, ctx(government, prev));
    expect(Object.keys(seen!.questions).sort()).toEqual(['policy', 'revise']);
    expect(seen!.input).toContain('Previous decision');
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });
});
