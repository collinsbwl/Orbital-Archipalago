import { describe, expect, it } from 'vitest';
import { AgentDecisionSchema, DEFAULT_WORLD } from '@orbital/contracts';
import { DefaultAgentRuntime } from '../src/runtime.js';
import { FIXTURES } from './fixtures/tasks.js';

describe('DefaultAgentRuntime (stub profile)', () => {
  it('returns one schema-valid decision per task', async () => {
    const runtime = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub' });
    const decisions = await runtime.decideAll(FIXTURES, new AbortController().signal);
    expect(decisions).toHaveLength(FIXTURES.length);
    for (let i = 0; i < decisions.length; i++) {
      const d = decisions[i]!;
      const t = FIXTURES[i]!;
      const parsed = AgentDecisionSchema.safeParse(d);
      expect(parsed.success).toBe(true);
      expect(d.agentId).toBe(t.agentId);
      const allowed = new Set(t.allowedActions);
      for (const action of d.actions) {
        expect(allowed.has(action.kind)).toBe(true);
      }
    }
  });

  it('gives identical decisions on the same seed', async () => {
    const r1 = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub' });
    const r2 = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub' });
    const a = await r1.decideAll(FIXTURES, new AbortController().signal);
    const b = await r2.decideAll(FIXTURES, new AbortController().signal);
    expect(a).toEqual(b);
  });

  it('a deadline miss falls back to standing_orders', async () => {
    const world = { ...DEFAULT_WORLD };
    const runtime = new DefaultAgentRuntime({ world, profile: 'stub' });
    // Force the policy choice: inject an LlmPolicy that always throws.
    const slow = {
      name: 'slow',
      decide: async () => {
        await new Promise((r) => setTimeout(r, 50));
        throw new Error('too slow');
      },
    };
    const injected = new DefaultAgentRuntime({
      world,
      profile: 'stub',
      policies: { colonist: slow as unknown as import('../src/policy.js').Policy },
    });
    const task = { ...FIXTURES[0]!, deadlineMs: 1 };
    const [d] = await injected.decideAll([task], new AbortController().signal);
    expect(d!.source).toBe('standing_orders');
  });

  it('colonist stub pushes buy orders for needs', async () => {
    const runtime = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'stub' });
    const [d] = await runtime.decideAll([FIXTURES[0]!], new AbortController().signal);
    const buys = d!.actions.filter((a) => a.kind === 'place_order' && a.side === 'buy');
    expect(buys.length).toBeGreaterThan(0);
  });

  it('reserve bank uses the rule policy, not a model', async () => {
    const runtime = new DefaultAgentRuntime({ world: DEFAULT_WORLD, profile: 'full' });
    const bank = FIXTURES.find((t) => t.role === 'reserve_bank')!;
    const [d] = await runtime.decideAll([bank], new AbortController().signal);
    expect(d!.source).toBe('stub');
    // Either holds the rate (pass) or sets it.
    const kinds = d!.actions.map((a) => a.kind);
    expect(kinds.every((k) => k === 'pass' || k === 'set_policy_rate')).toBe(true);
  });
});
