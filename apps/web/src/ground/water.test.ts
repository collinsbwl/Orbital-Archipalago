import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { makeTerrain } from './terrain';
import { lakeSurface, riverSurface } from './water';

const verdan = makeTerrain({ planet: 'verdan', goods: goodsOf('verdan'), flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor('verdan').relief });

/** Upward-facing means a positive cross product in x/z (the ground's own winding). */
function faceUp(p: Float32Array, f: number): boolean {
  const ux = p[f + 3]! - p[f]!, uz = p[f + 5]! - p[f + 2]!;
  const vx = p[f + 6]! - p[f]!, vz = p[f + 8]! - p[f + 2]!;
  return uz * vx - ux * vz >= 0;
}

describe('water surfaces', () => {
  it('lake: a fan of upward triangles at the water level, reaching past the shore', () => {
    const lake = verdan.lakes[0]!;
    const p = lakeSurface(lake, 32);
    expect(p.length).toBe(32 * 9);
    for (let f = 0; f < p.length; f += 9) {
      expect(p[f + 1]).toBeCloseTo(lake.level);
      expect(faceUp(p, f)).toBe(true);
    }
    // Rim vertices sit beyond the shore (where the ground has risen above the water).
    // (Except where the river leaves the lake and cuts the bank.)
    let dry = 0;
    for (let f = 3; f < p.length; f += 9) if (verdan.heightAt(p[f]!, p[f + 2]!) > lake.level - 0.2) dry++;
    expect(dry).toBeGreaterThanOrEqual(30);
  });

  it('frozen lake sits a hair above the water level so ice reads as a slab', () => {
    const lake = { ...verdan.lakes[0]!, frozen: true };
    expect(lakeSurface(lake, 8)[1]).toBeGreaterThan(lake.level);
  });

  it('river: a strip of upward triangles that follows the water heights', () => {
    const river = verdan.rivers[0]!;
    const p = riverSurface(river);
    expect(p.length).toBe((river.points.length - 1) * 18);
    for (let f = 0; f < p.length; f += 9) expect(faceUp(p, f)).toBe(true);
    expect(p[1]).toBeCloseTo(river.points[0]!.y);
  });
});
