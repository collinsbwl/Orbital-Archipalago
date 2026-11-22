import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, layoutCity } from './city-layout';
import { groundLookFor } from './ground-look';
import { makeTerrain } from './terrain';
import { MAX_TREES, scatterTrees, speciesFor } from './trees';

function setup(planet: string) {
  const layout = layoutCity({ planet });
  const terrain = makeTerrain({ planet, flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });
  return { layout, terrain, trees: scatterTrees(terrain, layout, { planet }) };
}

describe('scatterTrees', () => {
  for (const planet of ['verdan', 'helion', 'tethys']) {
    describe(planet, () => {
      const { layout, terrain, trees } = setup(planet);

      it('plants a decent number, within the cap', () => {
        expect(trees.length).toBeGreaterThan(300);
        expect(trees.length).toBeLessThanOrEqual(MAX_TREES);
      });
      it('keeps the city, roads and steep slopes clear', () => {
        for (const t of trees) {
          expect(Math.hypot(t.x, t.z)).toBeGreaterThan(layout.radius);
          expect(layout.roadClearance(t.x, t.z)).toBeGreaterThanOrEqual(4);
          expect(terrain.slopeAt(t.x, t.z)).toBeLessThanOrEqual(0.5);
          expect(t.y).toBeCloseTo(terrain.heightAt(t.x, t.z));
        }
      });
      it('only grows what the planet grows', () => {
        const allowed = new Set(speciesFor(planet).species.map((s) => s.kind));
        for (const t of trees) expect(allowed.has(t.kind)).toBe(true);
      });
      it('is deterministic', () => {
        expect(scatterTrees(terrain, layout, { planet })).toEqual(trees);
      });
    });
  }

  it('gives each default planet its own species', () => {
    const kinds = (p: string) => new Set(speciesFor(p).species.map((s) => s.kind));
    expect(kinds('verdan')).toEqual(new Set(['broadleaf', 'conifer']));
    expect(kinds('helion')).toEqual(new Set(['scrub', 'rock']));
    expect(kinds('tethys')).toEqual(new Set(['spire', 'frostscrub']));
  });

  it('respects a smaller cap', () => {
    const { layout, terrain } = setup('verdan');
    expect(scatterTrees(terrain, layout, { planet: 'verdan', max: 100 })).toHaveLength(100);
  });

  it('plants nothing on ground that is all too steep', () => {
    const { layout } = setup('verdan');
    const cliff = { heightAt: () => 0, slopeAt: () => 5 };
    expect(scatterTrees(cliff, layout, { planet: 'verdan' })).toHaveLength(0);
  });
});
