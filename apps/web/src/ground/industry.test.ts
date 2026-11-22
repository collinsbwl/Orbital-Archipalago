import { describe, expect, it } from 'vitest';
import { CITY_FLAT_RADIUS, CITY_RADIUS } from './city-layout';
import { goodsOf, groundLookFor } from './ground-look';
import { buildIndustry, industryEmitters } from './industry';
import { makeTerrain } from './terrain';

const make = (planet: string, goods = goodsOf(planet)) => makeTerrain({ planet, goods, flatRadius: CITY_FLAT_RADIUS, relief: groundLookFor(planet).relief });
const industry = (planet: string, goods?: string[]) => {
  const t = make(planet, goods);
  return { t, models: buildIndustry(t.sites, t.features.pits, t) };
};

describe('buildIndustry', () => {
  it('builds one model per site, with pieces, for every default planet', () => {
    for (const p of ['helion', 'verdan', 'tethys']) {
      const { t, models } = industry(p);
      expect(models).toHaveLength(t.sites.length);
      for (const m of models) expect(m.pieces.length).toBeGreaterThan(4);
    }
  });

  it('is deterministic', () => {
    expect(industry('helion').models).toEqual(industry('helion').models);
  });

  it('matches the planet goods: mines and refinery on Helion, farms and pumps on Verdan, forge on Tethys', () => {
    const kinds = (p: string) => new Set(industry(p).models.map((m) => m.site.kind));
    expect(kinds('helion')).toEqual(new Set(['mine', 'refinery']));
    expect(kinds('verdan')).toEqual(new Set(['farm', 'pump']));
    expect(kinds('tethys')).toEqual(new Set(['pump', 'forge']));
  });

  it('keeps pieces near their site (a mine reaches out to its ore pile) and well away from the city', () => {
    for (const p of ['helion', 'verdan', 'tethys', 'zz', 'qq']) {
      const { t, models } = industry(p);
      for (const m of models) {
        const reach = m.site.kind === 'mine' ? t.features.pits[0]!.radius + 16 : m.site.radius * 1.9 + 4;
        for (const piece of m.pieces) {
          expect(Math.hypot(piece.x - m.site.x, piece.z - m.site.z)).toBeLessThanOrEqual(reach);
          expect(Math.hypot(piece.x, piece.z)).toBeGreaterThan(CITY_RADIUS + 20);
        }
      }
    }
  });

  it('stands buildings on level ground: bases on the pad, not in the air or buried', () => {
    for (const p of ['helion', 'verdan', 'tethys']) {
      const { t, models } = industry(p);
      for (const m of models.filter((q) => q.site.kind !== 'mine')) {
        for (const piece of m.pieces) {
          if (piece.y > m.site.y + 0.001) continue; // raised parts (lids, roofs) sit on others
          expect(Math.abs(t.heightAt(piece.x, piece.z) - m.site.y)).toBeLessThan(0.9);
        }
      }
    }
  });

  it('puts the headframe on the pit floor and the ore pile on the rim, with the conveyor leaning up', () => {
    const { t, models } = industry('helion');
    for (const m of models.filter((q) => q.site.kind === 'mine')) {
      const pit = t.features.pits.find((q) => q.x === m.site.x)!;
      expect(m.site.y).toBeCloseTo(pit.rim - pit.depth, 3);
      const conveyor = m.pieces.find((q) => q.shape === 'box' && q.pitch !== undefined && q.pitch < 0)!;
      expect(conveyor).toBeDefined();
      const pile = m.pieces.find((q) => q.shape === 'cone')!;
      expect(pile.y).toBeCloseTo(t.heightAt(pile.x, pile.z), 3);
      expect(pile.y).toBeGreaterThan(m.site.y + pit.depth * 0.6);
      const tower = Math.max(...m.pieces.map((q) => q.y + (q.shape === 'box' ? q.size[1] : 0)));
      expect(tower).toBeGreaterThan(m.site.y + 9);
    }
  });

  it('runs the conveyor clear above the terraces all the way up', () => {
    for (const planet of ['helion', 'zz', 'qq', 'abc']) {
      const { t, models } = industry(planet, ['iron']);
      for (const m of models.filter((q) => q.site.kind === 'mine')) {
        const c = m.pieces.find((q) => q.shape === 'box' && q.pitch !== undefined && q.pitch < 0)!;
        const dir = [Math.sin(c.rotY) * Math.cos(c.pitch!), -Math.sin(c.pitch!), Math.cos(c.rotY) * Math.cos(c.pitch!)];
        const len = c.size[2];
        const mid = [c.x, c.y + 0.4, c.z];
        for (let k = 0; k <= 20; k++) {
          const s = (k / 20 - 0.5) * len;
          const x = mid[0]! + dir[0]! * s, y = mid[1]! + dir[1]! * s, z = mid[2]! + dir[2]! * s;
          expect(y).toBeGreaterThan(t.heightAt(x, z) - 0.3);
        }
      }
    }
  });

  it('keeps pump stations on dry ground, facing the water', () => {
    const { t, models } = industry('verdan');
    const lake = t.lakes[0]!;
    for (const m of models.filter((q) => q.site.kind === 'pump')) {
      for (const piece of m.pieces) if (Math.min(...piece.size) > 1) expect(t.waterDepthAt(piece.x, piece.z)).toBe(0);
      // Facing: the direction (sin, cos) of the heading points at the lake.
      const toLake = Math.atan2(lake.x - m.site.x, lake.z - m.site.z);
      expect(Math.cos(toLake - m.site.facing)).toBeGreaterThan(0.99);
    }
  });

  it('exposes emitters for Phase 10: chimneys and flare at the refinery, chimneys and furnace mouths at the forge', () => {
    const helion = industryEmitters(industry('helion').models);
    expect(helion.filter((e) => e.kind === 'chimney')).toHaveLength(1);
    expect(helion.filter((e) => e.kind === 'flare')).toHaveLength(1);
    const tethys = industryEmitters(industry('tethys').models);
    expect(tethys.filter((e) => e.kind === 'chimney')).toHaveLength(2);
    expect(tethys.filter((e) => e.kind === 'forge')).toHaveLength(3);
    for (const e of [...helion, ...tethys]) {
      const site = [...industry('helion').models, ...industry('tethys').models].find((m) => m.site.id === e.siteId)!.site;
      expect(e.y).toBeGreaterThan(site.y);
    }
    expect(industryEmitters(industry('verdan').models)).toEqual([]);
  });

  it('draws flames and furnaces glowing, and only those', () => {
    for (const p of ['helion', 'tethys']) {
      const glowing = industry(p).models.flatMap((m) => m.pieces).filter((q) => q.glow);
      expect(glowing.length).toBeGreaterThan(0);
      for (const g of glowing) expect(['#ff9a3a', '#ff6a1f']).toContain(g.color);
    }
    expect(industry('verdan').models.flatMap((m) => m.pieces).some((q) => q.glow)).toBe(false);
  });

  it('keeps size data on every piece (positive dimensions, valid colour)', () => {
    for (const p of ['helion', 'verdan', 'tethys']) {
      for (const m of industry(p).models) {
        for (const piece of m.pieces) {
          for (const n of piece.size) expect(n).toBeGreaterThan(0);
          expect(piece.color).toMatch(/^#[0-9a-f]{6}$/i);
          expect(Number.isFinite(piece.x + piece.y + piece.z + piece.rotY)).toBe(true);
        }
      }
    }
  });
});
