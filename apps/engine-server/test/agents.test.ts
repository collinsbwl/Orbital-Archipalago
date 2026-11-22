// End-to-end: the server's agent wiring (DefaultAgentRuntime behind the GeminiAgents
// adapter) driving a real Universe, with the Gemini gateways stubbed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORLD, type DecisionAnswer, type DecisionRequest } from '@orbital/contracts';
import { DefaultAgentRuntime } from '@orbital/agents';
import { CostMeter, StubDecisionGateway, StubGateway } from '@orbital/gateway';
import { RandomValidPolicy, Universe } from '@orbital/engine';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { GeminiAgents, makeAgents, resolveProfile } from '../src/agents.js';

/** Stand-in for Decision 1: prefer moving cargo, then buying for a route, then a policy move. */
function preferActive(req: DecisionRequest): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {};
  const bundle = req.questions.bundle;
  if (bundle?.type === 'choice') {
    const ids = Object.keys(bundle.criteria);
    const choice =
      ids.find((i) => i.startsWith('ship_to_')) ?? ids.find((i) => i.startsWith('buy_') && i.includes('_for_')) ??
      ids.find((i) => i.includes('tariff')) ?? ids[0]!;
    out.bundle = { type: 'choice', choice, probabilities: { [choice]: 0.8 }, confidence: 0.8 };
  }
  if (req.questions.confidence) out.confidence = { type: 'score', score: 2, probabilities: {}, confidence: 0.5 };
  return out;
}

describe('GeminiAgents in a live Universe', () => {
  it('runs colonists, traders and governments on the decision model and moves freight', async () => {
    const world = DEFAULT_WORLD;
    const llm = vi.fn(() => ({ actions: [{ kind: 'pass' }], reason: 'flash' }));
    const decide = vi.fn(preferActive);
    const runtime = new DefaultAgentRuntime({
      world, profile: 'cheap', gateway: new StubGateway(llm), decisionGateway: new StubDecisionGateway(decide),
    });
    const agents = new GeminiAgents(runtime, new CostMeter());
    const universe = new Universe({ world, ledger: new InMemoryLedger(world), agents });
    await universe.init();
    // A god-mode tariff on a staple gives Verdan's government something to review.
    universe.enqueue({ kind: 'tariff', planet: 'verdan', good: 'grain', rateBp: 2_000 }, { sub: 'test' });

    let departures = 0;
    let rejections = 0;
    for (let c = 0; c < 16; c++) {
      const r = await universe.step();
      departures += r.departures.length;
      rejections += r.rejections;
    }
    const roles = new Set(decide.mock.calls.map(([req]) => req.role));
    expect([...roles].sort()).toEqual(['colonist', 'government', 'trader']);
    expect(llm).not.toHaveBeenCalled(); // confident picks never touch Flash
    expect(departures).toBeGreaterThan(0); // buy-then-ship across turns works
    expect(rejections).toBe(0); // every candidate passes the engine validator
    const snap = await universe.snapshot({ series: [] });
    expect(snap.events.some((e) => e.kind === 'policy' && e.text.includes('Verdan government sets a 15% tariff on grain'))).toBe(true);
  }, 30_000);

  it('forks into an independent provider', () => {
    const runtime = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub' });
    const a = new GeminiAgents(runtime, new CostMeter());
    expect(a.fork()).toBeInstanceOf(GeminiAgents);
    expect(a.fork()).not.toBe(a);
  });
});

describe('makeAgents', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('keeps RandomValidPolicy without a key', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GATEWAY_PROFILE;
    expect(resolveProfile()).toBe('stub');
    expect(makeAgents(DEFAULT_WORLD)).toBeInstanceOf(RandomValidPolicy);
  });

  it('defaults to cheap with a key, treats an empty profile as unset, and builds the Gemini stack', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GATEWAY_PROFILE = '';
    expect(resolveProfile()).toBe('cheap');
    expect(makeAgents(DEFAULT_WORLD)).toBeInstanceOf(GeminiAgents);
  });

  it('refuses a Gemini profile without a key and rejects unknown profiles', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.GATEWAY_PROFILE = 'full';
    expect(() => makeAgents(DEFAULT_WORLD)).toThrow(/GEMINI_API_KEY/);
    process.env.GATEWAY_PROFILE = 'pro';
    expect(() => resolveProfile()).toThrow(/GATEWAY_PROFILE/);
  });
});
