import { describe, expect, it } from 'vitest';
import { goodsOf, groundLookFor, sunDirection } from './ground-look';

describe('groundLookFor', () => {
  it('has a hand-made look for the default planets', () => {
    expect(groundLookFor('verdan')).toMatchObject({ sky: '#8cc8ff', ground: '#5a9a4a' });
    expect(groundLookFor('helion').sky).toBe('#d99a5b');
    expect(groundLookFor('tethys').ground).toBe('#e8f4fa');
  });

  it('gives every look a sky gradient, sun, palette and fog that fits inside the terrain', () => {
    for (const id of ['verdan', 'helion', 'tethys', 'zzz']) {
      const look = groundLookFor(id);
      expect(look.skyTop).toMatch(/^#[0-9a-f]{6}$/);
      expect(look.palette.length).toBeGreaterThanOrEqual(3);
      expect(look.fogFar).toBeGreaterThan(look.fogNear);
      expect(look.fogFar).toBeLessThanOrEqual(450);
      expect(look.sunElevation).toBeGreaterThan(0);
    }
  });

  it('makes verdan blue and green, helion orange, tethys pale', () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [vr, , vb] = rgb(groundLookFor('verdan').skyTop);
    expect(vb).toBeGreaterThan(vr);
    expect(rgb(groundLookFor('verdan').ground)[1]).toBeGreaterThan(rgb(groundLookFor('verdan').ground)[0]!);
    const [hr, , hb] = rgb(groundLookFor('helion').ground);
    expect(hr).toBeGreaterThan(hb!);
    expect(Math.min(...rgb(groundLookFor('tethys').ground))).toBeGreaterThan(200);
  });

  it('derives an unknown planet from its id, the same every time', () => {
    expect(groundLookFor('zzz')).toEqual(groundLookFor('zzz'));
    expect(groundLookFor('zzz').ground).not.toBe(groundLookFor('qqq').ground);
  });
});

describe('goodsOf', () => {
  it('knows the default planets', () => {
    expect(goodsOf('helion')).toEqual(['iron', 'fuel']);
    expect(goodsOf('verdan')).toEqual(['grain', 'water']);
    expect(goodsOf('tethys')).toEqual(['water', 'tools']);
  });
  it('gives an unknown planet two different goods, stably', () => {
    const g = goodsOf('zzz');
    expect(g).toHaveLength(2);
    expect(g[0]).not.toBe(g[1]);
    expect(goodsOf('zzz')).toEqual(g);
  });
});

describe('sunDirection', () => {
  it('is a unit vector above the horizon at the look elevation', () => {
    const look = groundLookFor('helion');
    const d = sunDirection('helion', look);
    expect(Math.hypot(...d)).toBeCloseTo(1);
    expect(d[1]).toBeCloseTo(Math.sin(look.sunElevation));
  });
});
