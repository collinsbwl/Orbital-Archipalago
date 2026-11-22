import { describe, expect, it } from 'vitest';
import { CITY_RADIUS, layoutCity, makeLoop, PLAZA_RADIUS, populationTier, ROAD_LENGTH, ROAD_WIDTH, sampleLoop } from './city-layout';

describe('layoutCity', () => {
  const layout = layoutCity({ planet: 'verdan', population: 500_000 });

  it('has 4 to 6 unit-direction roads out from the plaza', () => {
    for (const planet of ['verdan', 'helion', 'tethys', 'x1', 'x2', 'x3', 'x4']) {
      const n = layoutCity({ planet }).roads.length;
      expect(n).toBeGreaterThanOrEqual(4);
      expect(n).toBeLessThanOrEqual(6);
    }
    for (const r of layout.roads) {
      expect(Math.hypot(...r.dir)).toBeCloseTo(1);
      expect(Math.hypot(r.end[0], r.end[1])).toBeCloseTo(ROAD_LENGTH);
    }
  });

  it('is deterministic', () => {
    const again = layoutCity({ planet: 'verdan', population: 500_000 });
    expect(again.buildings).toEqual(layout.buildings);
    expect(again.roads).toEqual(layout.roads);
    expect(again.loops).toEqual(layout.loops);
  });

  it('has plenty of buildings, all inside the city, off the plaza and clear of the roads', () => {
    expect(layout.buildings.length).toBeGreaterThan(40);
    for (const b of layout.buildings) {
      const r = Math.hypot(b.x, b.z);
      expect(r).toBeLessThanOrEqual(CITY_RADIUS + 0.01);
      expect(r).toBeGreaterThan(PLAZA_RADIUS + 5);
      expect(layout.distanceToRoad(b.x, b.z)).toBeGreaterThan(ROAD_WIDTH / 2 + Math.hypot(b.w, b.d) / 2);
    }
  });

  it('gives buildings unique ids', () => {
    expect(new Set(layout.buildings.map((b) => b.id)).size).toBe(layout.buildings.length);
  });

  it('makes buildings taller with more population but keeps the same footprints', () => {
    const small = layoutCity({ planet: 'verdan', population: 1_000 });
    const big = layoutCity({ planet: 'verdan', population: 10_000_000 });
    expect(big.buildings.map((b) => [b.id, b.x, b.z])).toEqual(small.buildings.map((b) => [b.id, b.x, b.z]));
    const sum = (l: typeof small) => l.buildings.reduce((s, b) => s + b.h, 0);
    expect(sum(big)).toBeGreaterThan(sum(small));
  });

  it('answers street queries', () => {
    const r = layout.roads[0]!;
    expect(layout.onStreet(0, 0)).toBe(true);
    expect(layout.onStreet(r.dir[0] * 40, r.dir[1] * 40)).toBe(true);
    expect(layout.roadClearance(r.dir[0] * 40, r.dir[1] * 40)).toBeLessThan(0);
    const b = layout.buildings[0]!;
    expect(layout.onStreet(b.x, b.z)).toBe(false);
  });

  it('walks: a plaza loop, an inner loop, and one loop per road, all closed', () => {
    expect(layout.loops).toHaveLength(2 + layout.roads.length);
    for (const l of layout.loops) {
      expect(l.length).toBeGreaterThan(10);
      expect(l.cumulative[l.cumulative.length - 1]).toBeCloseTo(l.length);
    }
  });

  it('keeps road loops on the sidewalk, not in the road or in buildings', () => {
    for (const loop of layout.loops.slice(2)) {
      for (const [x, z] of loop.points) {
        expect(layout.roadClearance(x, z)).toBeLessThan(0.01);
        expect(layout.distanceToRoad(x, z)).toBeGreaterThan(ROAD_WIDTH / 2 - 0.01);
      }
    }
  });
});

describe('populationTier', () => {
  it('rises with population and ignores small changes', () => {
    expect(populationTier(1_000_000)).toBeGreaterThan(populationTier(10_000));
    expect(populationTier(1_000_000)).toBe(populationTier(1_050_000));
    expect(populationTier(0)).toBe(populationTier(1));
  });
});

describe('loops', () => {
  const loop = makeLoop([[0, 0], [10, 0], [10, 10], [0, 10]]);
  it('measures and wraps', () => {
    expect(loop.length).toBe(40);
    expect(sampleLoop(loop, 5)).toMatchObject({ x: 5, z: 0, dx: 1, dz: 0 });
    expect(sampleLoop(loop, 15)).toMatchObject({ x: 10, z: 5, dx: 0, dz: 1 });
    expect(sampleLoop(loop, 45).x).toBeCloseTo(5);
    expect(sampleLoop(loop, -5).z).toBeCloseTo(5);
  });
});
