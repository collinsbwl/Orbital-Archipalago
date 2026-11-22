import { describe, expect, it } from 'vitest';
import { groundLookFor } from './ground-look';
import { DAY_LENGTH_CYCLES, latitudeFor, skyBasis, skyBodies, skyView, sunCelestial, timeOfDay, toLocal } from './sky-bodies';
import type { Vec3 } from './sky-bodies';

// Map positions in scene units, sun at the origin (see scene/frame.ts: planets lie in the x-z plane).
const PLANETS = { verdan: { x: 6, y: 0, z: 0 }, helion: { x: 0, y: 0, z: 3.5 }, tethys: { x: -9, y: 0, z: -2 } };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

describe('timeOfDay', () => {
  it('runs 0 to 1 over a day, repeating, and differs per planet', () => {
    const a = timeOfDay(3, 'verdan');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(timeOfDay(3 + DAY_LENGTH_CYCLES, 'verdan')).toBeCloseTo(a, 6);
    expect(timeOfDay(3, 'helion')).not.toBeCloseTo(a, 3);
  });

  it('honours a configured day length', () => {
    const half = timeOfDay(5, 'verdan', 10) - timeOfDay(0, 'verdan', 10);
    expect((half + 1) % 1).toBeCloseTo(0.5, 6);
  });
});

describe('sunCelestial', () => {
  it('points from the planet to the map origin', () => {
    const d = sunCelestial('verdan', PLANETS);
    expect(d[0]).toBeCloseTo(-1);
    expect(d[2]).toBeCloseTo(0);
    const h = sunCelestial('helion', PLANETS);
    expect(h[2]).toBeCloseTo(-1);
  });

  it('falls back to a fixed unit direction with no position', () => {
    const d = sunCelestial('zzz', undefined);
    expect(len(d)).toBeCloseTo(1);
    expect(sunCelestial('zzz', {})).toEqual(d);
  });
});

describe('the sun in the ground frame', () => {
  const view = (planet: string, cycle: number) =>
    skyView({ planetId: planet, sunElevation: groundLookFor(planet).sunElevation, cycle, planets: PLANETS });

  it('is a unit vector that rises, peaks at the look elevation at noon, and sets', () => {
    for (const planet of ['verdan', 'helion', 'tethys']) {
      const look = groundLookFor(planet);
      const heights: number[] = [];
      for (let i = 0; i < DAY_LENGTH_CYCLES * 4; i++) {
        const v = view(planet, i / 4);
        expect(len(v.sun)).toBeCloseTo(1);
        heights.push(v.sun[1]);
      }
      expect(Math.max(...heights)).toBeCloseTo(Math.sin(look.sunElevation), 1);
      expect(Math.min(...heights)).toBeCloseTo(-Math.sin(look.sunElevation), 1);
      expect(heights.some((h) => h > 0.05)).toBe(true);
      expect(heights.some((h) => h < -0.05)).toBe(true);
    }
  });

  it('is exactly the map sun direction turned by the planet spin, so day and night share one sun', () => {
    for (const c of [0, 4.3, 11.1, 19.9]) {
      const v = view('verdan', c);
      const celestial = sunCelestial('verdan', PLANETS);
      // Ground axes are orthonormal: turning the local sun back by them gives the map direction again.
      const back: Vec3 = [0, 1, 2].map((i) => v.sun[0] * v.basis.east[i]! + v.sun[1] * v.basis.up[i]! + v.sun[2] * v.basis.south[i]!) as Vec3;
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(celestial[i]!, 6);
    }
  });

  it('rises in the east and sets in the west', () => {
    const early = view('verdan', 0);
    const t0 = early.timeOfDay;
    // Find a cycle in the morning (before noon) and one in the afternoon.
    const at = (t: number) => view('verdan', ((t - t0 + 1) % 1) * DAY_LENGTH_CYCLES);
    expect(at(0.35).sun[0]).toBeGreaterThan(0.1);
    expect(at(0.65).sun[0]).toBeLessThan(-0.1);
    expect(at(0.5).sun[0]).toBeCloseTo(0, 3);
  });

  it('keeps the basis orthonormal', () => {
    const b = skyBasis([1, 0, 0], latitudeFor(0.9), 0.3);
    expect(dot(b.east, b.up)).toBeCloseTo(0);
    expect(dot(b.east, b.south)).toBeCloseTo(0);
    expect(dot(b.up, b.south)).toBeCloseTo(0);
    expect(len(b.up)).toBeCloseTo(1);
  });

  it('is right-handed: east x up = south, at any time and sun direction', () => {
    for (const sun of [[1, 0, 0], [0, 0.3, -1], [-0.6, 0.1, 0.7]] as Vec3[]) {
      for (const t of [0, 0.2, 0.5, 0.83]) {
        const b = skyBasis(sun, latitudeFor(0.9), t);
        const cross: Vec3 = [b.east[1] * b.up[2] - b.east[2] * b.up[1], b.east[2] * b.up[0] - b.east[0] * b.up[2], b.east[0] * b.up[1] - b.east[1] * b.up[0]];
        for (let i = 0; i < 3; i++) expect(cross[i]!).toBeCloseTo(b.south[i]!, 9);
      }
    }
  });

  it('turns the whole sky together: the angle between the sun and a planet never changes with time', () => {
    const angle = (c: number) => {
      const v = view('verdan', c);
      const h = v.bodies.find((b) => b.id === 'helion')!;
      return dot(v.sun, h.dir);
    };
    expect(angle(1)).toBeCloseTo(angle(9.5), 6);
  });
});

describe('skyBodies', () => {
  const basis = skyBasis(sunCelestial('verdan', PLANETS), latitudeFor(0.9), 0.5);
  const bodies = skyBodies('verdan', PLANETS, basis);

  it('lists every other planet once, not the home planet', () => {
    expect(bodies.map((b) => b.id).sort()).toEqual(['helion', 'tethys']);
  });

  it('points each at the right map direction', () => {
    const helion = bodies.find((b) => b.id === 'helion')!;
    const want = toLocal(basis, [-6, 0, 3.5].map((v) => v / Math.hypot(6, 3.5)) as Vec3);
    for (let i = 0; i < 3; i++) expect(helion.dir[i]).toBeCloseTo(want[i]!, 6);
  });

  it('draws nearer planets bigger', () => {
    const near = skyBodies('verdan', { ...PLANETS, helion: { x: 5, y: 0, z: 1 }, tethys: { x: -9, y: 0, z: -2 } }, basis);
    const a = near.find((b) => b.id === 'helion')!;
    const b = near.find((x) => x.id === 'tethys')!;
    expect(a.angularRadius).toBeGreaterThan(b.angularRadius);
  });

  it('lights each disc from the sun side', () => {
    for (const b of bodies) {
      expect(len(b.light)).toBeCloseTo(1);
      expect(dot(b.right, b.up)).toBeCloseTo(0);
      expect(dot(b.right, b.toward)).toBeCloseTo(0);
    }
    // Tethys is on the far side of the sun from Verdan, so we see its sunlit face (almost full); Helion is more of a half.
    const tethys = bodies.find((b) => b.id === 'tethys')!;
    const helion = bodies.find((b) => b.id === 'helion')!;
    expect(tethys.light[2]).toBeGreaterThan(0.9);
    expect(helion.light[2]).toBeLessThan(tethys.light[2]);
  });

  it('returns nothing when the home planet has no map position', () => {
    expect(skyBodies('nowhere', PLANETS, basis)).toEqual([]);
  });
});
