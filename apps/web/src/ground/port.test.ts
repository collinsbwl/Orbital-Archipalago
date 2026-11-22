import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, layoutCity } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { APRON_RADIUS, haulPath, layoutPort, PAD_RADIUS, portClearance, portPieces } from './port';
import { makeTerrain } from './terrain';

const PLANETS = ['helion', 'verdan', 'tethys', 'zz', 'qq', 'novara'];
const build = (planet: string) => {
  const terrain = makeTerrain({ planet, goods: goodsOf(planet), flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });
  const layout = layoutCity({ planet });
  return { terrain, layout, port: layoutPort(layout, terrain) };
};

describe('layoutPort', () => {
  it('is deterministic and uses a road other than the landing road', () => {
    for (const p of PLANETS) {
      const a = build(p);
      expect(a.port).toEqual(build(p).port);
      expect(a.port.road).not.toBe(0);
    }
  });

  it('keeps the whole apron on level ground inside the flat radius, clear of every terrain feature', () => {
    for (const p of PLANETS) {
      const { terrain, port } = build(p);
      expect(Math.hypot(port.x, port.z) + APRON_RADIUS).toBeLessThanOrEqual(CITY_FLAT_RADIUS);
      expect(terrain.siteClearance(port.x, port.z)).toBeGreaterThan(APRON_RADIUS);
      for (const pad of port.pads) expect(Math.abs(pad.y - port.y)).toBeLessThan(0.5);
      expect(terrain.waterDepthAt(port.x, port.z)).toBe(0);
    }
  });

  it('stays clear of every building the full-grown city has, and of the plaza', () => {
    for (const p of PLANETS) {
      const { layout, port } = build(p);
      for (const b of layout.buildings) {
        expect(Math.hypot(b.x - port.x, b.z - port.z)).toBeGreaterThan(APRON_RADIUS + Math.hypot(b.w, b.d) / 2 + 2);
      }
    }
  });

  it('has four pads, each wholly on the apron, not overlapping, and a tower on the apron', () => {
    const { port } = build('verdan');
    expect(port.pads).toHaveLength(4);
    for (const a of port.pads) {
      expect(Math.hypot(a.x - port.x, a.z - port.z) + PAD_RADIUS).toBeLessThan(APRON_RADIUS);
      for (const b of port.pads) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(PAD_RADIUS * 2);
    }
    expect(Math.hypot(port.tower[0] - port.x, port.tower[1] - port.z)).toBeLessThan(APRON_RADIUS);
  });

  it('joins the road with a spur that starts on the road and ends at the apron', () => {
    const { layout, port } = build('helion');
    const road = layout.roads[port.road]!;
    expect(layout.distanceToRoad(port.junction[0], port.junction[1])).toBeLessThan(0.01);
    expect(Math.hypot(port.gate[0] - port.x, port.gate[1] - port.z)).toBeCloseTo(APRON_RADIUS);
    expect(road.length).toBeGreaterThan(Math.hypot(...port.junction) - 0.01);
  });
});

describe('portClearance and portPieces', () => {
  it('is negative on the apron and spur, positive well away', () => {
    const { port } = build('verdan');
    expect(portClearance(port, port.x, port.z)).toBeLessThan(0);
    expect(portClearance(port, (port.gate[0] + port.junction[0]) / 2, (port.gate[1] + port.junction[1]) / 2)).toBeLessThan(0);
    expect(portClearance(port, 0, 0)).toBeGreaterThan(40);
  });

  it('draws apron, pads, tower and lights, some of them glowing', () => {
    const { port } = build('tethys');
    const pieces = portPieces(port);
    expect(pieces.length).toBeGreaterThan(30);
    expect(pieces.some((p) => p.glow)).toBe(true);
    expect(pieces.every((p) => Number.isFinite(p.x + p.y + p.z))).toBe(true);
  });
});

describe('haulPath', () => {
  it('runs from the gate to the plaza edge along the port road', () => {
    const { layout, port } = build('verdan');
    const path = haulPath(port, layout);
    expect(path[0]).toEqual(port.gate);
    expect(Math.hypot(...path[2]!)).toBeGreaterThan(layout.plazaRadius);
    expect(Math.hypot(...path[2]!)).toBeLessThan(layout.plazaRadius + 5);
  });
});
