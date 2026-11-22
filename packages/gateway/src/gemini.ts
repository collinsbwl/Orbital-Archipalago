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
import { combinedSignal, isAbort, isTypedError, mkError, withRetries } from './util.js';

const EFFORT_BUDGET: Record<'low' | 'medium' | 'high', number> = { low: 128, medium: 512, high: 2048 };

export interface GeminiGatewayConfig {
  client: GenaiClient;
  /** Limiter per model id (pinned SKU from routing.MODEL_IDS). */
  limiters: Record<string, Limiter>;
  cache: CacheManager;
  cost: CostMeter;
  overrides?: RouteOverride[];
  /**
   * Which explicit cache to use. `planet_cycle` (DEFAULT) shares system + tools + context
   * per (model, role, planet, cycle): best when many agents on a planet call each cycle.
   * `role` caches system + tools per (model, role) for its TTL and sends context per call:
   * best when the LLM is a low-volume fallback and per-cycle caches would rarely be reused.
   */
  cacheScope?: 'planet_cycle' | 'role';
  /** Max retries on 429/5xx while the deadline covers them. DEFAULT: 3. */
  maxRetries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export class GeminiGateway implements ModelGateway {
  private readonly cfg: Required<Omit<GeminiGatewayConfig, 'overrides' | 'cacheScope'>> & {
    overrides: RouteOverride[];
    cacheScope: 'planet_cycle' | 'role';
  };

  constructor(cfg: GeminiGatewayConfig) {
    this.cfg = {
      client: cfg.client,
      limiters: cfg.limiters,
      cache: cfg.cache,
      cost: cfg.cost,
      overrides: cfg.overrides ?? [],
      cacheScope: cfg.cacheScope ?? 'planet_cycle',
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

    const { signal, cleanup } = combinedSignal(callerSignal, req.deadlineMs);
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
      // Single-flight cache for (model, role, planet, cycle). Gemini rejects a request that
      // sets tools alongside cachedContent, so the cache must hold exactly the tools the
      // mode needs: read tools + submit_turn for `tools`, none for `structured` / `text`
      // (function calling cannot be combined with a JSON response mime type).
      const prefix = { system: req.prefix.system, tools: route.mode === 'tools' ? toolLoopTools(req) : [] };
      const cache =
        this.cfg.cacheScope === 'role'
          ? await this.cfg.cache.getOrCreateRole({ model: resolved.model, role: req.role, prefix })
          : await this.cfg.cache.getOrCreatePlanetCycle({
              model: resolved.model, role: req.role, planet: req.planet, cycle: req.cycle, prefix, context: req.context,
            });
      // Only a planet-cycle cache holds the context block.
      const cacheHasContext = !!cache && this.cfg.cacheScope === 'planet_cycle';

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
        cacheHasContext,
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
    cacheHasContext?: boolean;
    usage: Usage;
    signal: AbortSignal;
  }): Promise<
    | { ok: true; output: unknown; turns: number }
    | { ok: false; failure: GatewayFailure; message: string }
  > {
    const { req, route, model, cachedContent, cacheHasContext = false, usage, signal } = args;
    // A planet-cycle cache already holds the context block; send only what it lacks.
    const opening = openingTurns(req, cacheHasContext);
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
          tools: undefined,
          contents: opening,
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
            contents: opening,
            responseMimeType: 'text/plain',
          },
          'stream',
        );
        accumulateUsage(usage, gen);
        if (gen.finishReason === 'SAFETY') return { ok: false, failure: 'refused', message: 'safety block' };
        return { ok: true, output: gen.text ?? '', turns: 1 };
      }
      // tools
      return await this.runToolLoop({ req, route, model, cachedContent, opening, usage, signal });
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
    opening: GenerateArgs['contents'];
    usage: Usage;
    signal: AbortSignal;
  }): Promise<{ ok: true; output: unknown; turns: number } | { ok: false; failure: GatewayFailure; message: string }> {
    const { req, route, model, cachedContent, opening, usage, signal } = args;
    // With a cache the tools live in it (and may not be repeated on the request).
    const tools: ToolDeclaration[] | undefined = cachedContent ? undefined : toolLoopTools(req);
    const messages: GenerateArgs['contents'] = [...opening];
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
      // Gemini needs the model's own function-call turn (with its thought signatures)
      // in the history before the responses, then one response per call, in order.
      messages.push({ role: 'model', functionCalls: gen.functionCalls, raw: gen.modelContent });
      for (const call of gen.functionCalls) {
        const toolResult = req.runTool
          ? await req.runTool(call.name, call.args)
          : { error: 'no tool runner provided' };
        messages.push({ role: 'tool', name: call.name, ...(call.id ? { id: call.id } : {}), response: toolResult });
      }
    }
    return { ok: false, failure: 'invalid_output', message: `no submit_turn within ${route.maxTurns} turns` };
  }

  /** Retry 429/5xx with jittered backoff while the deadline still covers it. */
  private async generateRetrying(args: GenerateArgs, mode: 'single' | 'stream' = 'single'): Promise<GenerateResult> {
    return withRetries(async () => {
      if (mode === 'single') return this.cfg.client.generate(args);
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
    }, args.signal, this.cfg.maxRetries);
  }
}

const SUBMIT = 'submit_turn';

/** Read tools plus the terminal `submit_turn`, whose parameters are the decision schema. */
function toolLoopTools(req: GatewayRequest): ToolDeclaration[] {
  return [
    ...req.prefix.tools,
    { name: SUBMIT, description: 'Emit the final decision; terminates the turn.', parameters: req.responseSchema ?? { type: 'object' } },
  ];
}

/** First user turns: context (unless the cache already has it) then per-agent state. */
function openingTurns(req: GatewayRequest, cacheHasContext: boolean): GenerateArgs['contents'] {
  return cacheHasContext
    ? [{ role: 'user', text: req.state }]
    : [
        { role: 'user', text: req.context },
        { role: 'user', text: req.state },
      ];
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

/** Re-exported for test convenience. */
export type { Profile, Role };
