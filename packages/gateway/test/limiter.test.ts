import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/limiter.js';

describe('Limiter', () => {
  it('caps concurrency and drains in order', async () => {
    const lim = new Limiter({ concurrency: 2, rpm: 10_000, inputTpm: 10_000_000, outputTpm: 10_000_000 });
    const held: number[] = [];
    const ctrl = new AbortController();
    const tickets = await Promise.all([
      lim.acquire({ inputTokens: 10, outputTokens: 10 }, ctrl.signal),
      lim.acquire({ inputTokens: 10, outputTokens: 10 }, ctrl.signal),
    ]);
    held.push(1, 2);
    expect(held).toEqual([1, 2]);
    const third = lim.acquire({ inputTokens: 10, outputTokens: 10 }, ctrl.signal).then((t) => {
      held.push(3);
      t.release();
    });
    tickets[0]!.release();
    await third;
    expect(held).toEqual([1, 2, 3]);
    tickets[1]!.release();
  });

  it('rejects when the signal aborts while queued', async () => {
    const lim = new Limiter({ concurrency: 1, rpm: 10_000, inputTpm: 10_000_000, outputTpm: 10_000_000 });
    const ctrl = new AbortController();
    const held = await lim.acquire({ inputTokens: 10, outputTokens: 10 }, new AbortController().signal);
    const queued = lim.acquire({ inputTokens: 10, outputTokens: 10 }, ctrl.signal);
    ctrl.abort();
    await expect(queued).rejects.toBeInstanceOf(DOMException);
    held.release();
  });
});
