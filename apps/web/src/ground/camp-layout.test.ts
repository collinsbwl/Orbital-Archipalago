import { describe, expect, it } from 'vitest';
import { clearingPieces, hutPieces, isCampPlanet, rackPieces, torchPieces, trailPieces } from './camp-layout';
import { layoutCity } from './city-layout';
import { layoutStalls } from './market';

const layout = layoutCity({ planet: 'helion', population: 1_000_000 });

describe('camp', () => {
  it('only Helion and Tethys get the camp', () => {
    expect(isCampPlanet('helion')).toBe(true);
    expect(isCampPlanet('tethys')).toBe(true);
    expect(isCampPlanet('verdan')).toBe(false);
  });

  it('is the same every time', () => {
    expect(hutPieces(layout, 'helion')).toEqual(hutPieces(layout, 'helion'));
    expect(trailPieces(layout, 'helion')).toEqual(trailPieces(layout, 'helion'));
  });

  it('has a fire ring, huts, trails and torches', () => {
    expect(clearingPieces(layout, 'helion').length).toBeGreaterThan(15);
    expect(hutPieces(layout, 'helion').length).toBeGreaterThan(0);
    expect(trailPieces(layout, 'helion').length).toBeGreaterThan(layout.roads.length);
    expect(torchPieces(layout).some((p) => p.glow && p.lamp)).toBe(true);
  });

  it('keeps huts off the trails and out of the clearing', () => {
    for (const b of layout.buildings.filter((x) => x.ring <= 2)) expect(Math.hypot(b.x, b.z)).toBeGreaterThan(layout.plazaRadius);
  });

  it('hangs hides only on open racks', () => {
    const [stall] = layoutStalls('helion', layout.roads);
    expect(rackPieces(stall!, true).length).toBeGreaterThan(rackPieces(stall!, false).length);
  });
});

describe('tethys camp', () => {
  const ice = layoutCity({ planet: 'tethys', population: 1_000_000 });
  it('is frosty, not the hide-and-mud look of Helion', () => {
    expect(hutPieces(ice, 'tethys')).not.toEqual(hutPieces(ice, 'helion'));
    expect(clearingPieces(ice, 'tethys')[0]!.color).not.toBe(clearingPieces(ice, 'helion')[0]!.color);
    expect(hutPieces(ice, 'tethys').length).toBeGreaterThan(0);
  });
});
