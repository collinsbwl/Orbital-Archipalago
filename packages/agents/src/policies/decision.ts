// DecisionPolicy — colonists on Gemini Decision 1. Instead of generating a
// decision, the model picks one of the rule-built candidate bundles and scores
// consumer confidence on a rubric, in one ~200 ms call with no output tokens.

import type { AgentDecision, AgentTask, DecisionGateway, DecisionQuestion } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';
import { colonistCandidates } from '../candidates/colonist.js';
import { contextBlockFor, stateBlockFor } from '../prompt/builder.js';
import { systemRulesFor } from '../prompt/rules.js';
import { GatewayPolicyError } from './llm.js';

/** Consumer-confidence rubric, lowest first. Index maps linearly onto 0-100. */
export const CONFIDENCE_RUBRIC = [
  'Very pessimistic: prices are rising fast or needs cannot be covered from the purse.',
  'Somewhat pessimistic: needs are getting harder to afford.',
  'Neutral: prices are stable and needs are covered.',
  'Somewhat optimistic: prices are easing or surplus sells well.',
  'Very optimistic: needs are cheap and the purse is growing.',
];

/** Fractional rubric score → survey confidence 0-100. */
export function scoreToConfidence(score: number, levels = CONFIDENCE_RUBRIC.length): number {
  return Math.max(0, Math.min(100, Math.round((score / (levels - 1)) * 100)));
}

/** The shared input: role rules, then planet context, then this agent's state. */
export function decisionInputFor(task: AgentTask, extra?: string): string {
  return [systemRulesFor(task.role), '---', contextBlockFor(task), '---', 'Your state:', stateBlockFor(task), extra ? `---\n${extra}` : '']
    .filter(Boolean)
    .join('\n\n');
}

export class DecisionPolicy implements Policy {
  readonly name = 'decision';

  constructor(private readonly gateway: DecisionGateway) {}

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    const candidates = colonistCandidates(task, ctx.world);
    const questions: Record<string, DecisionQuestion> = {
      confidence: {
        type: 'score',
        instructions: 'As this colonist household, how do you feel about the economy right now, judging by prices, their trend, headlines and your purse?',
        criteria: CONFIDENCE_RUBRIC,
      },
    };
    // A choice needs at least two options; with only `hold` there is nothing to pick.
    if (candidates.length >= 2) {
      questions.bundle = {
        type: 'choice',
        instructions:
          'You are this colonist. Following your rules (cover needs at fair prices, do not overspend, sell surplus at or above the best bid), which plan should you carry out this cycle?',
        criteria: Object.fromEntries(candidates.map((c) => [c.id, c.description])),
      };
    }

    const result = await this.gateway.decide(
      {
        universeId: task.universeId,
        cycle: task.cycle,
        agentId: task.agentId,
        role: task.role,
        planet: task.planet,
        input: decisionInputFor(task),
        questions,
        deadlineMs: task.deadlineMs,
      },
      ctx.signal ?? new AbortController().signal,
    );
    if (!result.ok) throw new GatewayPolicyError(result.failure, result.message ?? result.failure);

    const bundle = result.answers.bundle;
    const chosen = bundle?.type === 'choice' ? candidates.find((c) => c.id === bundle.choice) : candidates[0];
    if (!chosen) throw new GatewayPolicyError('invalid_output', 'decision chose an unknown candidate');
    const conf = result.answers.confidence;
    const confidence = conf?.type === 'score' ? scoreToConfidence(conf.score) : 50;

    return {
      agentId: task.agentId,
      actions: chosen.actions,
      survey: { type: 'consumer', confidence },
      reason: bundle?.type === 'choice' ? `chose ${chosen.id} (p=${bundle.confidence.toFixed(2)})` : `only option: ${chosen.id}`,
      source: 'decision_model',
      usage: result.usage,
    };
  }
}
