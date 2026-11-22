import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS } from './city-layout';
import { BLIGHT_CYCLES, blightLevel, CROP_PERIOD, cropColor, cropGrowth, cropHeight, cropPlants, fieldPhase, insideField, MAX_PLANTS } from './crops';
import { groundLookFor } from './ground-look';
import { makeTerrain } from './terrain';

const fieldsOf = (planet: string) => makeTerrain({ planet, goods: ['grain'], flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief }).fields;

describe('cropGrowth', () => {
  it('grows from sown to ripe, stands ripe, then resets at harvest', () => {
    expect(cropGrowth(0, 0)).toBe(0);
    expect(cropGrowth(CROP_PERIOD * 0.4, 0)).toBeGreaterThan(0.3);
    expect(cropGrowth(CROP_PERIOD * 0.4, 0)).toBeLessThan(0.7);
    expect(cropGrowth(CROP_PERIOD * 0.9, 0)).toBe(1);
    expect(cropGrowth(CROP_PERIOD * 0.999, 0)).toBe(1);
    expect(cropGrowth(CROP_PERIOD, 0)).toBe(0);
  });
  it('never decreases between harvests', () => {
    let prev = 0;
    for (let c = 0; c < CROP_PERIOD; c += 0.5) {
      const g = cropGrowth(c, 0.25 * 0);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
  it('is offset per field by its phase and stays in 0..1', () => {
    expect(fieldPhase('a')).not.toBe(fieldPhase('b'));
    for (const c of [-5, 0, 13.3, 500]) expect(cropGrowth(c, 0.37)).toBeGreaterThanOrEqual(0);
    expect(cropGrowth(10, 0.5)).not.toBe(cropGrowth(10, 0));
  });
});

describe('blightLevel', () => {
  const ev = (over: Partial<{ cycle: number; kind: 'headline' | 'policy' | 'shock' | 'crisis' | 'system'; planet: string; text: string }>) => ({ cycle: 30, kind: 'system' as const, text: '[god mode] drought on Verdan', ...over });
  it('is zero without a failure event for this planet', () => {
    expect(blightLevel([], 'verdan', 31)).toBe(0);
    expect(blightLevel([ev({})], 'helion', 31)).toBe(0);
    expect(blightLevel([ev({ text: 'Trade booms' })], 'verdan', 31)).toBe(0);
    expect(blightLevel([ev({ kind: 'policy' })], 'verdan', 31)).toBe(0);
  });
  it('finds a drought by its text or by the event planet, then fades out', () => {
    expect(blightLevel([ev({})], 'verdan', 31)).toBe(1);
    expect(blightLevel([ev({ planet: 'verdan', kind: 'shock', text: 'Blight hits the fields' })], 'verdan', 32)).toBe(1);
    expect(blightLevel([ev({})], 'verdan', 30 + BLIGHT_CYCLES * 0.75)).toBeGreaterThan(0);
    expect(blightLevel([ev({})], 'verdan', 30 + BLIGHT_CYCLES * 0.75)).toBeLessThan(1);
    expect(blightLevel([ev({})], 'verdan', 30 + BLIGHT_CYCLES + 1)).toBe(0);
    expect(blightLevel([ev({ cycle: 40 })], 'verdan', 31)).toBe(0); // not yet happened
  });
});

describe('cropColor and cropHeight', () => {
  const brown = cropColor(1, 1, 0.5);
  it('goes from green to gold as it ripens, and to brown in a blight', () => {
    const sprout = cropColor(0, 0, 0.5);
    const ripe = cropColor(1, 0, 0.5);
    expect(sprout[1]).toBeGreaterThan(sprout[0]);
    expect(ripe[0]).toBeGreaterThan(sprout[0]);
    expect(brown[1]).toBeLessThan(ripe[1]);
    expect(brown[0]).toBeGreaterThan(brown[2]);
    for (const c of [...sprout, ...ripe, ...brown]) expect(c).toBeGreaterThanOrEqual(0);
  });
  it('grows taller, and a blight stunts it', () => {
    expect(cropHeight(1, 0)).toBeGreaterThan(cropHeight(0, 0));
    expect(cropHeight(1, 1)).toBeLessThan(cropHeight(1, 0));
  });
});

describe('cropPlants', () => {
  it('plants every field of a grain world inside the field edges, deterministically', () => {
    for (const p of ['verdan', 'zz', 'qq', 'novara']) {
      const fields = fieldsOf(p);
      const plants = cropPlants(fields);
      expect(plants).toEqual(cropPlants(fields));
      if (fields.length === 0) continue;
      expect(plants.length).toBeGreaterThan(40);
      expect(plants.length).toBeLessThanOrEqual(MAX_PLANTS);
      for (const pl of plants) {
        expect(insideField(fields[pl.field]!, pl.x, pl.z)).toBe(true);
        expect(pl.y).toBe(fields[pl.field]!.y);
      }
    }
  });
  it('caps the count by widening the spacing, and handles no fields', () => {
    expect(cropPlants([])).toEqual([]);
    const fields = fieldsOf('verdan');
    const few = cropPlants(fields, 60);
    expect(few.length).toBeLessThanOrEqual(60);
    expect(few.length).toBeGreaterThan(10);
  });
});
