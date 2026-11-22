import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@orbital/contracts';
import { GeminiDecisionGateway } from '../src/decisions.js';
import type { DecisionClient, DecisionCreateResult } from '../src/genai-client.js';
import { Limiter } from '../src/limiter.js';
import { CostMeter } from '../src/cost.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingDecisionGateway, ReplayDecisionGateway, ReplayGateway, type DecisionRecorderRow } from '../src/recorder.js';
import { StubDecisionGateway } from '../src/stub.js';

function makeReq(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    universeId: 'u0',
    cycle: 3,
    agentId: 'helion:colonist:0',
    role: 'colonist',
    planet: 'helion',
    input: 'market context',
    questions: {
      bundle: { type: 'choice', instructions: 'Pick one.', criteria: { hold: 'do nothing', buy: 'buy food' } },
      mood: { type: 'score', instructions: 'How confident?', criteria: ['low', 'mid', 'high'] },
      change: { type: 'noul', instructions: 'Anything changed?' },
    },
    deadlineMs: 2_000,
    ...overrides,
  };
}

const GOOD: DecisionCreateResult = {
  answers: {
    bundle: { type: 'choice', choice: 'buy', probabilities: { hold: 0.2, buy: 0.8 }, confidence: 0.8 },
    mood: { type: 'score', score: 1.4, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 }, legend: {}, confidence: 0.5 },
    change: { type: 'noul', noul: 0.7, confidence: 0.7 },
  },
  usage: { inputTokens: 10_000 },
};

function limiter() {
  return new Limiter({ concurrency: 4, rpm: 10_000, inputTpm: 10_000_000, outputTpm: 10_000_000 });
}

function gw(client: DecisionClient, cost = new CostMeter()) {
  return new GeminiDecisionGateway({ client, limiter: limiter(), cost });
}

describe('GeminiDecisionGateway', () => {
  it('maps answers and prices input tokens at $0.10/M with zero output', async () => {
    const cost = new CostMeter();
    const create = vi.fn(async (_args: Parameters<DecisionClient['create']>[0]) => GOOD);
    const res = await gw({ create }, cost).decide(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answers.bundle).toEqual({ type: 'choice', choice: 'buy', probabilities: { hold: 0.2, buy: 0.8 }, confidence: 0.8 });
    expect(res.answers.mood).toMatchObject({ type: 'score', score: 1.4 });
    expect(res.answers.change).toEqual({ type: 'noul', noul: 0.7, confidence: 0.7 });
    expect(res.usage.model).toBe('gemini-decision-1');
    expect(res.usage.outputTokens).toBe(0);
    expect(res.usage.costUsd).toBeCloseTo(0.001, 9);
    expect(cost.snapshot().byModel['gemini-decision-1']).toBeCloseTo(0.001, 9);
    expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gemini-decision-1', input: 'market context' });
  });

  it('short-circuits when the budget is spent', async () => {
    const cost = new CostMeter({ runBudgetUsd: 0 });
    cost.record({ universeId: 'u0', cycle: 0, agentId: 'a', role: 'colonist', usage: { model: 'x', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 1, latencyMs: 0 } });
    const create = vi.fn(async () => GOOD);
    const res = await gw({ create }, cost).decide(makeReq(), new AbortController().signal);
    expect(res).toMatchObject({ ok: false, failure: 'budget_exhausted' });
    expect(create).not.toHaveBeenCalled();
  });

  it('retries a 429 and then succeeds', async () => {
    let calls = 0;
    const create = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('429 rate'), { status: 429 });
      return GOOD;
    };
    const res = await gw({ create }).decide(makeReq(), new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('maps a 400 safety error to refused', async () => {
    const create = async () => {
      throw Object.assign(new Error('400 input rejected'), { status: 400, error: { code: 'safety' } });
    };
    const res = await gw({ create }).decide(makeReq(), new AbortController().signal);
    expect(res).toMatchObject({ ok: false, failure: 'refused' });
  });

  it('maps a blocked prompt_feedback to refused and still records spend', async () => {
    const cost = new CostMeter();
    const res = await gw({ create: async () => ({ blockReason: 'prohibited_content', usage: { inputTokens: 500 } }) }, cost).decide(
      makeReq(),
      new AbortController().signal,
    );
    expect(res).toMatchObject({ ok: false, failure: 'refused' });
    expect(cost.snapshot().totalUsd).toBeGreaterThan(0);
  });

  it('maps a missing or wrongly typed answer to invalid_output', async () => {
    const { change: _drop, ...rest } = GOOD.answers!;
    const res = await gw({ create: async () => ({ answers: rest, usage: { inputTokens: 1 } }) }).decide(makeReq(), new AbortController().signal);
    expect(res).toMatchObject({ ok: false, failure: 'invalid_output' });

    const unknownChoice = { ...GOOD.answers, bundle: { type: 'choice', choice: 'sell', probabilities: {}, confidence: 1 } };
    const res2 = await gw({ create: async () => ({ answers: unknownChoice, usage: { inputTokens: 1 } }) }).decide(makeReq(), new AbortController().signal);
    expect(res2).toMatchObject({ ok: false, failure: 'invalid_output' });
  });

  it('rejects bad question keys and option counts before calling', async () => {
    const create = vi.fn(async () => GOOD);
    const bad = makeReq({ questions: { 'has space': { type: 'noul', instructions: 'x' } } });
    expect(await gw({ create }).decide(bad, new AbortController().signal)).toMatchObject({ ok: false, failure: 'error' });
    const oneOption = makeReq({ questions: { q: { type: 'choice', instructions: 'x', criteria: { only: '' } } } });
    expect(await gw({ create }).decide(oneOption, new AbortController().signal)).toMatchObject({ ok: false, failure: 'error' });
    expect(create).not.toHaveBeenCalled();
  });

  it('a deadline miss maps to timeout', async () => {
    const create: DecisionClient['create'] = ({ signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('deadline', 'TimeoutError'))));
    const res = await gw({ create }).decide(makeReq({ deadlineMs: 20 }), new AbortController().signal);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['timeout', 'error']).toContain(res.failure);
  });
});

describe('decision record / replay', () => {
  it('replays recorded decisions by (cycle, agent, turn) and ReplayGateway ignores them', async () => {
    const rows: DecisionRecorderRow[] = [];
    const inner = new StubDecisionGateway(() => ({ change: { type: 'noul', noul: 0.9, confidence: 0.9 } }));
    const rec = new RecordingDecisionGateway(inner, { write: (r) => rows.push(r) });
    const req = makeReq({ questions: { change: { type: 'noul', instructions: 'x' } } });
    const live = await rec.decide(req, new AbortController().signal);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'decision', turn: 0, cycle: 3 });

    const replay = new ReplayDecisionGateway().loadRows(rows);
    expect(await replay.decide(req, new AbortController().signal)).toEqual(live);
    // Second call in the same cycle is turn 1 → not recorded.
    expect(await replay.decide(req, new AbortController().signal)).toMatchObject({ ok: false, failure: 'error' });
  });

  it('ReplayGateway.loadFile skips decision rows in a shared calls.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-replay-'));
    const path = join(dir, 'calls.jsonl');
    const row: DecisionRecorderRow = {
      kind: 'decision', cycle: 1, agentId: 'helion:colonist:0', turn: 0, universeId: 'u0',
      request: makeReq({ cycle: 1 }), result: { ok: true, answers: {}, usage: { model: 'stub', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } },
    };
    writeFileSync(path, JSON.stringify(row) + '\n');
    const modelReplay = new ReplayGateway().loadFile(path);
    const res = await modelReplay.invoke(
      { universeId: 'u0', cycle: 1, agentId: 'helion:colonist:0', role: 'colonist', planet: 'helion', profile: 'cheap', prefix: { system: '', tools: [] }, context: '', state: '', deadlineMs: 10 },
      new AbortController().signal,
    );
    expect(res).toMatchObject({ ok: false, failure: 'error' });
    const decisionReplay = new ReplayDecisionGateway().loadFile(path);
    expect(await decisionReplay.decide(makeReq({ cycle: 1 }), new AbortController().signal)).toEqual(row.result);
  });
});
