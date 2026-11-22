import { describe, expect, it } from 'vitest';
import { back, blurAt, canBack, DURATIONS, easeInCubic, initialState, MAX_BLUR, progress, start, tick } from './view-transition';

describe('view transition: going down', () => {
  it('walks diving -> swap -> clearing -> idle, flipping the view at the start of swap', () => {
    let s = start(initialState(), 'verdan', 1000);
    expect(s).toMatchObject({ phase: 'diving', view: { kind: 'map' } });

    s = tick(s, 1000 + DURATIONS.diving - 1);
    expect(s).toMatchObject({ phase: 'diving', view: { kind: 'map' } });

    s = tick(s, 1000 + DURATIONS.diving);
    expect(s).toMatchObject({ phase: 'swap', view: { kind: 'ground', planet: 'verdan' } });

    s = tick(s, 1000 + DURATIONS.diving + DURATIONS.swap);
    expect(s.phase).toBe('clearing');

    s = tick(s, 1000 + DURATIONS.diving + DURATIONS.swap + DURATIONS.clearing);
    expect(s).toMatchObject({ phase: 'idle', view: { kind: 'ground', planet: 'verdan' }, next: null });
    expect(canBack(s)).toBe(true);
  });

  it('blur is 0 at the start, full at the end of the dive and through the swap, then back to 0', () => {
    const s0 = start(initialState(), 'helion', 0);
    expect(blurAt(s0, 0)).toBe(0);
    expect(blurAt(s0, DURATIONS.diving / 2)).toBeCloseTo(MAX_BLUR / 2, 5);
    expect(blurAt(s0, DURATIONS.diving)).toBeCloseTo(MAX_BLUR, 5);

    const swap = tick(s0, DURATIONS.diving + 10);
    expect(blurAt(swap, DURATIONS.diving + 10)).toBe(MAX_BLUR);

    const t = DURATIONS.diving + DURATIONS.swap;
    const clearing = tick(s0, t);
    expect(blurAt(clearing, t)).toBeCloseTo(MAX_BLUR, 5);
    expect(blurAt(clearing, t + DURATIONS.clearing / 2)).toBeCloseTo(MAX_BLUR / 2, 5);
    expect(blurAt(clearing, t + DURATIONS.clearing)).toBeCloseTo(0, 5);
    expect(blurAt(tick(s0, t + DURATIONS.clearing), t + DURATIONS.clearing)).toBe(0);
  });

  it('blur is eased, not linear, and never leaves 0..12', () => {
    const s = start(initialState(), 'verdan', 0);
    const quarter = blurAt(s, DURATIONS.diving / 4);
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThan(MAX_BLUR / 4); // slower than linear at the start
    expect(blurAt(s, -500)).toBe(0);
    expect(blurAt(s, 99999)).toBe(MAX_BLUR);
  });

  it('reports progress through the current phase', () => {
    const s = start(initialState(), 'verdan', 100);
    expect(progress(s, 100)).toBe(0);
    expect(progress(s, 100 + DURATIONS.diving / 2)).toBeCloseTo(0.5, 5);
    expect(progress(initialState(), 5)).toBe(1);
  });
});

describe('view transition: coming back', () => {
  function onGround() {
    return tick(start(initialState(), 'tethys', 0), 10_000);
  }

  it('walks leaving -> swap -> clearing -> idle, flipping to the map at the start of swap', () => {
    let s = back(onGround(), 20_000);
    expect(s).toMatchObject({ phase: 'leaving', view: { kind: 'ground', planet: 'tethys' } });
    expect(blurAt(s, 20_000)).toBe(0);
    expect(blurAt(s, 20_000 + DURATIONS.leaving / 2)).toBeCloseTo(MAX_BLUR / 2, 5);

    s = tick(s, 20_000 + DURATIONS.leaving);
    expect(s).toMatchObject({ phase: 'swap', view: { kind: 'map' } });

    s = tick(s, 20_000 + DURATIONS.leaving + DURATIONS.swap);
    expect(s.phase).toBe('clearing');

    s = tick(s, 20_000 + DURATIONS.leaving + DURATIONS.swap + DURATIONS.clearing);
    expect(s).toMatchObject({ phase: 'idle', view: { kind: 'map' }, next: null });
    expect(canBack(s)).toBe(false);
  });

  it('a long stall walks through every skipped phase', () => {
    const s = tick(back(onGround(), 0), 1_000_000);
    expect(s).toMatchObject({ phase: 'idle', view: { kind: 'map' } });
  });
});

describe('view transition: ignoring input', () => {
  it('ignores a second click while diving, and any click while on the ground', () => {
    const diving = start(initialState(), 'verdan', 0);
    expect(start(diving, 'helion', 100)).toBe(diving);
    const ground = tick(diving, 10_000);
    expect(start(ground, 'helion', 10_001)).toBe(ground);
  });

  it('ignores back on the map, and Esc or back mid-dive', () => {
    const map = initialState();
    expect(back(map, 0)).toBe(map);
    const diving = start(map, 'verdan', 0);
    expect(back(diving, 100)).toBe(diving);
    const swap = tick(diving, DURATIONS.diving + 1);
    expect(back(swap, DURATIONS.diving + 2)).toBe(swap);
  });

  it('ignores clicks and repeat back requests while leaving or clearing', () => {
    const ground = tick(start(initialState(), 'verdan', 0), 10_000);
    const leaving = back(ground, 20_000);
    expect(back(leaving, 20_100)).toBe(leaving);
    expect(start(leaving, 'helion', 20_100)).toBe(leaving);
    const clearing = tick(leaving, 20_000 + DURATIONS.leaving + DURATIONS.swap);
    expect(clearing.phase).toBe('clearing');
    expect(start(clearing, 'helion', 30_000)).toBe(clearing);
    expect(back(clearing, 30_000)).toBe(clearing);
  });

  it('tick on an idle state changes nothing', () => {
    const s = initialState();
    expect(tick(s, 5000)).toBe(s);
  });
});

describe('easeInCubic', () => {
  it('runs 0 to 1, slow at first', () => {
    expect(easeInCubic(0)).toBe(0);
    expect(easeInCubic(1)).toBe(1);
    expect(easeInCubic(0.5)).toBeCloseTo(0.125, 5);
    expect(easeInCubic(-1)).toBe(0);
    expect(easeInCubic(2)).toBe(1);
  });
});
