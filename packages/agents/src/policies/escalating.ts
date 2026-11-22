// EscalatingPolicy — traders and governments. Most cycles nothing material
// changes, so instead of paying Flash/Pro every turn we ask Gemini Decision 1
// one calibrated yes/no question: does this agent need to revise its plan?
// Below the threshold the agent keeps its standing orders; above it (or on the
// first turn, or if the check fails) the full LLM policy decides.

import type { Action, ActionKind, AgentDecision, AgentTask, DecisionGateway, DecisionQuestion } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';
import { decisionInputFor } from './decision.js';
import { GatewayPolicyError } from './llm.js';

/** DEFAULT: escalate when P(revise) >= 0.35. Biased low: a missed change costs more than a spare LLM call. */
export const DEFAULT_ESCALATION_THRESHOLD = 0.35;

const POLICY_TOOLS: ActionKind[] = ['set_tariff', 'set_quota', 'set_embargo', 'set_policy_rate'];

export interface EscalatingPolicyOpts {
  threshold?: number;
  /** Called with each check's outcome (telemetry / tests). */
  onCheck?: (ev: { agentId: string; pRevise: number; escalated: boolean }) => void;
}

export class EscalatingPolicy implements Policy {
  readonly name = 'escalating';
  private readonly threshold: number;

  constructor(
    private readonly gateway: DecisionGateway,
    private readonly llm: Policy,
    private readonly standing: Policy,
    private readonly opts: EscalatingPolicyOpts = {},
  ) {
    this.threshold = opts.threshold ?? DEFAULT_ESCALATION_THRESHOLD;
  }

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    // No prior plan to keep: always think properly.
    if (!ctx.previous) return this.llm.decide(task, ctx);

    const questions: Record<string, DecisionQuestion> = {
      revise: {
        type: 'noul',
        instructions:
          'Compare the previous decision with the current markets, FX, policy, headlines and this agent\'s state. Has something changed enough that this agent should revise its plan instead of repeating it?',
        criteria: {
          true_description: 'Prices, margins, policy or the agent\'s position moved materially, or the previous plan no longer fits.',
          false_description: 'Conditions are broadly the same; repeating the previous plan is reasonable.',
        },
      },
    };
    if (task.role === 'government' && task.allowedActions.some((a) => POLICY_TOOLS.includes(a))) {
      questions.policy = {
        type: 'noul',
        instructions: 'This is a policy cycle. Is there a clear, specific economic reason for this government to change a tariff, quota, embargo or rate now?',
      };
    }

    const result = await this.gateway.decide(
      {
        universeId: task.universeId,
        cycle: task.cycle,
        agentId: task.agentId,
        role: task.role,
        planet: task.planet,
        input: decisionInputFor(task, `Previous decision:\n${summarisePrevious(ctx.previous)}`),
        questions,
        deadlineMs: task.deadlineMs,
      },
      ctx.signal ?? new AbortController().signal,
    );

    if (!result.ok) {
      // Budget exhaustion must reach the runtime so the whole run degrades to stub.
      if (result.failure === 'budget_exhausted') throw new GatewayPolicyError(result.failure, result.message ?? result.failure);
      // Any other failure: fail open to the LLM (quality over savings).
      this.opts.onCheck?.({ agentId: task.agentId, pRevise: 1, escalated: true });
      return this.llm.decide(task, ctx);
    }

    const pRevise = Math.max(...Object.values(result.answers).map((a) => (a.type === 'noul' ? a.noul : 0)));
    const escalated = pRevise >= this.threshold;
    this.opts.onCheck?.({ agentId: task.agentId, pRevise, escalated });
    if (escalated) return this.llm.decide(task, ctx);

    const held = await this.standing.decide(task, ctx);
    return {
      ...held,
      reason: `kept standing orders (P(revise)=${pRevise.toFixed(2)})`,
      source: 'decision_model',
      usage: result.usage,
    };
  }
}

function summarisePrevious(prev: AgentDecision): string {
  const actions = prev.actions.map(describeAction).join('; ') || 'pass';
  return [`actions: ${actions}`, `reason: ${prev.reason}`, prev.memo ? `memo: ${prev.memo}` : ''].filter(Boolean).join('\n');
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case 'place_order':
      return `${a.side} ${a.qty} ${a.good} @ ${a.limitPrice}`;
    case 'ship':
      return `ship ${a.cargo.map((c) => `${c.qty} ${c.good}`).join(', ')} to ${a.to}`;
    default:
      return JSON.stringify(a);
  }
}
