// GeminiGateway: the real-model implementation of ModelGateway.
//
// Architecture.md §3.3-3.6: resolves a role + profile to a route and model id,
// routes to one of three call modes (structured / tools / text), caches the
// prefix single-flight, enforces the per-task deadline, retries 429/5xx while
// the deadline covers it, maps every failure to the `GatewayFailure` enum and
// fills `Usage` with input, cached and output tokens so the cost meter can
// price it.

import type {
  GatewayFailure,
  GatewayRequest,
  GatewayResult,
  ModelGateway,
  Profile,
  Role,
  Route,
  ToolDeclaration,
  Usage,
} from '@orbital/contracts';
import type { GenaiClient, GenerateArgs, GenerateResult } from './genai-client.js';
import type { Limiter } from './limiter.js';
import type { CacheManager } from './cache.js';
import { CostMeter } from './cost.js';
import { price } from './pricing.js';
import { resolve, type RouteOverride } from './routing.js';

const EFFORT_BUDGET: Record<'low' | 'medium' | 'high', number> = { low: 128, medium: 512, high: 2048 };

export interface GeminiGatewayConfig {
  client: GenaiClient;
  /** Limiter per model id (pinned SKU from routing.MODEL_IDS). */
  limiters: Record<string, Limiter>;
  cache: CacheManager;
  cost: CostMeter;
  overrides?: RouteOverride[];
  /** Max retries on 429/5xx while the deadline covers them. DEFAULT: 3. */
  maxRetries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface RetriableError extends Error {
  retriable: boolean;
  /** HTTP-ish classification for mapping. */
  kind: 'rate_limited' | 'error' | 'refused' | 'invalid_output';
}

function mkError(kind: RetriableError['kind'], retriable: boolean, message: string): RetriableError {
  const err = new Error(message) as RetriableError;
  err.kind = kind;
  err.retriable = retriable;
  return err;
}

export class GeminiGateway implements ModelGateway {
  private readonly cfg: Required<Omit<GeminiGatewayConfig, 'overrides'>> & { overrides: RouteOverride[] };

  constructor(cfg: GeminiGatewayConfig) {
    this.cfg = {
      client: cfg.client,
      limiters: cfg.limiters,
      cache: cfg.cache,
      cost: cfg.cost,
      overrides: cfg.overrides ?? [],
      maxRetries: cfg.maxRetries ?? 3,
      now: cfg.now ?? Date.now,
    };
  }

  async invoke(req: GatewayRequest, callerSignal: AbortSignal): Promise<GatewayResult> {
    if (this.cfg.cost.isBudgetExhausted()) {
      return { ok: false, failure: 'budget_exhausted', message: 'per-run budget spent' };
    }

    let resolved;
    try {
      resolved = resolve(req.role, req.profile, this.cfg.overrides, { agentId: req.agentId, planet: req.planet });
    } catch (err) {
      return { ok: false, failure: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    if (resolved.tierName === 'stub') {
      return { ok: false, failure: 'error', message: 'stub profile routed to GeminiGateway' };
    }
    const route = resolved.route;
    if (route.tier === 'rule') {
      return { ok: false, failure: 'error', message: 'rule route reached a gateway' };
    }

    const { signal, cleanup } = combinedSignal(callerSignal, req.deadlineMs, this.cfg.now);
    const start = this.cfg.now();
    const limiter = this.cfg.limiters[resolved.model];
    if (!limiter) {
      cleanup();
      return { ok: false, failure: 'error', message: `no limiter for ${resolved.model}` };
    }

    const inputEstimate = Math.ceil((req.prefix.system.length + req.context.length + req.state.length) / 4);
    const outputEstimate = route.maxTokens;

    let ticket;
    try {
      ticket = await limiter.acquire({ inputTokens: inputEstimate, outputTokens: outputEstimate }, signal);
    } catch {
      cleanup();
      return { ok: false, failure: 'timeout', message: 'limiter abort' };
    }

    try {
      // Single-flight cache for (model, role, planet, cycle).
      const cache = await this.cfg.cache.getOrCreatePlanetCycle({
        model: resolved.model,
        role: req.role,
        planet: req.planet,
        cycle: req.cycle,
        prefix: req.prefix,
        context: req.context,
      });

      const usage: Usage = {
        model: resolved.model,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      };

      const result = await this.runMode({
        req,
        route,
        model: resolved.model,
        cachedContent: cache?.name,
        usage,
        signal,
      });

      usage.latencyMs = this.cfg.now() - start;
      usage.costUsd = price(usage);

      if (result.ok) {
        ticket.release({ outputTokens: usage.outputTokens });
        this.cfg.cost.record({ universeId: req.universeId, cycle: req.cycle, agentId: req.agentId, role: req.role, usage });
        return { ok: true, output: result.output, usage, turns: result.turns };
      }
      ticket.release({ outputTokens: usage.outputTokens });
      return { ok: false, failure: result.failure, message: result.message, usage };
    } catch (err) {
      ticket.release();
      if (isAbort(err, signal, callerSignal)) {
        return { ok: false, failure: 'timeout', message: 'deadline exceeded' };
      }
      return { ok: false, failure: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      cleanup();
    }
  }

  /** Pick a call mode and run it; writes into `usage` and returns success or a typed failure. */
  private async runMode(args: {
    req: GatewayRequest;
    route: Extract<Route, { tier: 'small' | 'mid' | 'frontier' }>;
    model: string;
    cachedContent?: string;
    usage: Usage;
    signal: AbortSignal;
  }): Promise<
    | { ok: true; output: unknown; turns: number }
    | { ok: false; failure: GatewayFailure; message: string }
  > {
    const { req, route, model, cachedContent, usage, signal } = args;
    const base = {
      model,
      cachedContent,
      systemInstruction: cachedContent ? undefined : req.prefix.system,
      maxOutputTokens: route.maxTokens,
      thinkingBudget: EFFORT_BUDGET[route.effort],
      signal,
    } satisfies Partial<GenerateArgs>;

    try {
      if (route.mode === 'structured') {
        const gen = await this.generateRetrying({
          ...base,
          tools: cachedContent ? undefined : req.prefix.tools,
          contents: [
            { role: 'user', text: req.context },
            { role: 'user', text: req.state },
          ],
          responseMimeType: 'application/json',
          responseSchema: req.responseSchema,
        });
        accumulateUsage(usage, gen);
        return parseStructured(gen);
      }
      if (route.mode === 'text') {
        const gen = await this.generateRetrying(
          {
            ...base,
            tools: undefined,
            contents: [
              { role: 'user', text: req.context },
              { role: 'user', text: req.state },
            ],
            responseMimeType: 'text/plain',
          },
          'stream',
        );
        accumulateUsage(usage, gen);
        if (gen.finishReason === 'SAFETY') return { ok: false, failure: 'refused', message: 'safety block' };
        return { ok: true, output: gen.text ?? '', turns: 1 };
      }
      // tools
      return await this.runToolLoop({ req, route, model, cachedContent, usage, signal });
    } catch (err) {
      if (isTypedError(err)) return { ok: false, failure: err.kind, message: err.message };
      throw err;
    }
  }

  private async runToolLoop(args: {
    req: GatewayRequest;
    route: Extract<Route, { tier: 'small' | 'mid' | 'frontier' }>;
    model: string;
    cachedContent?: string;
    usage: Usage;
    signal: AbortSignal;
  }): Promise<{ ok: true; output: unknown; turns: number } | { ok: false; failure: GatewayFailure; message: string }> {
    const { req, route, model, cachedContent, usage, signal } = args;
    const SUBMIT = 'submit_turn';
    const tools: ToolDeclaration[] = cachedContent
      ? [{ name: SUBMIT, description: 'Emit the final decision; terminates the turn.', parameters: req.responseSchema ?? {} }]
      : [
          ...req.prefix.tools,
          { name: SUBMIT, description: 'Emit the final decision; terminates the turn.', parameters: req.responseSchema ?? {} },
        ];
    const messages: GenerateArgs['contents'] = [
      { role: 'user', text: req.context },
      { role: 'user', text: req.state },
    ];
    for (let turn = 1; turn <= route.maxTurns; turn++) {
      const gen = await this.generateRetrying({
        model,
        cachedContent,
        systemInstruction: cachedContent ? undefined : req.prefix.system,
        tools,
        contents: messages,
        thinkingBudget: EFFORT_BUDGET[route.effort],
        maxOutputTokens: route.maxTokens,
        signal,
      });
      accumulateUsage(usage, gen);
      if (gen.finishReason === 'SAFETY') return { ok: false, failure: 'refused', message: 'safety block' };

      const submit = gen.functionCalls.find((c) => c.name === SUBMIT);
      if (submit) return { ok: true, output: submit.args, turns: turn };

      if (gen.functionCalls.length === 0) {
        return { ok: false, failure: 'invalid_output', message: 'no submit_turn and no tool call' };
      }
      // Run every read tool call and feed the result back on the next turn.
      for (const call of gen.functionCalls) {
        const toolResult = req.runTool
          ? await req.runTool(call.name, call.args)
          : { error: 'no tool runner provided' };
        messages.push({ role: 'tool', name: call.name, response: toolResult });
      }
    }
    return { ok: false, failure: 'invalid_output', message: `no submit_turn within ${route.maxTurns} turns` };
  }

  /** Retry 429/5xx with jittered backoff while the deadline still covers it. */
  private async generateRetrying(args: GenerateArgs, mode: 'single' | 'stream' = 'single'): Promise<GenerateResult> {
    let lastErr: RetriableError | null = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      if (args.signal.aborted) throw mkError('error', false, 'aborted');
      try {
        if (mode === 'stream') {
          let done: GenerateResult | null = null;
          const buf: string[] = [];
          for await (const chunk of this.cfg.client.generateStream(args)) {
            if (args.signal.aborted) throw mkError('error', false, 'aborted');
            if (chunk.text) buf.push(chunk.text);
            if (chunk.done) done = chunk.done;
          }
          if (!done) throw mkError('error', false, 'stream ended without completion');
          if (done.text == null && buf.length > 0) done = { ...done, text: buf.join('') };
          return done;
        }
        return await this.cfg.client.generate(args);
      } catch (err) {
        const typed = classifyError(err);
        lastErr = typed;
        if (!typed.retriable) throw typed;
        if (attempt === this.cfg.maxRetries) throw typed;
        const backoff = Math.min(2_000, 2 ** attempt * 100) + Math.floor(Math.random() * 100);
        try {
          await sleepWithAbort(backoff, args.signal);
        } catch {
          throw mkError('error', false, 'aborted during backoff');
        }
      }
    }
    // Unreachable because the loop throws.
    throw lastErr ?? mkError('error', false, 'unknown');
  }
}

function accumulateUsage(usage: Usage, gen: GenerateResult): void {
  usage.inputTokens += gen.usage.promptTokenCount;
  usage.cachedTokens += gen.usage.cachedContentTokenCount;
  // Thinking tokens are billed as output (architecture.md §3.6).
  usage.outputTokens += gen.usage.candidatesTokenCount + gen.usage.thoughtsTokenCount;
}

function parseStructured(gen: GenerateResult): { ok: true; output: unknown; turns: number } | { ok: false; failure: GatewayFailure; message: string } {
  if (gen.finishReason === 'SAFETY') return { ok: false, failure: 'refused', message: 'safety block' };
  if (gen.text == null) return { ok: false, failure: 'invalid_output', message: 'no text in response' };
  try {
    return { ok: true, output: JSON.parse(gen.text), turns: 1 };
  } catch (err) {
    return { ok: false, failure: 'invalid_output', message: err instanceof Error ? err.message : 'json parse failed' };
  }
}

function combinedSignal(caller: AbortSignal, deadlineMs: number, now: () => number): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  if (caller.aborted) ctrl.abort(caller.reason);
  const onCaller = () => ctrl.abort(caller.reason);
  caller.addEventListener('abort', onCaller);
  const start = now();
  const timer = setTimeout(() => ctrl.abort(new DOMException('deadline', 'TimeoutError')), Math.max(0, deadlineMs));
  // Record start for retry budgeting; the timer handles the abort itself.
  void start;
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      caller.removeEventListener('abort', onCaller);
    },
  };
}

function classifyError(err: unknown): RetriableError {
  if (isTypedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  const anyErr = err as { status?: number; code?: number; name?: string } | null;
  const status = anyErr?.status ?? anyErr?.code ?? 0;
  if (anyErr?.name === 'AbortError' || anyErr?.name === 'TimeoutError') {
    return mkError('error', false, message);
  }
  if (status === 429) return mkError('rate_limited', true, message);
  if (status >= 500 && status < 600) return mkError('error', true, message);
  // Explicit safety markers from SDK errors we might see.
  if (/safety|blocked/i.test(message)) return mkError('refused', false, message);
  return mkError('error', false, message);
}

function isTypedError(err: unknown): err is RetriableError {
  return (
    err instanceof Error && typeof (err as RetriableError).retriable === 'boolean' && 'kind' in err
  );
}

function isAbort(err: unknown, mySignal: AbortSignal, callerSignal: AbortSignal): boolean {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true;
  return mySignal.aborted || callerSignal.aborted;
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Re-exported for test convenience. */
export type { Profile, Role };
