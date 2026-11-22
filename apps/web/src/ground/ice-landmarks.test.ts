import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, CITY_RADIUS, layoutCity } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { layoutMonoliths } from './IceLandmarks';
import { layoutPort, portClearance } from './port';
import { makeTerrain } from './terrain';

function setup(planet: string) {
  const look = groundLookFor(planet);
  const terrain = makeTerrain({ planet, goods: goodsOf(planet), flatRadius: CITY_FLAT_RADIUS, relief: look.relief });
  const layout = layoutCity({ planet });
  const port = layoutPort(layout, terrain);
  return { terrain, layout, port, list: layoutMonoliths(planet, layout, terrain, port) };
}

describe('layoutMonoliths', () => {
  it('builds tethys a carved shell and a skyline of colossal spires, all outside the city', () => {
    const { list } = setup('tethys');
    expect(list.filter((m) => m.kind === 'shell')).toHaveLength(1);
    expect(list.filter((m) => m.kind === 'spire').length).toBeGreaterThan(20);
    for (const m of list) expect(Math.hypot(m.x, m.z)).toBeGreaterThan(CITY_RADIUS + 10);
    expect(Math.max(...list.map((m) => m.height))).toBeGreaterThan(80);
  });

  it('keeps off water and the spaceport, and is the same every time', () => {
    const { terrain, port, list } = setup('tethys');
    for (const m of list) {
      expect(terrain.waterDepthAt(m.x, m.z)).toBeLessThanOrEqual(0);
      expect(portClearance(port, m.x, m.z)).toBeGreaterThan(0);
    }
    expect(setup('tethys').list).toEqual(list);
  });

  it('only tethys is a crystal world by default', () => {
    expect(groundLookFor('tethys').style).toBe('crystal');
    expect(groundLookFor('verdan').style).toBeUndefined();
    expect(groundLookFor('helion').style).toBeUndefined();
  });
});
