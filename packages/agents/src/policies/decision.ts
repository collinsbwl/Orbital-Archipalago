// DecisionPolicy — gameplay on Gemini Decision 1. Instead of generating a
// decision, the model picks one of the rule-built candidate bundles (colonists,
// traders, governments) and scores a confidence survey on a rubric, in one
// ~200 ms call with no output tokens. When the pick is unsure and a fallback
// (Flash via LlmPolicy) is configured for the role, the fallback decides.

import type { AgentDecision, AgentTask, DecisionGateway, DecisionQuestion, Role, SurveyAnswer } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';
import { colonistCandidates } from '../candidates/colonist.js';
import { governmentCandidates } from '../candidates/government.js';
import { traderCandidates } from '../candidates/trader.js';
import type { CandidateBuilder } from '../candidates/types.js';
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

/** Business-confidence rubric for traders, lowest first. */
export const BUSINESS_RUBRIC = [
  'Very pessimistic: no profitable route, cargo is losing value or debts are hard to service.',
  'Somewhat pessimistic: margins are thin and shrinking.',
  'Neutral: some routes pay, conditions are steady.',
  'Somewhat optimistic: several routes clear good margins.',
  'Very optimistic: wide spreads, cash is growing and debts are easy to cover.',
];

/** Rule-built menus per role. Roles without a builder cannot use DecisionPolicy. */
export const CANDIDATE_BUILDERS: Partial<Record<Role, CandidateBuilder>> = {
  colonist: colonistCandidates,
  trader: traderCandidates,
  government: governmentCandidates,
};

/** DEFAULT: below this probability for the chosen option, defer to the fallback (if any). */
export const DEFAULT_MIN_CHOICE_CONFIDENCE = 0.4;

const CHOICE_PROMPT: Partial<Record<Role, string>> = {
  colonist:
    'You are this colonist. Following your rules (cover needs at fair prices, do not overspend, sell surplus at or above the best bid), which plan should you carry out this cycle?',
  trader:
    'You are this trader. Following your rules (buy low, carry goods where they sell for more after tariffs, FX and travel time, keep enough cash, avoid needless risk), which plan should you carry out this cycle?',
  government:
    "You are this planet's government. Weigh consumers' prices against local producers and trading partners. Which trade-policy move, if any, best serves the planet right now? Prefer holding unless there is a clear reason to act.",
};

interface SurveySpec {
  type: SurveyAnswer['type'];
  instructions: string;
  rubric: string[];
}

const SURVEY: Partial<Record<Role, SurveySpec>> = {
  colonist: {
    type: 'consumer',
    instructions: 'As this colonist household, how do you feel about the economy right now, judging by prices, their trend, headlines and your purse?',
    rubric: CONFIDENCE_RUBRIC,
  },
  trader: {
    type: 'business',
    instructions: 'As this trading business, how do you feel about trading conditions right now, judging by spreads, FX, tariffs, your cargo and your cash?',
    rubric: BUSINESS_RUBRIC,
  },
};

export interface DecisionPolicyOpts {
  /** Decides instead when the pick is below `minChoiceConfidence` (e.g. LlmPolicy on Flash). */
  fallback?: Policy;
  /** Roles allowed to use the fallback. DEFAULT: trader, government (colonists are too many to escalate). */
  fallbackRoles?: Role[];
  minChoiceConfidence?: number;
  /** Override or extend the per-role candidate builders. */
  builders?: Partial<Record<Role, CandidateBuilder>>;
  /** Called after each pick (telemetry / tests). */
  onPick?: (ev: { agentId: string; role: Role; choice: string; p: number; fellBack: boolean }) => void;
}

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
  private readonly builders: Partial<Record<Role, CandidateBuilder>>;
  private readonly fallbackRoles: ReadonlySet<Role>;
  private readonly minChoice: number;

  constructor(
    private readonly gateway: DecisionGateway,
    private readonly opts: DecisionPolicyOpts = {},
  ) {
    this.builders = { ...CANDIDATE_BUILDERS, ...opts.builders };
    this.fallbackRoles = new Set(opts.fallbackRoles ?? ['trader', 'government']);
    this.minChoice = opts.minChoiceConfidence ?? DEFAULT_MIN_CHOICE_CONFIDENCE;
  }

  /** True when this policy has a candidate builder for the role. */
  handles(role: Role): boolean {
    return this.builders[role] !== undefined;
  }

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    const build = this.builders[task.role];
    if (!build) throw new GatewayPolicyError('error', `no candidate builder for role ${task.role}`);
    const candidates = build(task, ctx.world);
    const survey = SURVEY[task.role];

    const questions: Record<string, DecisionQuestion> = {};
    if (survey) questions.confidence = { type: 'score', instructions: survey.instructions, criteria: survey.rubric };
    // A choice needs at least two options; with only `hold` there is nothing to pick.
    if (candidates.length >= 2) {
      questions.bundle = {
        type: 'choice',
        instructions: CHOICE_PROMPT[task.role] ?? 'Which plan should this agent carry out this cycle?',
        criteria: Object.fromEntries(candidates.map((c) => [c.id, c.description])),
      };
    }
    const only = candidates[0];
    if (Object.keys(questions).length === 0) {
      // Nothing to ask (e.g. a government with only `hold`): no call, no cost.
      return { agentId: task.agentId, actions: only?.actions ?? [{ kind: 'pass' }], reason: `only option: ${only?.id ?? 'hold'}`, source: 'decision_model' };
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
    const chosen = bundle?.type === 'choice' ? candidates.find((c) => c.id === bundle.choice) : only;
    if (!chosen) throw new GatewayPolicyError('invalid_output', 'decision chose an unknown candidate');
    const p = bundle?.type === 'choice' ? (bundle.probabilities[bundle.choice] ?? bundle.confidence) : 1;

    const fallback = this.opts.fallback;
    const fellBack = !!fallback && this.fallbackRoles.has(task.role) && p < this.minChoice;
    this.opts.onPick?.({ agentId: task.agentId, role: task.role, choice: chosen.id, p, fellBack });
    if (fellBack) return fallback!.decide(task, ctx);

    const conf = result.answers.confidence;
    const surveyAnswer: SurveyAnswer | undefined = survey
      ? { type: survey.type, confidence: conf?.type === 'score' ? scoreToConfidence(conf.score, survey.rubric.length) : 50 }
      : undefined;

    return {
      agentId: task.agentId,
      actions: chosen.actions,
      ...(surveyAnswer ? { survey: surveyAnswer } : {}),
      ...(chosen.memo ? { memo: chosen.memo } : {}),
      reason: bundle?.type === 'choice' ? `chose ${chosen.id} (p=${p.toFixed(2)})` : `only option: ${chosen.id}`,
      source: 'decision_model',
      usage: result.usage,
    };
  }
}
