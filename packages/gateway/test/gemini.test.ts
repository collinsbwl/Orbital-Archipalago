import { describe, expect, it, vi } from 'vitest';
import type { GatewayRequest } from '@orbital/contracts';
import { GeminiGateway } from '../src/gemini.js';
import type { GenaiClient, GenerateArgs, GenerateResult } from '../src/genai-client.js';
import type { CacheCreateArgs } from '../src/cache.js';
import { Limiter } from '../src/limiter.js';
import { CacheManager } from '../src/cache.js';
import { CostMeter } from '../src/cost.js';
import { MODEL_IDS } from '../src/routing.js';

function makeReq(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    universeId: 'u0',
    cycle: 1,
    agentId: 'helion:colonist:1',
    role: 'colonist',
    planet: 'helion',
    profile: 'full',
    prefix: { system: 'a'.repeat(5_000), tools: [] },
    context: 'market context',
    state: '{"purse":{"HLX":1000}}',
    responseSchema: { type: 'object' },
    deadlineMs: 5_000,
    ...overrides,
  };
}

function defaultLimiters() {
  return {
    [MODEL_IDS['gemini-flash']]: new Limiter({ concurrency: 10, rpm: 10_000, inputTpm: 10_000_000, outputTpm: 10_000_000 }),
  };
}

function usage(): GenerateResult['usage'] {
  return { promptTokenCount: 200, cachedContentTokenCount: 150, candidatesTokenCount: 50, thoughtsTokenCount: 20 };
}

describe('GeminiGateway', () => {
  it('structured mode parses JSON output', async () => {
    const client: GenaiClient = {
      generate: vi.fn(async () => ({
        text: '{"actions":[{"kind":"pass"}],"reason":"idle"}',
        functionCalls: [],
        finishReason: 'STOP' as const,
        usage: usage(),
      })),
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost: new CostMeter(),
    });
    const res = await gw.invoke(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output).toEqual({ actions: [{ kind: 'pass' }], reason: 'idle' });
      expect(res.usage.cachedTokens).toBe(150);
      // Thinking tokens are billed as output.
      expect(res.usage.outputTokens).toBe(70);
    }
  });

  it('invalid JSON maps to invalid_output', async () => {
    const client: GenaiClient = {
      generate: async () => ({ text: 'not json', functionCalls: [], finishReason: 'STOP', usage: usage() }),
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost: new CostMeter(),
    });
    const res = await gw.invoke(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid_output');
  });

  it('safety block maps to refused', async () => {
    const client: GenaiClient = {
      generate: async () => ({ text: null, functionCalls: [], finishReason: 'SAFETY', usage: usage() }),
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost: new CostMeter(),
    });
    const res = await gw.invoke(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('refused');
  });

  it('tool loop terminates on submit_turn', async () => {
    let turn = 0;
    const client: GenaiClient = {
      generate: async () => {
        turn++;
        if (turn === 1) {
          return {
            text: null,
            functionCalls: [{ name: 'quote_route', args: { from: 'helion', to: 'verdan' } }],
            finishReason: 'STOP',
            usage: usage(),
          };
        }
        return {
          text: null,
          functionCalls: [{ name: 'submit_turn', args: { actions: [{ kind: 'pass' }], reason: 'quoted' } }],
          finishReason: 'STOP',
          usage: usage(),
        };
      },
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost: new CostMeter(),
    });
    const runTool = vi.fn(async () => ({ price: 123 }));
    const res = await gw.invoke(
      makeReq({ role: 'trader', prefix: { system: 'a'.repeat(5_000), tools: [{ name: 'quote_route', description: '', parameters: {} }] }, runTool }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.turns).toBe(2);
    expect(runTool).toHaveBeenCalledWith('quote_route', { from: 'helion', to: 'verdan' });
  });

  it('tool loop without submit_turn hits invalid_output at maxTurns', async () => {
    const client: GenaiClient = {
      generate: async () => ({
        text: null,
        functionCalls: [{ name: 'quote_route', args: {} }],
        finishReason: 'STOP',
        usage: usage(),
      }),
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost: new CostMeter(),
    });
    const res = await gw.invoke(
      makeReq({ role: 'trader', prefix: { system: 'a'.repeat(5_000), tools: [{ name: 'quote_route', description: '', parameters: {} }] }, runTool: async () => ({}) }),
      new AbortController().signal,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid_output');
  });

  it('short-circuits on budget_exhausted', async () => {
    const cost = new CostMeter({ runBudgetUsd: 0.0000001 });
    cost.record({
      universeId: 'u0',
      cycle: 1,
      agentId: 'x',
      role: 'colonist',
      usage: { model: 'gemini-2.5-flash', inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd: 1, latencyMs: 1 },
    });
    const client: GenaiClient = {
      generate: vi.fn(),
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost,
    });
    const res = await gw.invoke(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('budget_exhausted');
    expect(client.generate).not.toHaveBeenCalled();
  });

  it('retries 429 and succeeds', async () => {
    let n = 0;
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const client: GenaiClient = {
      generate: async () => {
        n++;
        if (n < 2) throw err;
        return { text: '{"actions":[],"reason":"ok"}', functionCalls: [], finishReason: 'STOP', usage: usage() };
      },
      generateStream: async function* () {},
    };
    const gw = new GeminiGateway({
      client,
      limiters: defaultLimiters(),
      cache: new CacheManager({ client: { create: async () => ({ name: 'c1' }) } }),
      cost: new CostMeter(),
    });
    const res = await gw.invoke(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(true);
  });

  describe('requests the real API accepts', () => {
    const traderTools = [{ name: 'quote_route', description: 'quote', parameters: { type: 'object' } }];

    function recordingClient(responses: GenerateResult[]) {
      const calls: GenerateArgs[] = [];
      const client: GenaiClient = {
        generate: async (args) => {
          // Snapshot: the gateway keeps appending to the same contents array.
          calls.push({ ...args, contents: [...args.contents] });
          return responses[Math.min(calls.length - 1, responses.length - 1)]!;
        },
        generateStream: async function* () {},
      };
      return { client, calls };
    }

    it('tool loop sends the model turn (raw, with ids) before the tool responses', async () => {
      const raw = { role: 'model', parts: [{ functionCall: { name: 'quote_route', args: {}, id: 'c1' }, thoughtSignature: 'sig' }] };
      const { client, calls } = recordingClient([
        {
          text: null,
          functionCalls: [
            { name: 'quote_route', args: { to: 'verdan' }, id: 'c1' },
            { name: 'quote_route', args: { to: 'tethys' }, id: 'c2' },
          ],
          modelContent: raw,
          finishReason: 'STOP',
          usage: usage(),
        },
        { text: null, functionCalls: [{ name: 'submit_turn', args: { actions: [{ kind: 'pass' }], reason: 'ok' } }], finishReason: 'STOP', usage: usage() },
      ]);
      const gw = new GeminiGateway({ client, limiters: defaultLimiters(), cache: new CacheManager({ client: { create: async () => { throw new Error('no cache'); } } }), cost: new CostMeter() });
      const res = await gw.invoke(makeReq({ role: 'trader', prefix: { system: 'a'.repeat(5_000), tools: traderTools }, runTool: async (_n, a) => ({ quoted: a }) }), new AbortController().signal);
      expect(res.ok).toBe(true);
      const second = calls[1]!.contents;
      expect(second.map((c) => c.role)).toEqual(['user', 'user', 'model', 'tool', 'tool']);
      expect(second[2]).toMatchObject({ role: 'model', raw });
      expect(second[3]).toMatchObject({ role: 'tool', name: 'quote_route', id: 'c1', response: { quoted: { to: 'verdan' } } });
      expect(second[4]).toMatchObject({ id: 'c2' });
      // Uncached: tools (read + submit_turn) ride on every request.
      expect(calls[0]!.tools!.map((t) => t.name)).toEqual(['quote_route', 'submit_turn']);
    });

    it('with a cache, tools mode puts submit_turn in the cache and sends no tools, system or context', async () => {
      const created: CacheCreateArgs[] = [];
      const { client, calls } = recordingClient([
        { text: null, functionCalls: [{ name: 'submit_turn', args: { actions: [{ kind: 'pass' }], reason: 'ok' } }], finishReason: 'STOP', usage: usage() },
      ]);
      const gw = new GeminiGateway({
        client, limiters: defaultLimiters(), cost: new CostMeter(),
        cache: new CacheManager({ client: { create: async (a) => { created.push(a); return { name: 'cachedContents/x' }; } } }),
      });
      const res = await gw.invoke(makeReq({ role: 'trader', prefix: { system: 'a'.repeat(5_000), tools: traderTools } }), new AbortController().signal);
      expect(res.ok).toBe(true);
      expect(created[0]!.tools.map((t) => t.name)).toEqual(['quote_route', 'submit_turn']);
      expect(calls[0]).toMatchObject({ cachedContent: 'cachedContents/x', tools: undefined, systemInstruction: undefined });
      expect(calls[0]!.contents).toEqual([{ role: 'user', text: makeReq().state }]);
    });

    it('role cache scope: one cache of system + tools per role, context and state sent per call', async () => {
      const created: CacheCreateArgs[] = [];
      const { client, calls } = recordingClient([
        { text: null, functionCalls: [{ name: 'submit_turn', args: { actions: [{ kind: 'pass' }], reason: 'ok' } }], finishReason: 'STOP', usage: usage() },
      ]);
      const gw = new GeminiGateway({
        client, limiters: defaultLimiters(), cost: new CostMeter(), cacheScope: 'role',
        cache: new CacheManager({ client: { create: async (a) => { created.push(a); return { name: 'cachedContents/role' }; } } }),
      });
      const req = makeReq({ role: 'trader', prefix: { system: 'a'.repeat(5_000), tools: traderTools } });
      await gw.invoke(req, new AbortController().signal);
      await gw.invoke({ ...req, planet: 'verdan', cycle: 2, agentId: 'verdan:trader:0' }, new AbortController().signal);
      expect(created).toHaveLength(1); // reused across planets and cycles
      expect(created[0]).toMatchObject({ context: '' });
      expect(created[0]!.tools.map((t) => t.name)).toEqual(['quote_route', 'submit_turn']);
      expect(calls[0]).toMatchObject({ cachedContent: 'cachedContents/role', tools: undefined, systemInstruction: undefined });
      expect(calls[0]!.contents).toEqual([{ role: 'user', text: req.context }, { role: 'user', text: req.state }]);
    });

    it('structured mode never sends or caches tools (JSON mime type + function calling is rejected)', async () => {
      const created: CacheCreateArgs[] = [];
      const ok: GenerateResult = { text: '{"actions":[],"reason":"x"}', functionCalls: [], finishReason: 'STOP', usage: usage() };
      const uncached = recordingClient([ok]);
      await new GeminiGateway({ client: uncached.client, limiters: defaultLimiters(), cost: new CostMeter(), cache: new CacheManager({ client: { create: async () => { throw new Error('x'); } } }) })
        .invoke(makeReq({ prefix: { system: 'a'.repeat(5_000), tools: traderTools } }), new AbortController().signal);
      expect(uncached.calls[0]!.tools).toBeUndefined();

      const cached = recordingClient([ok]);
      await new GeminiGateway({
        client: cached.client, limiters: defaultLimiters(), cost: new CostMeter(),
        cache: new CacheManager({ client: { create: async (a) => { created.push(a); return { name: 'c' }; } } }),
      }).invoke(makeReq({ prefix: { system: 'a'.repeat(5_000), tools: traderTools } }), new AbortController().signal);
      expect(created[0]!.tools).toEqual([]);
      expect(cached.calls[0]!.tools).toBeUndefined();
    });
  });
});