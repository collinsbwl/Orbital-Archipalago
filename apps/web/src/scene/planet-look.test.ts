import { describe, expect, it } from 'vitest';
import { buildPlanetGeometry, hashString, lookFor, noise3 } from './planet-look';

describe('planet looks', () => {
  it('are hand-made for the default planets and stable for any other', () => {
    expect(lookFor('tethys').ring).toBeDefined();
    expect(lookFor('verdan').atmosphere).toBeDefined();
    expect(lookFor('helion').ring).toBeUndefined();
    const other = lookFor('zephyr');
    expect(other.palette).toHaveLength(4);
    expect(lookFor('zephyr')).toBe(other);
    expect(lookFor('zephyr').palette).toEqual(other.palette);
    expect(lookFor('quill').palette).not.toEqual(other.palette);
  });

  it('hash and noise are deterministic and in range', () => {
    expect(hashString('helion')).toBe(hashString('helion'));
    expect(hashString('helion')).not.toBe(hashString('verdan'));
    for (let i = 0; i < 50; i++) {
      const n = noise3(i * 0.37, i * 0.11, i * 0.73, 42);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
    expect(noise3(1.5, 2.5, 3.5, 1)).toBe(noise3(1.5, 2.5, 3.5, 1));
  });

  it('build the same colored, flat-shaded low-poly sphere every time', () => {
    const a = buildPlanetGeometry(lookFor('helion'));
    const b = buildPlanetGeometry(lookFor('helion'));
    const pos = a.getAttribute('position');
    expect(pos.count).toBe(320 * 3); // icosahedron, detail 3: 320 faces, not indexed
    expect(a.getAttribute('color').count).toBe(pos.count);
    expect(Array.from(a.getAttribute('color').array.slice(0, 30))).toEqual(Array.from(b.getAttribute('color').array.slice(0, 30)));
    // lumpy but still roughly a unit sphere
    const r = Math.hypot(pos.getX(0), pos.getY(0), pos.getZ(0));
    expect(r).toBeGreaterThan(0.8);
    expect(r).toBeLessThan(1.2);
    // different planets are colored differently
    const verdan = buildPlanetGeometry(lookFor('verdan'));
    expect(Array.from(verdan.getAttribute('color').array.slice(0, 12))).not.toEqual(Array.from(a.getAttribute('color').array.slice(0, 12)));
  });
});
