import { describe, expect, it, vi } from 'vitest';
import type { GatewayRequest } from '@orbital/contracts';
import { GeminiGateway } from '../src/gemini.js';
import type { GenaiClient, GenerateResult } from '../src/genai-client.js';
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
    [MODEL_IDS['gemini-pro']]: new Limiter({ concurrency: 10, rpm: 10_000, inputTpm: 10_000_000, outputTpm: 10_000_000 }),
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
});
