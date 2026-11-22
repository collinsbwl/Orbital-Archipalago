import { describe, expect, it } from 'vitest';
import { GROWTH_FULL, layoutCity, populationTier } from './city-layout';
import { APPEAR_SECONDS, delayFor, isSettled, MAX_DELAY, shownHeight, stepGrowth } from './growth';
import type { GrowthState } from './growth';

const POPS = [1, 3, 10, 30, 100, 300, 1_000, 10_000, 1_000_000, 1e9];

describe('city growth is monotone in population', () => {
  for (const planet of ['verdan', 'helion', 'tethys', 'zorp', 'quux']) {
    const layouts = POPS.map((p) => layoutCity({ planet, population: p }));

    it(`${planet}: more people never remove a building or a ring street`, () => {
      for (let i = 1; i < layouts.length; i++) {
        const before = new Set(layouts[i - 1]!.buildings.map((b) => b.id));
        const after = new Set(layouts[i]!.buildings.map((b) => b.id));
        for (const id of before) expect(after.has(id)).toBe(true);
        const streets = new Set(layouts[i]!.ringStreets.map((s) => s.index));
        for (const s of layouts[i - 1]!.ringStreets) expect(streets.has(s.index)).toBe(true);
        expect(layouts[i]!.buildings.length).toBeGreaterThanOrEqual(layouts[i - 1]!.buildings.length);
      }
    });

    it(`${planet}: a building keeps its spot, size, kind and colour; its height never falls`, () => {
      for (let i = 1; i < layouts.length; i++) {
        const small = new Map(layouts[i - 1]!.buildings.map((b) => [b.id, b]));
        for (const b of layouts[i]!.buildings) {
          const a = small.get(b.id);
          if (!a) continue;
          expect([b.x, b.z, b.w, b.d, b.rotY, b.kind, b.paletteIndex, b.tierMin, b.ring]).toEqual([a.x, a.z, a.w, a.d, a.rotY, a.kind, a.paletteIndex, a.tierMin, a.ring]);
          expect(b.h).toBeGreaterThanOrEqual(a.h);
        }
      }
    });

    it(`${planet}: total height rises and the city fills the same capacity`, () => {
      const sums = layouts.map((l) => l.buildings.reduce((s, b) => s + b.h, 0));
      for (let i = 1; i < sums.length; i++) expect(sums[i]!).toBeGreaterThanOrEqual(sums[i - 1]!);
      expect(sums[sums.length - 1]!).toBeGreaterThan(sums[1]! + 1);
      for (const l of layouts) expect(l.capacity).toBe(layouts[0]!.capacity);
      expect(layouts[layouts.length - 1]!.buildings.length).toBe(layouts[0]!.capacity);
    });

    it(`${planet}: reaches a full city by a few hundred people, and is small before that`, () => {
      expect(populationTier(1000)).toBeGreaterThanOrEqual(GROWTH_FULL);
      const full = layouts[layouts.length - 1]!;
      expect(layoutCity({ planet, population: 1000 }).buildings.length).toBe(full.buildings.length);
      expect(layouts[1]!.buildings.length).toBeLessThan(full.buildings.length / 2);
    });
  }

  it('the same tier always gives the same city, however the population got there', () => {
    const same = layoutCity({ planet: 'verdan', population: 100_000 });
    const again = layoutCity({ planet: 'verdan', population: 100_000 });
    expect([again.buildings, again.ringStreets, again.roads]).toEqual([same.buildings, same.ringStreets, same.roads]);
    const a = layoutCity({ planet: 'verdan', population: 1_000_000 });
    const b = layoutCity({ planet: 'verdan', population: 1_050_000 });
    expect(b.buildings).toEqual(a.buildings);
  });

  it('adds ring streets as the city spreads, and they stay clear of every building', () => {
    const full = layoutCity({ planet: 'verdan', population: 1_000_000 });
    expect(full.ringStreets.length).toBeGreaterThanOrEqual(2);
    expect(layoutCity({ planet: 'verdan', population: 1 }).ringStreets).toHaveLength(0);
    for (const st of full.ringStreets) {
      const half = st.width / 2 + st.sidewalk;
      for (const b of full.buildings) {
        // Buildings face the plaza, so depth `d` is their extent along the radius.
        expect(Math.abs(Math.hypot(b.x, b.z) - st.radius) - b.d / 2).toBeGreaterThanOrEqual(half - 1e-9);
      }
    }
  });

  it('has residential, commercial and industrial districts, industrial only at the edge', () => {
    const l = layoutCity({ planet: 'helion', population: 1_000_000 });
    const kinds = new Set(l.buildings.map((b) => b.kind));
    expect(kinds.has('commercial')).toBe(true);
    expect(kinds.has('residential')).toBe(true);
    for (const b of l.buildings.filter((q) => q.kind === 'industrial')) expect(b.ring).toBe(Math.max(...l.buildings.map((q) => q.ring)));
    const any = ['verdan', 'helion', 'tethys', 'zorp', 'quux'].some((p) => layoutCity({ planet: p, population: 1e6 }).buildings.some((b) => b.kind === 'industrial'));
    expect(any).toBe(true);
  });

  it('puts ring streets on the street query', () => {
    const l = layoutCity({ planet: 'verdan', population: 1_000_000 });
    const st = l.ringStreets[0]!;
    // A point on the ring street, away from any radial road.
    let spot: [number, number] | null = null;
    for (let a = 0; a < 6.28 && !spot; a += 0.05) {
      const x = st.radius * Math.sin(a), z = st.radius * Math.cos(a);
      if (l.distanceToRoad(x, z) > 12) spot = [x, z];
    }
    expect(spot).not.toBeNull();
    expect(l.onStreet(spot![0], spot![1])).toBe(true);
    // The same spot is bare ground in a hamlet that has not built the street yet.
    expect(layoutCity({ planet: 'verdan', population: 1 }).onStreet(spot![0], spot![1])).toBe(false);
  });
});

describe('stepGrowth (animation)', () => {
  const small = layoutCity({ planet: 'verdan', population: 30 }).buildings;
  const big = layoutCity({ planet: 'verdan', population: 1_000_000 }).buildings;

  it('shows the first layout instantly', () => {
    const state: GrowthState = new Map();
    expect(stepGrowth(state, small, 0.016, true)).toBe(false);
    expect(isSettled(state, small)).toBe(true);
  });

  it('raises new buildings after a stagger and settles on the layout', () => {
    const state: GrowthState = new Map();
    stepGrowth(state, small, 0.016, true);
    expect(stepGrowth(state, big, 0.016)).toBe(true);
    const fresh = big.find((b) => !small.some((s) => s.id === b.id))!;
    expect(shownHeight(state.get(fresh.id)!)).toBe(0);
    for (let t = 0; t < 12; t += 0.05) stepGrowth(state, big, 0.05);
    expect(isSettled(state, big)).toBe(true);
    for (const b of big) expect(shownHeight(state.get(b.id)!)).toBeCloseTo(b.h, 6);
  });

  it('never shrinks or hides anything while the population grows', () => {
    const state: GrowthState = new Map();
    stepGrowth(state, small, 0.016, true);
    const last = new Map<string, number>();
    const mid = layoutCity({ planet: 'verdan', population: 300 }).buildings;
    for (let step = 0; step < 400; step++) {
      const target = step < 150 ? small : step < 250 ? mid : big;
      stepGrowth(state, target, 0.04);
      for (const [id, s] of state) {
        const h = shownHeight(s);
        expect(h).toBeGreaterThanOrEqual((last.get(id) ?? 0) - 1e-9);
        last.set(id, h);
      }
      for (const b of target) expect(state.has(b.id)).toBe(true);
    }
  });

  it('staggers deterministically within the limit, and rises in about APPEAR_SECONDS', () => {
    expect(delayFor('2:5')).toBe(delayFor('2:5'));
    for (const b of big) expect(delayFor(b.id)).toBeLessThanOrEqual(MAX_DELAY);
    const state: GrowthState = new Map();
    stepGrowth(state, small, 0.016, true);
    stepGrowth(state, big, 0.001);
    for (let t = 0; t < MAX_DELAY + APPEAR_SECONDS + 0.2; t += 0.05) stepGrowth(state, big, 0.05);
    expect([...state.values()].every((s) => s.appear === 1)).toBe(true);
  });
});
