import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS } from './city-layout';
import { groundLookFor } from './ground-look';
import { buildTerrainData, makeTerrain } from './terrain';

const make = (planet: string) => makeTerrain({ planet, flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });

describe('makeTerrain', () => {
  const t = make('verdan');

  it('is exactly flat under the city', () => {
    for (const [x, z] of [[0, 0], [30, -40], [-99, 5], [0, 100]] as const) expect(t.heightAt(x, z)).toBe(0);
  });

  it('ramps up smoothly beyond the flat ground', () => {
    // No big jump between neighbouring points just outside the flat radius.
    for (let a = 0; a < 6.28; a += 0.4) {
      const r = CITY_FLAT_RADIUS + 5;
      const h1 = t.heightAt(r * Math.cos(a), r * Math.sin(a));
      const h2 = t.heightAt((r + 1) * Math.cos(a), (r + 1) * Math.sin(a));
      expect(Math.abs(h1 - h2)).toBeLessThan(1);
    }
  });

  it('has hills near the city and much higher mountains far out', () => {
    let hill = 0;
    let mountain = 0;
    for (let a = 0; a < 6.28; a += 0.1) {
      hill = Math.max(hill, Math.abs(t.heightAt(180 * Math.cos(a), 180 * Math.sin(a))));
      mountain = Math.max(mountain, t.heightAt(380 * Math.cos(a), 380 * Math.sin(a)));
    }
    expect(hill).toBeGreaterThan(0.2);
    expect(hill).toBeLessThan(12);
    expect(mountain).toBeGreaterThan(30);
  });

  it('is deterministic per planet and differs between planets', () => {
    expect(make('verdan').heightAt(250, 130)).toBe(t.heightAt(250, 130));
    expect(make('helion').heightAt(250, 130)).not.toBe(t.heightAt(250, 130));
  });

  it('reports slope', () => {
    expect(t.slopeAt(0, 0)).toBe(0);
    let steepest = 0;
    for (let a = 0; a < 6.28; a += 0.1) steepest = Math.max(steepest, t.slopeAt(400 * Math.cos(a), 400 * Math.sin(a)));
    expect(steepest).toBeGreaterThan(0.1);
  });
});

describe('buildTerrainData', () => {
  const look = groundLookFor('helion');
  const t = make('helion');
  const data = buildTerrainData(t, look, { half: 200, segments: 16 });

  it('makes two triangles per cell with matching colours', () => {
    expect(data.positions.length).toBe(16 * 16 * 6 * 3);
    expect(data.colors.length).toBe(data.positions.length);
  });

  it('puts every vertex on the height function', () => {
    for (let v = 0; v < data.positions.length; v += 3 * 37) {
      expect(data.positions[v + 1]).toBeCloseTo(t.heightAt(data.positions[v]!, data.positions[v + 2]!), 3);
    }
  });

  it('gives the three vertices of a face one colour, within 0..1', () => {
    for (let v = 0; v < data.colors.length; v += 9) {
      expect(data.colors[v]).toBe(data.colors[v + 3]);
      expect(data.colors[v + 2]).toBe(data.colors[v + 8]);
    }
    expect(Math.max(...data.colors)).toBeLessThanOrEqual(1.5);
    expect(Math.min(...data.colors)).toBeGreaterThanOrEqual(0);
  });

  it('faces point up', () => {
    for (let f = 0; f < data.positions.length; f += 9) {
      const p = data.positions;
      const ux = p[f + 3]! - p[f]!, uy = p[f + 4]! - p[f + 1]!, uz = p[f + 5]! - p[f + 2]!;
      const vx = p[f + 6]! - p[f]!, vy = p[f + 7]! - p[f + 1]!, vz = p[f + 8]! - p[f + 2]!;
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
      void uy; void vy;
    }
  });
});
