// RulePolicy — Taylor-style reserve bank rule. No model call.
// Rate_bp = neutral + a*(CPI - target) + b*(trend). Clamped.

import type { Action, AgentDecision, AgentTask } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';

const NEUTRAL_RATE_BP = 200;  // DEFAULT: 2% neutral
const CPI_TARGET = 10_000;    // DEFAULT: index 10_000 is neutral
const CPI_SLOPE = 15;         // DEFAULT: 15 bp per 1 index point above target
const TREND_SLOPE = 5;        // DEFAULT: 5 bp per % trend change
const MIN_RATE = 0;
const MAX_RATE = 5_000;       // 50% ceiling

export class RulePolicy implements Policy {
  readonly name = 'rule';

  async decide(task: AgentTask, _ctx: PolicyCtx): Promise<AgentDecision> {
    const { observation: obs } = task;
    const policy = obs.policy;
    const cpiGap = fallbackCpi(obs) - CPI_TARGET;
    const trend = avgTrendBp(obs.markets.flatMap((m) => m.trend));
    const rate = clamp(NEUTRAL_RATE_BP + CPI_SLOPE * cpiGap + TREND_SLOPE * trend, MIN_RATE, MAX_RATE);

    if (!task.allowedActions.includes('set_policy_rate') || rate === policy.policyRateBp) {
      return { agentId: task.agentId, actions: [{ kind: 'pass' }], reason: 'hold rate', source: 'stub' };
    }
    const action: Action = { kind: 'set_policy_rate', rateBp: rate };
    return {
      agentId: task.agentId,
      actions: [action],
      reason: `Taylor rule: cpi gap ${cpiGap}, trend ${trend}bp → ${rate}bp`,
      source: 'stub',
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function fallbackCpi(obs: AgentTask['observation']): number {
  // A real CPI comes via briefing/metrics. Approximate from last prices divided by base prices.
  if (obs.markets.length === 0) return CPI_TARGET;
  const ratios = obs.markets
    .map((m) => m.lastPrice ?? null)
    .filter((p): p is number => p != null && p > 0);
  if (ratios.length === 0) return CPI_TARGET;
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Normalise to the index: assume ~ basePrice of first good as reference.
  return Math.round((avg / Math.max(1, avg)) * CPI_TARGET);
}

function avgTrendBp(trend: number[]): number {
  if (trend.length < 2) return 0;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  if (first === 0) return 0;
  return Math.round(((last - first) * 10_000) / first);
}
