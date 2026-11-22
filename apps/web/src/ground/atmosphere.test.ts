import { describe, expect, it } from 'vitest';
import { computeAtmosphere } from './atmosphere';
import type { Atmosphere, Rgb } from './atmosphere';
import { groundLookFor } from './ground-look';
import { CALM, settledMood } from './mood';
import type { MoodState } from './mood';
import type { Vec3 } from './sky-bodies';

const look = groundLookFor('verdan');
const sunAt = (h: number): Vec3 => [0.3, h, Math.sqrt(1 - h * h - 0.09)];
const at = (h: number, mood: Pick<MoodState, 'storm' | 'gloom' | 'cheer'> = CALM, id = 'verdan'): Atmosphere =>
  computeAtmosphere({ look: groundLookFor(id), mood, timeOfDay: h > 0 ? 0.5 : 0, sunDir: sunAt(h) });
const lum = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const STORM = settledMood({ storm: 1, gloom: 0, cheer: 0 });
const GLOOM = settledMood({ storm: 0, gloom: 1, cheer: 0 });

describe('day and night', () => {
  const noon = at(0.8);
  const dusk = at(0);
  const night = at(-0.7);

  it('goes bright at noon, dark at night, with the sky matching the look at noon', () => {
    expect(lum(noon.skyTop)).toBeGreaterThan(lum(night.skyTop) * 5);
    expect(lum(noon.skyHorizon)).toBeGreaterThan(lum(night.skyHorizon) * 4);
    expect(noon.skyTop[2]).toBeGreaterThan(noon.skyTop[0]); // verdan: blue sky
    expect(noon.daylight).toBe(1);
    expect(night.night).toBe(1);
    expect(noon.phase).toBe('day');
    expect(night.phase).toBe('night');
  });

  it('warms the horizon at sunset', () => {
    expect(dusk.twilight).toBeGreaterThan(0.9);
    expect(dusk.skyHorizon[0]).toBeGreaterThan(dusk.skyHorizon[2]);
    expect(dusk.skyHorizon[0]).toBeGreaterThan(noon.skyHorizon[0] * 0.8);
  });

  it('puts the fog at the horizon colour', () => {
    for (const a of [noon, dusk, night]) expect(a.fogColor).toEqual(a.skyHorizon);
  });

  it('has direct sun by day only, moon light at night only', () => {
    expect(noon.sunLight.intensity).toBeGreaterThan(1.2);
    expect(night.sunLight.intensity).toBe(0);
    expect(night.moonLight.intensity).toBeGreaterThan(0.2);
    expect(noon.moonLight.intensity).toBe(0);
    expect(night.moonLight.dir[1]).toBeGreaterThan(0);
  });

  it('keeps light brightness continuous through the day', () => {
    let prev = at(-1).hemi.intensity;
    for (let h = -1; h <= 1; h += 0.02) {
      const cur = at(h).hemi.intensity;
      expect(Math.abs(cur - prev)).toBeLessThan(0.08);
      prev = cur;
    }
  });

  it('lights windows, lamps and stars only after dark', () => {
    expect(noon.windows).toBe(0);
    expect(noon.lamps).toBe(0);
    expect(noon.stars).toBe(0);
    expect(night.windows).toBe(1);
    expect(night.lamps).toBe(1);
    expect(night.stars).toBeGreaterThan(0.9);
    expect(dusk.windows).toBeGreaterThan(0.3);
    expect(dusk.windows).toBeLessThan(0.9);
  });

  it('uses the sun direction it is given', () => {
    expect(noon.sunDir).toEqual(sunAt(0.8));
    expect(noon.sunLight.dir).toEqual(sunAt(0.8));
  });
});

describe('weather and mood', () => {
  it('darkens, greys and thickens the fog in a storm without ever going negative', () => {
    const clear = at(0.8);
    const storm = at(0.8, STORM);
    expect(lum(storm.skyHorizon)).toBeLessThan(lum(clear.skyHorizon));
    expect(storm.fogFar).toBeLessThan(clear.fogFar * 0.7);
    expect(storm.fogNear).toBeLessThan(clear.fogNear);
    expect(storm.fogFar).toBeGreaterThan(storm.fogNear);
    expect(storm.sunLight.intensity).toBeLessThan(clear.sunLight.intensity * 0.4);
    expect(storm.overcast).toBeGreaterThan(0.8);
    expect(storm.sunVisible).toBeLessThan(0.2);
  });

  it('makes gloom overcast and dim, but dry', () => {
    const clear = at(0.8);
    const gloom = at(0.8, GLOOM);
    expect(gloom.overcast).toBeGreaterThan(0.4);
    expect(gloom.overcast).toBeLessThan(at(0.8, STORM).overcast);
    expect(gloom.sunLight.intensity).toBeLessThan(clear.sunLight.intensity);
    expect(gloom.precipitation.amount).toBe(0);
  });

  it('rains only in a storm, with the planet\'s own kind of precipitation', () => {
    expect(at(0.8).precipitation.amount).toBe(0);
    expect(at(0.8, STORM).precipitation).toEqual({ kind: 'rain', amount: 1 });
    expect(at(0.8, STORM, 'helion').precipitation.kind).toBe('dust');
    expect(at(0.8, STORM, 'tethys').precipitation.kind).toBe('snow');
  });

  it('eases the precipitation in with the mood', () => {
    const amounts = [0, 0.3, 0.5, 0.7, 0.9, 1].map((s) => at(0.8, { storm: s, gloom: 0, cheer: 0 }).precipitation.amount);
    for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i - 1]!);
    expect(amounts[amounts.length - 1]).toBe(1);
  });

  it('is darker at night in a storm than at night clear, and lights come on early in a storm by day', () => {
    expect(lum(at(-0.7, STORM).skyHorizon)).toBeLessThanOrEqual(lum(at(-0.7).skyHorizon) * 4);
    expect(at(0.8, STORM).lamps).toBeGreaterThan(0.3);
    expect(at(0.8).lamps).toBe(0);
  });

  it('hides the stars behind cloud', () => {
    expect(at(-0.7, STORM).stars).toBeLessThan(at(-0.7).stars * 0.1);
  });

  it('keeps every colour channel and light strength in range', () => {
    for (const mood of [CALM, STORM, GLOOM, settledMood({ storm: 0, gloom: 0, cheer: 1 })]) {
      for (let h = -1; h <= 1; h += 0.1) {
        const a = at(h, mood);
        for (const c of [a.skyTop, a.skyHorizon, a.sunColor, a.hemi.sky, a.hemi.ground, a.moonLight.color]) for (const v of c) expect(v >= 0 && v <= 1.0001).toBe(true);
        expect(a.sunLight.intensity).toBeGreaterThanOrEqual(0);
        expect(a.hemi.intensity).toBeGreaterThan(0);
      }
    }
  });
});
