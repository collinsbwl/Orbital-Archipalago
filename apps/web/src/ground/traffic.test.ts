import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, layoutCity, makeLoop, ROAD_WIDTH } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { haulPath, layoutPort } from './port';
import { makeTerrain } from './terrain';
import { haulerCount, lanePolygon, LANE_OFFSET, makeVehicles, roadLoops, vehicleCount, vehiclePose } from './traffic';

describe('lanePolygon', () => {
  it('goes out one lane and back the other, keeping right', () => {
    // Heading +x, the right-hand side is -z; coming back it is +z.
    const poly = lanePolygon([[0, 0], [10, 0]], 1);
    expect(poly).toHaveLength(4);
    expect(poly[0]![1]).toBeCloseTo(-1);
    expect(poly[1]![1]).toBeCloseTo(-1);
    expect(poly[2]![1]).toBeCloseTo(1);
    expect(poly[1]![0]).toBeCloseTo(10);
    expect(poly[2]![0]).toBeCloseTo(10);
  });
  it('rounds a corner without blowing up the offset', () => {
    const poly = lanePolygon([[0, 0], [10, 0], [10, 10]], 1);
    for (const p of poly) expect(Number.isFinite(p[0] + p[1])).toBe(true);
    expect(Math.hypot(poly[1]![0] - 10, poly[1]![1])).toBeCloseTo(1);
  });
});

describe('road loops and vehicles', () => {
  const layout = layoutCity({ planet: 'verdan' });
  const loops = roadLoops(layout);
  it('makes one loop per road, running in the road lanes', () => {
    expect(loops).toHaveLength(layout.roads.length);
    for (const loop of loops) {
      for (const [x, z] of loop.points) expect(layout.distanceToRoad(x, z)).toBeLessThanOrEqual(LANE_OFFSET + 0.1);
    }
  });
  it('is deterministic, and a smaller fleet is a prefix of a bigger one', () => {
    const big = makeVehicles(loops, 18, 'verdan', 'car');
    expect(makeVehicles(loops, 18, 'verdan', 'car')).toEqual(big);
    expect(makeVehicles(loops, 6, 'verdan', 'car')).toEqual(big.slice(0, 6));
  });
  it('keeps vehicles on the road, facing the way they go', () => {
    const [v] = makeVehicles(loops, 1, 'verdan', 'car');
    const a = vehiclePose(loops, v!, 0);
    const b = vehiclePose(loops, v!, 0.01);
    const heading = Math.atan2(b.x - a.x, b.z - a.z);
    expect(Math.abs(Math.atan2(Math.sin(heading - a.heading), Math.cos(heading - a.heading)))).toBeLessThan(0.3);
    for (const t of [0, 10, 100, 1000]) {
      const p = vehiclePose(loops, v!, t);
      expect(layout.distanceToRoad(p.x, p.z)).toBeLessThan(ROAD_WIDTH / 2);
    }
  });
});

describe('counts', () => {
  it('scale with traffic from none to all', () => {
    expect(vehicleCount(18, 0)).toBe(0);
    expect(vehicleCount(18, 1)).toBe(18);
    expect(vehicleCount(18, 0.5)).toBe(9);
    expect(vehicleCount(18, 7)).toBe(18);
  });
  it('keeps at least one hauler while there is traffic, and grows with ships at the port', () => {
    expect(haulerCount(0, 0)).toBe(0);
    expect(haulerCount(0, 0.5)).toBe(1);
    expect(haulerCount(2, 1)).toBe(3);
    expect(haulerCount(9, 1)).toBe(3);
  });
});

describe('hauler loop', () => {
  it('starts at the port gate and has a sensible length', () => {
    const planet = 'helion';
    const layout = layoutCity({ planet });
    const terrain = makeTerrain({ planet, goods: goodsOf(planet), flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });
    const port = layoutPort(layout, terrain);
    const loop = makeLoop(lanePolygon(haulPath(port, layout), 1.4));
    expect(loop.length).toBeGreaterThan(60);
    const first = loop.points[0]!;
    expect(Math.hypot(first[0] - port.gate[0], first[1] - port.gate[1])).toBeLessThan(2);
  });
});
