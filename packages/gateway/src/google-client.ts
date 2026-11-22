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
  const out: Content[] = [];
  for (const c of args.contents) {
    if (c.role === 'user') {
      out.push({ role: 'user', parts: [{ text: c.text }] });
    } else if (c.role === 'model') {
      // Prefer the raw content: it carries thought signatures the API wants echoed back.
      out.push(
        (c.raw as Content | undefined) ?? {
          role: 'model',
          parts: c.functionCalls.map((f) => ({ functionCall: { name: f.name, args: asRecord(f.args), ...(f.id ? { id: f.id } : {}) } })),
        },
      );
    } else {
      const part = { functionResponse: { name: c.name, response: asRecord(c.response), ...(c.id ? { id: c.id } : {}) } };
      // All responses to one model turn go back together in a single message.
      const prev = out.at(-1);
      if (prev && prev.role === 'user' && prev.parts?.every((p) => p.functionResponse)) prev.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
    }
  }
  return out;
}

function toConfig(args: GenerateArgs): GenerateContentConfig {
  return {
    abortSignal: args.signal,
    cachedContent: args.cachedContent,
    systemInstruction: args.systemInstruction,
    tools: args.tools && args.tools.length ? toTools(args.tools) : undefined,
    responseMimeType: args.responseMimeType,
    // JSON Schema route: accepts additionalProperties; unsupported keywords are folded away.
    responseJsonSchema: args.responseSchema ? toGeminiJsonSchema(args.responseSchema) : undefined,
    maxOutputTokens: args.maxOutputTokens,
    thinkingConfig: args.thinkingBudget != null ? { thinkingBudget: args.thinkingBudget } : undefined,
  };
}

function toTools(tools: ToolDeclaration[]): Tool[] | undefined {
  if (!tools.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: toGeminiJsonSchema(t.parameters) })) }];
}

function fromResponse(res: GenerateContentResponse): GenerateResult {
  const reason = res.candidates?.[0]?.finishReason;
  const finishReason: GenerateResult['finishReason'] =
    reason === 'STOP' || reason === 'MAX_TOKENS' || reason === 'SAFETY' ? reason : res.promptFeedback?.blockReason ? 'SAFETY' : 'OTHER';
  const u = res.usageMetadata;
  return {
    text: res.text ?? null,
    functionCalls: (res.functionCalls ?? []).map((c) => ({ name: c.name ?? '', args: c.args ?? {}, ...(c.id ? { id: c.id } : {}) })),
    modelContent: res.candidates?.[0]?.content,
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

/** Keywords Gemini's JSON-schema fields accept (responseJsonSchema / parametersJsonSchema). */
const SUPPORTED_KEYS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
  'propertyOrdering',
]);

/**
 * Reduce a zod-to-json-schema output (openApi3 or JSON Schema 7) to what Gemini accepts.
 * Dropped constraints are still enforced by the zod parse after the call; length limits
 * are kept as a hint in `description` so the model tends to respect them.
 */
export function toGeminiJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SUPPORTED_KEYS.has(k)) continue;
    if (k === 'properties' || k === '$defs') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiJsonSchema(pv)]));
    } else if (k === 'additionalProperties' && typeof v === 'object') {
      out[k] = toGeminiJsonSchema(v);
    } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'prefixItems') {
      out[k] = toGeminiJsonSchema(v);
    } else {
      out[k] = v;
    }
  }
  // exclusiveMinimum: number (JSON Schema 7) or boolean + minimum (openApi3).
  const exMin = s.exclusiveMinimum;
  if (typeof exMin === 'number') out.minimum = s.type === 'integer' ? exMin + 1 : exMin;
  else if (exMin === true && typeof s.minimum === 'number' && s.type === 'integer') out.minimum = s.minimum + 1;
  const exMax = s.exclusiveMaximum;
  if (typeof exMax === 'number') out.maximum = s.type === 'integer' ? exMax - 1 : exMax;
  else if (exMax === true && typeof s.maximum === 'number' && s.type === 'integer') out.maximum = s.maximum - 1;
  // openApi3 nullable → anyOf with null.
  if (s.nullable === true) return { anyOf: [out, { type: 'null' }] };
  const hints = [
    typeof s.maxLength === 'number' ? `at most ${s.maxLength} characters` : '',
    typeof s.minLength === 'number' && s.minLength > 0 ? `at least ${s.minLength} characters` : '',
  ].filter(Boolean);
  if (hints.length) out.description = [out.description, `(${hints.join(', ')})`].filter(Boolean).join(' ');
  return out;
}
