import { describe, expect, it } from 'vitest';
import { layoutCity, PLAZA_RADIUS } from './city-layout';
import { layoutStalls, marketPieces, openCount } from './market';

describe('layoutStalls', () => {
  const stalls = (p: string) => layoutStalls(p, layoutCity({ planet: p }).roads);
  it('is deterministic and puts stalls on the plaza edge, away from road mouths', () => {
    for (const p of ['helion', 'verdan', 'zz']) {
      const layout = layoutCity({ planet: p });
      const s = stalls(p);
      expect(s).toEqual(stalls(p));
      expect(s.length).toBeGreaterThanOrEqual(4);
      for (const st of s) {
        expect(Math.hypot(st.x, st.z)).toBeLessThan(PLAZA_RADIUS);
        expect(Math.hypot(st.x, st.z)).toBeGreaterThan(PLAZA_RADIUS - 2);
        for (const r of layout.roads) expect(Math.hypot(st.x - r.dir[0] * PLAZA_RADIUS, st.z - r.dir[1] * PLAZA_RADIUS)).toBeGreaterThan(1.5);
      }
    }
  });
  it('ranks every stall once, 0 to n - 1', () => {
    const s = stalls('verdan');
    expect([...s.map((x) => x.openRank)].sort((a, b) => a - b)).toEqual(s.map((_, i) => i));
  });
});

describe('openCount', () => {
  it('rises with the share, from none to all', () => {
    expect(openCount(8, 0)).toBe(0);
    expect(openCount(8, 1)).toBe(8);
    expect(openCount(8, 0.5)).toBe(4);
    expect(openCount(8, 0.01)).toBe(1);
    let prev = 0;
    for (let s = 0; s <= 1; s += 0.05) {
      const n = openCount(8, s);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe('marketPieces', () => {
  it('draws wares only on open stalls, and the same stalls open as more open', () => {
    const s = layoutStalls('verdan', layoutCity({ planet: 'verdan' }).roads);
    const closed = marketPieces(s, 0);
    const some = marketPieces(s, 2);
    const all = marketPieces(s, s.length);
    expect(closed.some((p) => p.color === '#454851')).toBe(true);
    expect(all.some((p) => p.color === '#454851')).toBe(false);
    expect(some.filter((p) => p.color === '#454851').length).toBe(s.length - 2);
  });
});
