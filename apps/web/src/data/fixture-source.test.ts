import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../test-fixtures';
import { FixtureSource } from './fixture-source';

describe('FixtureSource', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays snapshots in order, loops, and pauses/resumes', async () => {
    const snaps = [makeSnapshot(1), makeSnapshot(2), makeSnapshot(3)];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(snaps))) as unknown as typeof fetch;
    const src = new FixtureSource({ intervalMs: 500, fetchImpl });
    src.start();
    await vi.advanceTimersByTimeAsync(0);
    const cycles: (number | undefined)[] = [src.getState().snapshot?.cycle];
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(500);
      cycles.push(src.getState().snapshot?.cycle);
    }
    expect(cycles).toEqual([1, 2, 3, 1, 2]);
    expect(src.getState()).toMatchObject({ role: 'spectator', connected: true });

    src.setPlaybackPaused(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(src.getState().snapshot?.cycle).toBe(2);
    src.setPlaybackPaused(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(src.getState().snapshot?.cycle).toBe(3);
    src.stop();
  });

  it('plays faster at a higher speed, keeps the speed across pauses, and ignores bad speeds', async () => {
    const snaps = [makeSnapshot(1), makeSnapshot(2), makeSnapshot(3), makeSnapshot(4), makeSnapshot(5)];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(snaps))) as unknown as typeof fetch;
    const src = new FixtureSource({ intervalMs: 400, fetchImpl });
    src.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(src.getState().playbackSpeed).toBe(1);

    src.setPlaybackSpeed(4); // one snapshot every 100 ms
    expect(src.getState().playbackSpeed).toBe(4);
    await vi.advanceTimersByTimeAsync(300);
    expect(src.getState().snapshot?.cycle).toBe(4);

    src.setPlaybackSpeed(0);
    src.setPlaybackSpeed(Number.NaN);
    src.setPlaybackSpeed(-2);
    expect(src.getState().playbackSpeed).toBe(4);

    src.setPlaybackPaused(true);
    src.setPlaybackSpeed(2); // changing speed while paused must not start playback
    await vi.advanceTimersByTimeAsync(2000);
    expect(src.getState().snapshot?.cycle).toBe(4);
    src.setPlaybackPaused(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(src.getState().snapshot?.cycle).toBe(5);
    src.stop();
  });

  it('refuses commands', async () => {
    expect((await new FixtureSource().sendCommand()).ok).toBe(false);
  });
});
