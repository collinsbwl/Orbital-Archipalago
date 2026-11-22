import { describe, expect, it } from 'vitest';
import { LAYERS, MAX_PUFFS_PER_EMITTER, puffAt, windFor } from './smoke';

const e = { x: 10, y: 5, z: -3 };
const wind = windFor('verdan');
const chimney = LAYERS.chimney[0]!;

describe('puffAt', () => {
  it('shows more puffs as density rises, never fewer', () => {
    let prev = 0;
    for (let d = 0; d <= 1.001; d += 0.1) {
      const shown = Array.from({ length: chimney.count }, (_, k) => puffAt(e, 0, chimney, k, 3, wind, d)).filter(Boolean).length;
      expect(shown).toBeGreaterThanOrEqual(prev);
      prev = shown;
    }
    expect(prev).toBe(chimney.count);
  });
  it('shows nothing at density 0 and any density keeps at least one puff', () => {
    expect(Array.from({ length: chimney.count }, (_, k) => puffAt(e, 0, chimney, k, 3, wind, 0)).every((p) => p === null)).toBe(true);
    expect(puffAt(e, 0, chimney, 0, 3, wind, 0.01)).not.toBeNull();
  });
  it('starts at the emitter, rises, drifts downwind and fades out', () => {
    // Find a time where puff 0 has just been born, then follow it.
    const ages = Array.from({ length: 200 }, (_, i) => puffAt(e, 0, chimney, 0, i * 0.05, wind, 1)!);
    const young = ages.reduce((a, b) => (b.age < a.age ? b : a));
    expect(young.age).toBeLessThan(0.05);
    expect(young.y - e.y).toBeLessThan(1);
    const old = ages.filter((p) => p.age > 0.6 && p.age < 0.7)[0]!;
    expect(old.y - e.y).toBeGreaterThan(5);
    expect((old.x - e.x) * wind.x + (old.z - e.z) * wind.z).toBeGreaterThan(2);
    const end = ages.filter((p) => p.age > 0.98)[0]!;
    expect(end.radius).toBeLessThan(0.2);
  });
  it('is a pure function of its inputs', () => {
    expect(puffAt(e, 3, chimney, 2, 17.3, wind, 0.8)).toEqual(puffAt(e, 3, chimney, 2, 17.3, wind, 0.8));
  });
  it('gives every emitter kind at least one layer, within the buffer bound', () => {
    for (const layers of Object.values(LAYERS)) {
      expect(layers.length).toBeGreaterThan(0);
      expect(layers.reduce((n, l) => n + l.count, 0)).toBeLessThanOrEqual(MAX_PUFFS_PER_EMITTER);
    }
  });
});

describe('windFor', () => {
  it('is a unit vector, fixed per planet', () => {
    const w = windFor('helion');
    expect(Math.hypot(w.x, w.z)).toBeCloseTo(1);
    expect(windFor('helion')).toEqual(w);
  });
});
