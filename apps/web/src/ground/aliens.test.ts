import { describe, expect, it } from 'vitest';
import { alienCount, alienPose, makeAliens, MAX_ALIENS, MIN_ALIENS } from './aliens';
import { layoutCity } from './city-layout';

describe('alienCount', () => {
  it('grows with population, with fixed limits', () => {
    expect(alienCount(1_000)).toBeLessThan(alienCount(1_000_000));
    expect(alienCount(1_000_000)).toBeLessThan(alienCount(1_000_000_000));
    expect(alienCount(0)).toBe(MIN_ALIENS);
    expect(alienCount(1e30)).toBe(MAX_ALIENS);
    expect(alienCount(undefined)).toBeGreaterThanOrEqual(MIN_ALIENS);
  });
});

describe('aliens', () => {
  const layout = layoutCity({ planet: 'helion' });
  const specs = makeAliens(layout.loops, 60, 'helion');

  it('makes the requested number, deterministically', () => {
    expect(specs).toHaveLength(60);
    expect(makeAliens(layout.loops, 60, 'helion')).toEqual(specs);
    expect(makeAliens(layout.loops, 60, 'verdan')).not.toEqual(specs);
  });

  it('puts walkers on both plaza and road loops', () => {
    expect(specs.some((s) => s.loop < 2)).toBe(true);
    expect(specs.some((s) => s.loop >= 2)).toBe(true);
  });

  it('keeps walkers on the sidewalk or plaza at street level, never in a building', () => {
    for (const t of [0, 7.3, 31, 120, 999]) {
      for (const s of specs) {
        const p = alienPose(layout.loops, s, t);
        expect(layout.onStreet(p.x, p.z, 0.5)).toBe(true);
        for (const b of layout.buildings) expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeGreaterThan(Math.min(b.w, b.d) / 2);
        expect(p.bob).toBeGreaterThanOrEqual(0);
        expect(p.bob).toBeLessThan(0.1);
      }
    }
  });

  it('moves over time and faces the way it walks', () => {
    const s = specs[0]!;
    const a = alienPose(layout.loops, s, 0);
    const b = alienPose(layout.loops, s, 0.5);
    const moved = Math.hypot(b.x - a.x, b.z - a.z);
    expect(moved).toBeGreaterThan(0.2);
    expect(moved).toBeLessThan(1.2);
    expect(Math.sin(a.heading) * (b.x - a.x) + Math.cos(a.heading) * (b.z - a.z)).toBeGreaterThan(0);
  });
});
