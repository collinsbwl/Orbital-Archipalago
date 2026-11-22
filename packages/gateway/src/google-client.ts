// GoogleGenaiClient: the one place that touches @google/genai. It implements
// the narrow GenaiClient, CacheClient and DecisionClient surfaces the gateways
// depend on, so tests never need the SDK and SDK upgrades stay contained here.

import { GoogleGenAI, type Content, type GenerateContentConfig, type GenerateContentResponse, type Tool } from '@google/genai';
import type { ToolDeclaration } from '@orbital/contracts';
import type { CacheClient, CacheCreateArgs } from './cache.js';
import type {
  DecisionClient,
  DecisionCreateArgs,
  DecisionCreateResult,
  GenaiClient,
  GenerateArgs,
  GenerateResult,
} from './genai-client.js';

/** The slice of GoogleGenAI used here; tests pass a fake with the same shape. */
export type GenAiLike = Pick<GoogleGenAI, 'models' | 'caches' | 'decisions'>;

export interface GoogleGenaiClientOpts {
  /** Defaults to `GEMINI_API_KEY` from the environment. Ignored when `ai` is given. */
  apiKey?: string;
  /** Inject a prebuilt client (tests). */
  ai?: GenAiLike;
}

export class GoogleGenaiClient implements GenaiClient {
  private readonly ai: GenAiLike;

  constructor(opts: GoogleGenaiClientOpts = {}) {
    if (opts.ai) {
      this.ai = opts.ai;
    } else {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GoogleGenaiClient needs an apiKey or GEMINI_API_KEY');
      // v1beta: the Decisions API is only on the beta surface.
      this.ai = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
    }
  }

  // ---------------------------------------------------------------- generate

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    const res = await this.ai.models.generateContent({ model: args.model, contents: toContents(args), config: toConfig(args) });
    return fromResponse(res);
  }

  async *generateStream(args: GenerateArgs): AsyncIterable<{ text?: string; done?: GenerateResult }> {
    const stream = await this.ai.models.generateContentStream({ model: args.model, contents: toContents(args), config: toConfig(args) });
    let last: GenerateContentResponse | null = null;
    const texts: string[] = [];
    for await (const chunk of stream) {
      last = chunk;
      const text = chunk.text;
      if (text) {
        texts.push(text);
        yield { text };
      }
    }
    if (!last) throw new Error('empty stream');
    // Usage and finishReason arrive on the final chunk; text is the concatenation.
    yield { done: { ...fromResponse(last), text: texts.length ? texts.join('') : null } };
  }

  // ------------------------------------------------------------------ caches

  /** CacheClient for the GeminiGateway's CacheManager. */
  readonly caches: CacheClient = { create: (args) => this.createCache(args) };

  /** DecisionClient for the GeminiDecisionGateway. */
  readonly decisions: DecisionClient = { create: (args) => this.decide(args) };

  private async createCache(args: CacheCreateArgs): Promise<{ name: string }> {
    const cache = await this.ai.caches.create({
      model: args.model,
      config: {
        systemInstruction: args.systemInstruction,
        tools: toTools(args.tools),
        contents: args.context ? [{ role: 'user', parts: [{ text: args.context }] }] : undefined,
        ttl: `${args.ttlSeconds}s`,
      },
    });
    if (!cache.name) throw new Error('cache created without a name');
    return { name: cache.name };
  }

  // --------------------------------------------------------------- decisions

  private async decide(args: DecisionCreateArgs): Promise<DecisionCreateResult> {
    const res = await this.ai.decisions.create(
      { model: args.model, input: args.input, questions: args.questions },
      // The gateway owns retries (deadline-aware), so turn the SDK's off.
      { signal: args.signal, retry_codes: [] },
    );
    return {
      answers: res.answers as Record<string, unknown> | undefined,
      blockReason: res.prompt_feedback?.block_reason ?? undefined,
      usage: { inputTokens: res.usage?.total_input_tokens ?? 0 },
    };
  }
}

// ------------------------------------------------------------------ mapping

function toContents(args: GenerateArgs): Content[] {
  return args.contents.map((c) =>
    c.role === 'user'
      ? { role: 'user', parts: [{ text: c.text }] }
      : { role: 'user', parts: [{ functionResponse: { name: c.name, response: asRecord(c.response) } }] },
  );
}

function toConfig(args: GenerateArgs): GenerateContentConfig {
  return {
    abortSignal: args.signal,
    cachedContent: args.cachedContent,
    systemInstruction: args.systemInstruction,
    tools: args.tools && args.tools.length ? toTools(args.tools) : undefined,
    responseMimeType: args.responseMimeType,
    // PromptBuilder emits an OpenAPI 3 schema (zod-to-json-schema, target openApi3).
    responseSchema: args.responseSchema as GenerateContentConfig['responseSchema'],
    maxOutputTokens: args.maxOutputTokens,
    thinkingConfig: args.thinkingBudget != null ? { thinkingBudget: args.thinkingBudget } : undefined,
  };
}

function toTools(tools: ToolDeclaration[]): Tool[] | undefined {
  if (!tools.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
}

function fromResponse(res: GenerateContentResponse): GenerateResult {
  const reason = res.candidates?.[0]?.finishReason;
  const finishReason: GenerateResult['finishReason'] =
    reason === 'STOP' || reason === 'MAX_TOKENS' || reason === 'SAFETY' ? reason : res.promptFeedback?.blockReason ? 'SAFETY' : 'OTHER';
  const u = res.usageMetadata;
  return {
    text: res.text ?? null,
    functionCalls: (res.functionCalls ?? []).map((c) => ({ name: c.name ?? '', args: c.args ?? {} })),
    finishReason,
    usage: {
      promptTokenCount: u?.promptTokenCount ?? 0,
      cachedContentTokenCount: u?.cachedContentTokenCount ?? 0,
      candidatesTokenCount: u?.candidatesTokenCount ?? 0,
      thoughtsTokenCount: u?.thoughtsTokenCount ?? 0,
    },
  };
}

function asRecord(x: unknown): Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : { result: x };
}
