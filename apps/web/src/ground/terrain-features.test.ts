import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, layoutCity } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { makeTerrain } from './terrain';
import { lakeRadiusAt } from './terrain-features';
import { scatterTrees } from './trees';

const make = (planet: string, goods = goodsOf(planet)) => makeTerrain({ planet, goods, flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });

describe('terrain features by goods', () => {
  it('adds nothing when no goods are given', () => {
    const t = makeTerrain({ planet: 'helion', flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor('helion').relief });
    expect(t.sites).toEqual([]);
    expect(t.features.footprints).toEqual([]);
  });

  it('is deterministic', () => {
    const a = make('verdan');
    const b = make('verdan');
    expect(b.sites).toEqual(a.sites);
    expect(b.heightAt(260, -140)).toBe(a.heightAt(260, -140));
    expect(b.features.rivers).toEqual(a.features.rivers);
  });

  it('gives each good its own kind of site', () => {
    const kinds = (p: string) => new Set(make(p).sites.map((s) => s.kind));
    expect(kinds('helion')).toEqual(new Set(['mine', 'refinery']));
    expect(kinds('verdan')).toEqual(new Set(['farm', 'pump']));
    expect(kinds('tethys')).toEqual(new Set(['pump', 'forge']));
  });

  it('keeps every site outside the flat city ground, on the terrain, with unique ids', () => {
    for (const p of ['helion', 'verdan', 'tethys', 'zz', 'qq']) {
      const t = make(p);
      expect(new Set(t.sites.map((s) => s.id)).size).toBe(t.sites.length);
      for (const s of t.sites) {
        expect(Math.hypot(s.x, s.z)).toBeGreaterThan(CITY_FLAT_RADIUS);
        expect(s.y).toBeCloseTo(t.heightAt(s.x, s.z));
        expect(Math.hypot(Math.sin(s.facing), Math.cos(s.facing))).toBeCloseTo(1);
      }
    }
  });

  it('finds spots for everything on the default planets', () => {
    expect(make('helion').features.pits).toHaveLength(2);
    expect(make('helion').sites.filter((s) => s.kind === 'mine')).toHaveLength(2);
    expect(make('verdan').sites.filter((s) => s.kind === 'farm').length).toBeGreaterThanOrEqual(1);
    expect(make('verdan').fields.length).toBeGreaterThanOrEqual(2);
    expect(make('verdan').lakes).toHaveLength(1);
    expect(make('tethys').lakes).toHaveLength(1);
  });

  it('iron makes taller mountains, closer in', () => {
    const iron = make('helion', ['iron']);
    const plain = make('helion', ['fuel']);
    expect(iron.relief.mountains).toBeGreaterThan(plain.relief.mountains);
    expect(iron.relief.mountainStart).toBeLessThan(plain.relief.mountainStart);
    const high = (t: ReturnType<typeof make>) => Math.max(...Array.from({ length: 60 }, (_, i) => t.heightAt(300 * Math.cos(i / 9.5), 300 * Math.sin(i / 9.5))));
    expect(high(iron)).toBeGreaterThan(high(plain));
  });

  it('carves terraced pits: floor flat and well below the rim', () => {
    const t = make('helion');
    for (const pit of t.features.pits) {
      const floor = t.heightAt(pit.x, pit.z);
      expect(floor).toBeCloseTo(pit.rim - pit.depth, 3);
      expect(t.heightAt(pit.x + pit.radius * 0.15, pit.z)).toBeCloseTo(floor, 3);
      expect(t.heightAt(pit.x + pit.radius * 1.3, pit.z)).toBeGreaterThan(floor + pit.depth * 0.5);
      // Walking out from the floor never steps back down: a staircase.
      let last = -Infinity;
      for (let r = 0; r <= pit.radius; r += 0.5) {
        const h = t.heightAt(pit.x + r, pit.z);
        expect(h).toBeGreaterThanOrEqual(last - 1.5); // base hills may tilt it a little
        last = h;
      }
      const mine = t.sites.find((s) => s.kind === 'mine' && s.x === pit.x)!;
      expect(mine.y).toBeCloseTo(floor);
    }
  });

  it('flattens pads and fields', () => {
    const t = make('verdan');
    for (const f of t.fields) {
      for (const [u, v] of [[0, 0], [f.halfW * 0.7, f.halfD * 0.7], [-f.halfW * 0.7, f.halfD * 0.5]] as const) {
        const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
        expect(t.heightAt(f.x + u * c + v * s, f.z - u * s + v * c)).toBeCloseTo(f.y, 3);
      }
    }
    const h = make('helion');
    const refinery = h.sites.find((s) => s.kind === 'refinery')!;
    for (const a of [0, 1.5, 3, 4.5]) expect(h.heightAt(refinery.x + 15 * Math.sin(a), refinery.z + 15 * Math.cos(a))).toBeCloseTo(refinery.y, 3);
  });

  it('digs lakes: water over the middle, none on the flat shore, shore sites on dry level ground', () => {
    for (const p of ['verdan', 'tethys']) {
      const t = make(p);
      const lake = t.lakes[0]!;
      expect(t.waterDepthAt(lake.x, lake.z)).toBeGreaterThan(1.5);
      expect(t.heightAt(lake.x, lake.z)).toBeLessThan(lake.level - 1);
      for (const s of t.sites.filter((q) => q.kind === 'pump')) {
        expect(t.waterDepthAt(s.x, s.z)).toBe(0);
        const d = Math.hypot(s.x - lake.x, s.z - lake.z);
        expect(d).toBeGreaterThan(lakeRadiusAt(lake, Math.atan2(s.x - lake.x, s.z - lake.z)));
        expect(s.y).toBeCloseTo(lake.rim, 1);
      }
    }
  });

  it('freezes the lake on Tethys only, and gives Tethys ice sheets and ridges but no river', () => {
    expect(make('tethys').lakes[0]!.frozen).toBe(true);
    expect(make('verdan').lakes[0]!.frozen).toBe(false);
    const t = make('tethys');
    expect(t.features.sheets.length).toBeGreaterThanOrEqual(1);
    expect(t.rivers).toHaveLength(0);
    expect(t.surfaceAt(t.lakes[0]!.x, t.lakes[0]!.z).kind).toBe('ice');
    expect(make('verdan').surfaceAt(make('verdan').lakes[0]!.x, make('verdan').lakes[0]!.z).kind).toBe('bed');
  });

  it('runs a river out of the Verdan lake: water in the channel, never rising downstream, kept out of the city', () => {
    const t = make('verdan');
    const river = t.rivers[0]!;
    expect(river.points.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < river.points.length; i++) expect(river.points[i]!.y).toBeLessThanOrEqual(river.points[i - 1]!.y + 1e-9);
    for (const p of river.points) {
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(CITY_FLAT_RADIUS);
      expect(t.waterDepthAt(p.x, p.z)).toBeGreaterThan(0.3);
    }
  });

  it('keeps sites and features from overlapping each other', () => {
    for (const p of ['helion', 'verdan', 'tethys', 'zz']) {
      const fp = make(p).features.footprints;
      for (let i = 0; i < fp.length; i++)
        for (let j = i + 1; j < fp.length; j++) if (!fp[i]!.group || fp[i]!.group !== fp[j]!.group) expect(Math.hypot(fp[i]!.x - fp[j]!.x, fp[i]!.z - fp[j]!.z)).toBeGreaterThanOrEqual(fp[i]!.r + fp[j]!.r - 0.01);
    }
  });

  it('reports clearance: negative on a site, positive far away', () => {
    const t = make('helion');
    const s = t.sites[0]!;
    expect(t.siteClearance(s.x, s.z)).toBeLessThan(0);
    expect(t.siteClearance(0, 0)).toBeGreaterThan(50);
  });

  it('colours features: crops on fields, bed under water, nothing in the city', () => {
    const t = make('verdan');
    const f = t.fields[0]!;
    expect(t.surfaceAt(f.x, f.z).kind).toBe('field');
    expect(t.surfaceAt(0, 0).kind).toBe('none');
  });
});

describe('trees keep off the features', () => {
  for (const planet of ['helion', 'verdan', 'tethys']) {
    it(`${planet}: no plant on a pit, pad, field, lake or river`, () => {
      const layout = layoutCity({ planet });
      const t = make(planet);
      const trees = scatterTrees(t, layout, { planet });
      expect(trees.length).toBeGreaterThan(100);
      for (const tr of trees) {
        expect(t.siteClearance(tr.x, tr.z)).toBeGreaterThanOrEqual(3);
        expect(t.waterDepthAt(tr.x, tr.z)).toBe(0);
      }
    });
  }
});
