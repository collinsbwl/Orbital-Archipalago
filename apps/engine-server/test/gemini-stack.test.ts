// The server's real Gemini stack (makeAgents → DefaultAgentRuntime → GeminiGateway /
// GeminiDecisionGateway → GoogleGenaiClient) driving a live Universe. Only the SDK
// object is faked, and the fake enforces the request rules the real API rejects with
// a 400, so this is the closest check to a live run that needs no API key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { GoogleGenaiClient, type GenAiLike } from '@orbital/gateway';
import { Universe } from '@orbital/engine';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { GeminiAgents, makeAgents } from '../src/agents.js';

/** Keywords Gemini's responseJsonSchema / parametersJsonSchema accept. */
const SCHEMA_KEYS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
  'propertyOrdering',
]);

type Part = { text?: string; functionCall?: unknown; functionResponse?: unknown };
type Content = { role: string; parts: Part[] };
type Decl = { name: string; parametersJsonSchema?: unknown; parameters?: unknown };

function strictFakeSdk() {
  const violations: string[] = [];
  const calls = { generate: 0, decide: 0, cache: 0, cachedRequests: 0, toolRounds: 0 };
  const toolAnswers: unknown[] = [];
  const cachedTools = new Map<string, Decl[]>();
  const roles = new Map<string, number>();

  const fail = (msg: string): never => {
    violations.push(msg);
    throw Object.assign(new Error(`400 INVALID_ARGUMENT: ${msg}`), { status: 400 });
  };

  const checkSchema = (s: unknown, path: string): void => {
    if (Array.isArray(s)) return s.forEach((x, i) => checkSchema(x, `${path}[${i}]`));
    if (typeof s !== 'object' || s === null) return;
    for (const [k, v] of Object.entries(s)) {
      if (!SCHEMA_KEYS.has(k)) fail(`unsupported schema keyword ${path}.${k}`);
      if (k === 'properties' || k === '$defs') for (const [pk, pv] of Object.entries(v as object)) checkSchema(pv, `${path}.${pk}`);
      else if (typeof v === 'object') checkSchema(v, `${path}.${k}`);
    }
  };

  const checkDecls = (decls: Decl[] | undefined, where: string) => {
    for (const d of decls ?? []) {
      if (d.parameters) fail(`${where}: use parametersJsonSchema, not parameters`);
      checkSchema(d.parametersJsonSchema, `${where}.${d.name}`);
    }
  };

  const ai = {
    models: {
      generateContent: async ({ contents, config }: { model: string; contents: Content[]; config: Record<string, any> }) => {
        calls.generate++;
        if (config.cachedContent && (config.tools || config.systemInstruction)) fail('cachedContent with tools/systemInstruction');
        if (config.responseMimeType === 'application/json' && config.tools) fail('function calling with JSON mime type');
        if (config.responseSchema) fail('responseSchema (OpenAPI) does not accept additionalProperties');
        if (config.responseJsonSchema) checkSchema(config.responseJsonSchema, 'response');
        const decls: Decl[] | undefined = config.tools?.[0]?.functionDeclarations ?? cachedTools.get(config.cachedContent);
        checkDecls(config.tools?.[0]?.functionDeclarations, 'tools');
        contents.forEach((c, i) => {
          const responses = c.parts.filter((p) => p.functionResponse).length;
          if (!responses) return;
          if (responses !== c.parts.length) fail('function responses mixed with other parts');
          const prev = contents[i - 1];
          const callsMade = prev?.role === 'model' ? prev.parts.filter((p) => p.functionCall).length : 0;
          if (callsMade !== responses) fail(`turn ${i}: ${responses} function responses after ${callsMade} function calls`);
        });

        if (config.cachedContent) calls.cachedRequests++;
        const usageMetadata = { promptTokenCount: 1_200, candidatesTokenCount: 60, thoughtsTokenCount: 120 };
        const decision = { actions: [{ kind: 'pass' }], reason: 'flash reviewed and held' };
        const answered = contents.flatMap((c) => c.parts.filter((p) => p.functionResponse));
        // Traders: price a route first (one tool round), then submit.
        if (decls?.some((d) => d.name === 'quote_route') && answered.length === 0) {
          const text = contents.map((c) => c.parts.map((p) => p.text ?? '').join('')).join('\n');
          const home = /Planet (\w+), cycle/.exec(text)?.[1] ?? 'helion';
          const good = /^- (\w+): last=/m.exec(text)?.[1] ?? 'grain';
          const to = ['helion', 'verdan', 'tethys'].find((p) => p !== home)!;
          const call = { name: 'quote_route', args: { to, good, qty: 3 }, id: `q-${calls.generate}` };
          calls.toolRounds++;
          return {
            functionCalls: [call],
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: call, thoughtSignature: 'sig' }] } }],
            usageMetadata,
          };
        }
        for (const p of answered) toolAnswers.push((p.functionResponse as { response: unknown }).response);
        if (decls?.some((d) => d.name === 'submit_turn')) {
          const call = { name: 'submit_turn', args: decision, id: `call-${calls.generate}` };
          return {
            functionCalls: [call],
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: call, thoughtSignature: 'sig' }] } }],
            usageMetadata,
          };
        }
        return { text: JSON.stringify(decision), candidates: [{ finishReason: 'STOP' }], usageMetadata };
      },
      generateContentStream: async () => fail('stream not expected in this run'),
    },
    caches: {
      create: async ({ config }: { model: string; config: { tools?: Array<{ functionDeclarations: Decl[] }> } }) => {
        calls.cache++;
        checkDecls(config.tools?.[0]?.functionDeclarations, 'cache.tools');
        const name = `cachedContents/${calls.cache}`;
        cachedTools.set(name, config.tools?.[0]?.functionDeclarations ?? []);
        return { name };
      },
    },
    decisions: {
      create: async (
        body: { model: string; input: string; questions: Record<string, { type: string; criteria?: unknown }> },
        opts: { retry_codes?: string[] },
      ) => {
        calls.decide++;
        if (body.model !== 'gemini-decision-1') fail(`unknown decision model ${body.model}`);
        if (!Array.isArray(opts?.retry_codes) || opts.retry_codes.length) fail('SDK retries should be off; the gateway retries');
        const role = /# You are (?:a planet's |an |a )?(\w+)/.exec(body.input)?.[1] ?? 'unknown';
        roles.set(role, (roles.get(role) ?? 0) + 1);
        const answers: Record<string, unknown> = {};
        for (const [key, q] of Object.entries(body.questions)) {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) fail(`bad question key ${key}`);
          if (q.type === 'choice') {
            const ids = Object.keys(q.criteria as object);
            if (ids.length < 2 || ids.length > 255) fail(`choice ${key} has ${ids.length} options`);
            // Colonists get a confident pick; traders and governments an unsure one, so they defer to Flash.
            const p = role === 'colonist' ? 0.9 : 0.25;
            answers[key] = { type: 'choice', choice: ids[0], probabilities: { [ids[0]!]: p }, confidence: p };
          } else if (q.type === 'score') {
            answers[key] = { type: 'score', score: 2, probabilities: { '2': 0.6 }, legend: {}, confidence: 0.6 };
          } else if (q.type === 'noul') {
            answers[key] = { type: 'noul', noul: 0.2, confidence: 0.8 };
          } else {
            fail(`unknown question type ${q.type}`);
          }
        }
        return { answers, usage: { total_input_tokens: Math.ceil(body.input.length / 4), total_output_tokens: 0 } };
      },
    },
  };
  return { ai: ai as unknown as GenAiLike, violations, calls, roles, toolAnswers };
}

describe('the real Gemini stack against a strict fake SDK', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.GATEWAY_PROFILE = 'cheap';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.RECORD_DIR;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('runs cycles with only API-valid requests: decisions for everyone, Flash for unsure traders/governments', async () => {
    const fake = strictFakeSdk();
    const world = DEFAULT_WORLD;
    const agents = makeAgents(world, { client: new GoogleGenaiClient({ ai: fake.ai }) });
    expect(agents).toBeInstanceOf(GeminiAgents);

    const sources = new Map<string, number>();
    const wrapped = {
      decideAll: async (tasks: Parameters<GeminiAgents['decideAll']>[0]) => {
        const out = await agents.decideAll(tasks);
        for (const d of out) sources.set(d.source, (sources.get(d.source) ?? 0) + 1);
        return out;
      },
      costUsd: () => agents.costUsd?.() ?? 0,
    };
    const universe = new Universe({ world, ledger: new InMemoryLedger(world), agents: wrapped });
    await universe.init();
    // Governments only ask when they have a move to weigh; a god-mode tariff gives Verdan's one.
    universe.enqueue({ kind: 'tariff', planet: 'verdan', good: 'grain', rateBp: 2_000 }, { sub: 'test' });
    let rejections = 0;
    for (let c = 0; c < 16; c++) rejections += (await universe.step()).rejections;

    expect(fake.violations).toEqual([]);
    expect(fake.calls.decide).toBeGreaterThan(0);
    expect(fake.calls.generate).toBeGreaterThan(0);
    expect([...fake.roles.keys()].sort()).toEqual(['colonist', 'government', 'trader']);
    // Colonists stay on the decision model; unsure traders/governments went to Flash and back.
    expect(sources.get('decision_model')).toBeGreaterThan(0);
    expect(sources.get('llm')).toBeGreaterThan(0);
    expect(sources.get('standing_orders') ?? 0).toBe(0);
    expect(rejections).toBe(0);

    // Read tools: traders priced routes with real cross-planet data before submitting.
    expect(fake.calls.toolRounds).toBeGreaterThan(0);
    expect(fake.toolAnswers.length).toBe(fake.calls.toolRounds);
    const quotes = fake.toolAnswers as Array<Record<string, unknown>>;
    expect(quotes.every((q) => typeof q.travelCycles === 'number' && q.travelCycles >= 1)).toBe(true);
    expect(quotes.some((q) => typeof q.marginInHome === 'number')).toBe(true);

    // Caching: role caches (system + tools, ~1.6k tokens) are created once and reused.
    expect(fake.calls.cache).toBeGreaterThan(0);
    expect(fake.calls.cache).toBeLessThanOrEqual(4); // trader + government (+ policy-cycle variant)
    expect(fake.calls.cachedRequests).toBe(fake.calls.generate);

    // Spend: the CostMeter's total reaches the Snapshot (and so the dashboard and Tiger's gateway_cost).
    const spend = (await universe.snapshot({ series: [] })).gatewayCostUsd;
    expect(spend).toBeGreaterThan(0);
    expect(spend).toBe(agents.costUsd?.());
  }, 30_000);
});
