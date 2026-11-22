// GeminiDecisionGateway: the DecisionGateway over Gemini Decision 1.
//
// Same shell as GeminiGateway (budget check → limiter → deadline → retries →
// typed failure → cost meter) but one call mode: a batch of closed-set
// questions over one shared input. No caching, tools or thinking; output
// tokens are always 0, so a call costs input tokens × $0.10/M.

import type {
  DecisionAnswer,
  DecisionGateway,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  Usage,
} from '@orbital/contracts';
import type { DecisionClient } from './genai-client.js';
import type { Limiter } from './limiter.js';
import type { CostMeter } from './cost.js';
import { price } from './pricing.js';
import { DECISION_MODEL_ID } from './routing.js';
import { combinedSignal, isAbort, isTypedError, withRetries } from './util.js';

export interface GeminiDecisionGatewayConfig {
  client: DecisionClient;
  /** Limiter for `gemini-decision-1`. */
  limiter: Limiter;
  cost: CostMeter;
  /** Override the pinned model id (tests, future SKUs). */
  model?: string;
  /** Max retries on 429/5xx while the deadline covers them. DEFAULT: 3. */
  maxRetries?: number;
  now?: () => number;
}

const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export class GeminiDecisionGateway implements DecisionGateway {
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly now: () => number;

  constructor(private readonly cfg: GeminiDecisionGatewayConfig) {
    this.model = cfg.model ?? DECISION_MODEL_ID;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.now = cfg.now ?? Date.now;
  }

  async decide(req: DecisionRequest, callerSignal: AbortSignal): Promise<DecisionResult> {
    if (this.cfg.cost.isBudgetExhausted()) {
      return { ok: false, failure: 'budget_exhausted', message: 'per-run budget spent' };
    }
    const invalid = validateQuestions(req.questions);
    if (invalid) return { ok: false, failure: 'error', message: invalid };

    const { signal, cleanup } = combinedSignal(callerSignal, req.deadlineMs);
    const start = this.now();
    const inputEstimate = Math.ceil((req.input.length + JSON.stringify(req.questions).length) / 4);

    let ticket;
    try {
      ticket = await this.cfg.limiter.acquire({ inputTokens: inputEstimate, outputTokens: 0 }, signal);
    } catch {
      cleanup();
      return { ok: false, failure: 'timeout', message: 'limiter abort' };
    }

    const usage: Usage = { model: this.model, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    try {
      const res = await withRetries(
        () => this.cfg.client.create({ model: this.model, input: req.input, questions: req.questions, signal }),
        signal,
        this.maxRetries,
      );
      usage.inputTokens = res.usage.inputTokens;
      usage.latencyMs = this.now() - start;
      usage.costUsd = price(usage);
      // Blocked input is still billed; record it before returning the failure.
      this.cfg.cost.record({ universeId: req.universeId, cycle: req.cycle, agentId: req.agentId, role: req.role, usage });

      if (res.blockReason) return { ok: false, failure: 'refused', message: `input blocked: ${res.blockReason}`, usage };
      const parsed = parseAnswers(req.questions, res.answers);
      if (typeof parsed === 'string') return { ok: false, failure: 'invalid_output', message: parsed, usage };
      return { ok: true, answers: parsed, usage };
    } catch (err) {
      if (isTypedError(err)) return { ok: false, failure: err.kind, message: err.message };
      if (isAbort(err, signal, callerSignal)) return { ok: false, failure: 'timeout', message: 'deadline exceeded' };
      return { ok: false, failure: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      ticket.release({ outputTokens: 0 });
      cleanup();
    }
  }
}

function validateQuestions(qs: Record<string, DecisionQuestion>): string | null {
  const keys = Object.keys(qs);
  if (keys.length < 1 || keys.length > 1_000) return `need 1-1000 questions, got ${keys.length}`;
  for (const k of keys) {
    if (!QUESTION_KEY.test(k)) return `bad question key: ${k}`;
    const q = qs[k]!;
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria).length;
      if (n < 2 || n > 255) return `choice ${k} needs 2-255 options, got ${n}`;
    }
    if (q.type === 'score' && (q.criteria.length < 2 || q.criteria.length > 255)) {
      return `score ${k} needs 2-255 levels, got ${q.criteria.length}`;
    }
  }
  return null;
}

/** Check every question got an answer of the right type; return the typed map or an error message. */
function parseAnswers(
  qs: Record<string, DecisionQuestion>,
  raw: Record<string, unknown> | undefined,
): Record<string, DecisionAnswer> | string {
  if (!raw) return 'no answers in response';
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, q] of Object.entries(qs)) {
    const a = raw[key] as Record<string, unknown> | undefined;
    if (!a || a.type !== q.type) return `answer ${key} missing or not ${q.type}`;
    const confidence = num(a.confidence);
    if (confidence == null) return `answer ${key} has no confidence`;
    if (q.type === 'noul') {
      const p = num(a.noul);
      if (p == null) return `answer ${key} has no noul`;
      out[key] = { type: 'noul', noul: p, confidence };
    } else if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !(a.choice in q.criteria)) return `answer ${key} chose an unknown option`;
      out[key] = { type: 'choice', choice: a.choice, probabilities: probs(a.probabilities), confidence };
    } else {
      const score = num(a.score);
      if (score == null) return `answer ${key} has no score`;
      out[key] = { type: 'score', score, probabilities: probs(a.probabilities), confidence };
    }
  }
  return out;
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function probs(x: unknown): Record<string, number> {
  if (typeof x !== 'object' || x === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(x)) if (typeof v === 'number') out[k] = v;
  return out;
}
