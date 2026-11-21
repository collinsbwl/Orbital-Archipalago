import { describe, expect, it } from 'vitest';
import type { GatewayRequest, ModelGateway } from '@orbital/contracts';
import { ForkGateway, MemoryRecorderSink, RecordingGateway, ReplayGateway } from '../src/recorder.js';
import { StubGateway } from '../src/stub.js';

function req(cycle: number, agentId = 'a'): GatewayRequest {
  return {
    universeId: 'u0',
    cycle,
    agentId,
    role: 'colonist',
    planet: 'helion',
    profile: 'stub',
    prefix: { system: '', tools: [] },
    context: '',
    state: '',
    deadlineMs: 1_000,
  };
}

describe('recorder / replay', () => {
  it('records and replays byte-identically', async () => {
    const inner = new StubGateway(() => ({ actions: [{ kind: 'pass' }], reason: 'stub', agentId: 'a' }));
    const sink = new MemoryRecorderSink();
    const recording = new RecordingGateway(inner, sink);
    const live = await recording.invoke(req(1), new AbortController().signal);
    expect(live.ok).toBe(true);

    const replay = new ReplayGateway().loadRows(sink.rows);
    const played = await replay.invoke(req(1), new AbortController().signal);
    expect(played).toEqual(live);
  });

  it('ReplayGateway returns error for an unrecorded call', async () => {
    const replay = new ReplayGateway().loadRows([]);
    const res = await replay.invoke(req(1), new AbortController().signal);
    expect(res.ok).toBe(false);
  });

  it('ForkGateway replays below forkCycle, runs live above', async () => {
    const parentStub: ModelGateway = {
      invoke: async () => ({ ok: true, output: 'parent', usage: { model: 'stub', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, turns: 1 }),
    };
    const liveStub: ModelGateway = {
      invoke: async () => ({ ok: true, output: 'live', usage: { model: 'stub', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 }, turns: 1 }),
    };
    const fork = new ForkGateway(parentStub, liveStub, 5);
    const pre = await fork.invoke(req(3), new AbortController().signal);
    const post = await fork.invoke(req(5), new AbortController().signal);
    expect(pre.ok && pre.output).toBe('parent');
    expect(post.ok && post.output).toBe('live');
  });
});
