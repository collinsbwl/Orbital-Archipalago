import { describe, expect, it, vi } from 'vitest';
import { CostMeter } from '../src/cost.js';

const ev = (costUsd: number) => ({
  universeId: 'u0',
  cycle: 1,
  agentId: 'helion:colonist:1' as const,
  role: 'colonist' as const,
  usage: { model: 'gemini-2.5-flash', inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd, latencyMs: 10 },
});

describe('CostMeter', () => {
  it('fires onBudgetExhausted exactly once', () => {
    const onBudget = vi.fn();
    const meter = new CostMeter({ runBudgetUsd: 1, onBudgetExhausted: onBudget });
    meter.record(ev(0.5));
    expect(meter.isBudgetExhausted()).toBe(false);
    meter.record(ev(0.6));
    expect(meter.isBudgetExhausted()).toBe(true);
    meter.record(ev(0.1));
    expect(onBudget).toHaveBeenCalledOnce();
  });

  it('tallies by user for the advisor cap', () => {
    const onCap = vi.fn();
    const meter = new CostMeter({ advisorPerUserUsd: 1, onAdvisorCap: onCap });
    meter.record(ev(0.4), 'auth0|alice');
    meter.record(ev(0.3), 'auth0|alice');
    expect(meter.isAdvisorCapped('auth0|alice')).toBe(false);
    meter.record(ev(0.4), 'auth0|alice');
    expect(meter.isAdvisorCapped('auth0|alice')).toBe(true);
    expect(onCap).toHaveBeenCalledOnce();
  });
});
