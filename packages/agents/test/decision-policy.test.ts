import { describe, expect, it, vi } from 'vitest';
import { AgentDecisionSchema, DEFAULT_WORLD, type AgentTask, type DecisionRequest } from '@orbital/contracts';
import { StubDecisionGateway, StubGateway } from '@orbital/gateway';
import { colonistCandidates, DEFAULT_COLONIST_CANDIDATE } from '../src/candidates/colonist.js';
import { DecisionPolicy, scoreToConfidence } from '../src/policies/decision.js';
import { DefaultAgentRuntime } from '../src/runtime.js';
import { rngFor } from '../src/rng.js';
import { FIXTURES } from './fixtures/tasks.js';

const colonists = FIXTURES.filter((t) => t.role === 'colonist');
const hungry = colonists[0]!; // empty pantry, 1000 HLX
const ctxFor = (t: AgentTask) => ({ world: DEFAULT_WORLD, rng: rngFor({ seed: 1, universeId: t.universeId, cycle: t.cycle, agentId: t.agentId }) });

describe('colonistCandidates', () => {
  it('builds a deduplicated menu ending in hold, every action allowed', () => {
    for (const t of colonists) {
      const cands = colonistCandidates(t, DEFAULT_WORLD);
      expect(cands.at(-1)!.id).toBe('hold');
      const keys = cands.map((c) => JSON.stringify(c.actions));
      expect(new Set(keys).size).toBe(keys.length);
      for (const c of cands) {
        expect(c.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        for (const a of c.actions) expect(t.allowedActions).toContain(a.kind);
      }
    }
    const ids = colonistCandidates(hungry, DEFAULT_WORLD).map((c) => c.id);
    expect(ids[0]).toBe(DEFAULT_COLONIST_CANDIDATE);
    expect(ids).toContain('buy_needs_patient');
  });

  it('offers only hold when orders are not allowed', () => {
    const t = { ...hungry, allowedActions: ['pass' as const] };
    expect(colonistCandidates(t, DEFAULT_WORLD).map((c) => c.id)).toEqual(['hold']);
  });
});

describe('DecisionPolicy', () => {
  it('returns the chosen bundle, a 0-100 survey and decision_model source', async () => {
    let seen: DecisionRequest | undefined;
    const gw = new StubDecisionGateway((req) => {
      seen = req;
      return {
        bundle: { type: 'choice', choice: 'buy_needs_patient', probabilities: {}, confidence: 0.71 },
        confidence: { type: 'score', score: 3, probabilities: {}, confidence: 0.6 },
      };
    });
    const d = await new DecisionPolicy(gw).decide(hungry, ctxFor(hungry));
    const patient = colonistCandidates(hungry, DEFAULT_WORLD).find((c) => c.id === 'buy_needs_patient')!;
    expect(d.actions).toEqual(patient.actions);
    expect(d.survey).toEqual({ type: 'consumer', confidence: 75 });
    expect(d.source).toBe('decision_model');
    expect(d.reason).toContain('p=0.71');
    expect(AgentDecisionSchema.safeParse(d).success).toBe(true);
    // The model sees the colonist rules and the planet context in one shared input.
    expect(seen!.input).toContain('colonist');
    expect(seen!.input).toContain('Planet helion');
    expect(seen!.questions.bundle).toMatchObject({ type: 'choice' });
  });

  it('skips the choice question when only hold is possible', async () => {
    const respond = vi.fn((req: DecisionRequest) => {
      expect(Object.keys(req.questions)).toEqual(['confidence']);
      return { confidence: { type: 'score' as const, score: 2, probabilities: {}, confidence: 0.5 } };
    });
    const t = { ...hungry, allowedActions: ['pass' as const] };
    const d = await new DecisionPolicy(new StubDecisionGateway(respond)).decide(t, ctxFor(t));
    expect(d.actions).toEqual([{ kind: 'pass' }]);
    expect(d.survey?.confidence).toBe(50);
  });

  it('maps rubric scores onto 0-100', () => {
    expect(scoreToConfidence(0)).toBe(0);
    expect(scoreToConfidence(4)).toBe(100);
    expect(scoreToConfidence(1.4)).toBe(35);
  });
});

describe('DefaultAgentRuntime with a decision gateway', () => {
  const llm = new StubGateway(() => ({ actions: [{ kind: 'pass' }], reason: 'llm' }));

  it('routes colonists to the decision model', async () => {
    const decide = vi.fn(async () => ({
      bundle: { type: 'choice' as const, choice: 'hold', probabilities: {}, confidence: 0.9 },
      confidence: { type: 'score' as const, score: 2, probabilities: {}, confidence: 0.5 },
    }));
    const rt = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'cheap', gateway: llm, decisionGateway: new StubDecisionGateway(decide) });
    const [d] = await rt.decideAll([hungry], new AbortController().signal);
    expect(d!.source).toBe('decision_model');
    expect(d!.actions).toEqual([{ kind: 'pass' }]);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('falls back to standing orders when the decision call fails', async () => {
    const rt = new DefaultAgentRuntime({
      world: DEFAULT_WORLD, profile: 'cheap', gateway: llm,
      decisionGateway: new StubDecisionGateway(() => { throw new Error('boom'); }),
    });
    const [d] = await rt.decideAll([hungry], new AbortController().signal);
    expect(d!.source).toBe('standing_orders');
  });

  it('degrades the run on budget_exhausted from the decision gateway', async () => {
    const onDegrade = vi.fn();
    const rt = new DefaultAgentRuntime({
      world: DEFAULT_WORLD, profile: 'cheap', gateway: llm, onDegrade,
      decisionGateway: { decide: async () => ({ ok: false, failure: 'budget_exhausted' }) },
    });
    await rt.decideAll([hungry], new AbortController().signal);
    expect(onDegrade).toHaveBeenCalledWith('budget_exhausted');
    const [next] = await rt.decideAll([hungry], new AbortController().signal);
    expect(next!.source).toBe('stub');
  });

  it('ignores the decision gateway on the stub profile', async () => {
    const decide = vi.fn();
    const rt = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub', decisionGateway: new StubDecisionGateway(decide) });
    const [d] = await rt.decideAll([hungry], new AbortController().signal);
    expect(d!.source).toBe('stub');
    expect(decide).not.toHaveBeenCalled();
  });
});
