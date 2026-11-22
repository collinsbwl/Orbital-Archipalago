import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../test-fixtures';
import { lookFor } from './planet-look';
import { CITY_RADIUS, cityCounts, cityLayout, makeWalkers, ROAD_HALF_LENGTH, ROAD_HALF_WIDTH, stepWalker, walkerPose } from './city';
import type { Walker } from './city';

describe('city layout', () => {
  it('is the same every time for the same seed, and differs between seeds', () => {
    expect(cityLayout(42)).toEqual(cityLayout(42));
    expect(cityLayout(42).houses[0]).not.toEqual(cityLayout(43).houses[0]);
  });

  it('fits a good number of houses on the plateau, clear of roads, the plaza and each other', () => {
    const { houses, plaza } = cityLayout(1234);
    expect(houses.length).toBeGreaterThanOrEqual(16);
    for (const h of houses) {
      expect(Math.hypot(h.x, h.z)).toBeLessThan(CITY_RADIUS);
      expect(Math.abs(h.x)).toBeGreaterThan(ROAD_HALF_WIDTH + h.w / 2 - 1e-9); // beside the roads, not on them
      expect(Math.abs(h.z)).toBeGreaterThan(ROAD_HALF_WIDTH + h.w / 2 - 1e-9);
      expect(Math.hypot(h.x - plaza.x, h.z - plaza.z)).toBeGreaterThan(plaza.r);
    }
    for (let i = 0; i < houses.length; i++) for (let j = i + 1; j < houses.length; j++) {
      expect(Math.hypot(houses[i]!.x - houses[j]!.x, houses[i]!.z - houses[j]!.z)).toBeGreaterThan(0.039);
    }
  });
});

describe('Verdan city', () => {
  it('has room for as many houses as its population asks for', () => {
    const verdan = makeSnapshot(1).planets[1]!;
    const wanted = cityCounts(verdan).houses;
    expect(cityLayout(lookFor('verdan').seed).houses.length).toBeGreaterThanOrEqual(wanted);
  });
});

describe('city counts', () => {
  const planet = makeSnapshot(1).planets[1]!;

  it('scale with population and are kept within sensible limits', () => {
    expect(cityCounts(planet)).toMatchObject({ houses: 14, aliens: 15 }); // population 30
    const small = { ...planet, metrics: { ...planet.metrics, population: 2 } };
    expect(cityCounts(small)).toMatchObject({ houses: 5, aliens: 6 });
    const huge = { ...planet, metrics: { ...planet.metrics, population: 10_000 } };
    expect(cityCounts(huge)).toMatchObject({ houses: 24, aliens: 24 });
  });

  it('walk faster when consumers are confident', () => {
    const at = (c: number) => cityCounts({ ...planet, metrics: { ...planet.metrics, consumerConfidence: c } }).walkSpeed;
    expect(at(0)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(100));
    expect(at(500)).toBe(at(100)); // out-of-range values are clamped
  });
});

describe('alien walkers', () => {
  const never = () => 0.99; // never takes the other road
  const always = () => 0; // always takes the other road

  it('start spread over the roads, the same way every time', () => {
    const a = makeWalkers(10, 7);
    expect(a).toHaveLength(10);
    expect(makeWalkers(10, 7)).toEqual(a);
    for (const w of a) expect(Math.abs(w.t)).toBeLessThanOrEqual(ROAD_HALF_LENGTH);
    expect(new Set(a.map((w) => w.axis)).size).toBe(2);
  });

  it('move along the road at their speed', () => {
    const w: Walker = { axis: 'x', t: 0.05, dir: 1, lane: 0, phase: 0 };
    stepWalker(w, 2, 0.01, never);
    expect(w.t).toBeCloseTo(0.07, 9);
  });

  it('turn round at the end of a road and never leave it', () => {
    const w: Walker = { axis: 'z', t: ROAD_HALF_LENGTH - 0.001, dir: 1, lane: 0, phase: 0 };
    stepWalker(w, 1, 0.05, never);
    expect(w.t).toBe(ROAD_HALF_LENGTH);
    expect(w.dir).toBe(-1);
    for (let i = 0; i < 2000; i++) stepWalker(w, 0.1, 0.05, Math.random);
    expect(Math.abs(w.t)).toBeLessThanOrEqual(ROAD_HALF_LENGTH);
  });

  it('may take the other road at the crossing', () => {
    const turn: Walker = { axis: 'x', t: -0.002, dir: 1, lane: 0.003, phase: 0 };
    stepWalker(turn, 1, 0.01, always);
    expect(turn.axis).toBe('z');
    expect(turn.dir).toBe(1);
    const straight: Walker = { axis: 'x', t: -0.002, dir: 1, lane: 0.003, phase: 0 };
    stepWalker(straight, 1, 0.01, never);
    expect(straight.axis).toBe('x');
    expect(straight.t).toBeCloseTo(0.008, 9);
  });

  it('face the way they walk', () => {
    expect(walkerPose({ axis: 'x', t: 0.1, dir: 1, lane: 0.004, phase: 0 })).toEqual({ x: 0.1, z: 0.004, heading: Math.PI / 2 });
    expect(walkerPose({ axis: 'z', t: -0.1, dir: -1, lane: -0.004, phase: 0 })).toEqual({ x: -0.004, z: -0.1, heading: Math.PI });
    expect(walkerPose({ axis: 'z', t: 0.1, dir: 1, lane: 0, phase: 0 }).heading).toBe(0);
  });
});
