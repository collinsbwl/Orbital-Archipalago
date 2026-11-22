import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, layoutCity } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { ARM_WIDTH, layoutPylons, MIN_PYLON_OFFSET, pickRoad, PYLON_HEIGHT, PYLON_SPACING, pylonPieces, SAG, WIRE_STEPS, wireAnchors, wireCurve, wireSegments } from './power-line';
import { makeTerrain } from './terrain';

const PLANETS = ['helion', 'verdan', 'tethys', 'zz', 'qq', 'novara'];
const flat = { heightAt: () => 0 };

describe('layoutPylons', () => {
  it('runs along the road, evenly spaced, clear of every building the full city will have', () => {
    for (const p of PLANETS) {
      const layout = layoutCity({ planet: p });
      const road = pickRoad(layout, null, [0]);
      const pylons = layoutPylons(layout, road, flat);
      expect(pylons.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < pylons.length; i++) expect(Math.hypot(pylons[i]!.x - pylons[i - 1]!.x, pylons[i]!.z - pylons[i - 1]!.z)).toBeCloseTo(PYLON_SPACING);
      for (const py of pylons) {
        expect(layout.distanceToRoad(py.x, py.z)).toBeGreaterThan(MIN_PYLON_OFFSET - 0.1);
        for (const b of layout.buildings) expect(Math.hypot(b.x - py.x, b.z - py.z)).toBeGreaterThan(Math.hypot(b.w, b.d) / 2 + 1);
      }
    }
  });

  it('stands each pylon on the ground', () => {
    const planet = 'helion';
    const terrain = makeTerrain({ planet, goods: goodsOf(planet), flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });
    const layout = layoutCity({ planet });
    for (const py of layoutPylons(layout, 2, terrain)) expect(py.y).toBe(terrain.heightAt(py.x, py.z));
  });
});

describe('pickRoad', () => {
  const layout = layoutCity({ planet: 'verdan' });
  it('skips the given roads and picks the one ending nearest a point', () => {
    expect(pickRoad(layout, null, [0, 1])).toBe(2);
    const r = layout.roads[3]!;
    expect(pickRoad(layout, [r.end[0] * 1.5, r.end[1] * 1.5], [0])).toBe(3);
    expect(pickRoad(layout, [r.end[0] * 1.5, r.end[1] * 1.5], [3])).not.toBe(3);
  });
});

describe('pylons and wires', () => {
  const layout = layoutCity({ planet: 'verdan' });
  const pylons = layoutPylons(layout, 2, flat);

  it('puts the crossarm across the line, so its tips are straddling the pole', () => {
    const [a, b] = wireAnchors(pylons[0]!);
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeCloseTo(ARM_WIDTH);
    expect((a[0] + b[0]) / 2).toBeCloseTo(pylons[0]!.x);
    // The tips line up along the road's sideways direction, not along the road.
    const side = layout.roads[2]!.side;
    const along = ((a[0] - b[0]) * layout.roads[2]!.dir[0] + (a[2] - b[2]) * layout.roads[2]!.dir[1]) / ARM_WIDTH;
    const across = ((a[0] - b[0]) * side[0] + (a[2] - b[2]) * side[1]) / ARM_WIDTH;
    expect(Math.abs(along)).toBeLessThan(0.01);
    expect(Math.abs(across)).toBeCloseTo(1);
  });

  it('sags most at mid-span and is anchored at both ends', () => {
    const a: [number, number, number] = [0, 10, 0];
    const b: [number, number, number] = [20, 10, 0];
    const curve = wireCurve(a, b);
    expect(curve).toHaveLength(WIRE_STEPS + 1);
    expect(curve[0]).toEqual(a);
    expect(curve[curve.length - 1]![1]).toBeCloseTo(10);
    const lowest = Math.min(...curve.map((p) => p[1]));
    expect(lowest).toBeCloseTo(10 - SAG);
    expect(curve[WIRE_STEPS / 2]![1]).toBeCloseTo(lowest);
  });

  it('makes two wires per span as line segments, all finite, none below the ground', () => {
    const seg = wireSegments(pylons);
    expect(seg.length).toBe((pylons.length - 1) * 2 * WIRE_STEPS * 2 * 3);
    for (let i = 0; i < seg.length; i += 3) {
      expect(Number.isFinite(seg[i]! + seg[i + 1]! + seg[i + 2]!)).toBe(true);
      expect(seg[i + 1]!).toBeGreaterThan(PYLON_HEIGHT * 0.6);
    }
    expect(wireSegments([])).toHaveLength(0);
    expect(wireSegments(pylons.slice(0, 1))).toHaveLength(0);
  });

  it('draws three pieces per pylon', () => {
    expect(pylonPieces(pylons)).toHaveLength(pylons.length * 3);
  });
});
