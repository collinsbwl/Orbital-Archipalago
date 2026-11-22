import { describe, expect, it } from 'vitest';
import { festivalPieces, LANTERN_COUNT } from './festival';
import { activeBursts, FIRE_CHANCE, RISE_SECONDS, rocketPosition, SPARKS, sparkFade, sparkPosition } from './fireworks';
import { layoutCity, ROAD_WIDTH } from './city-layout';
import { LAMP_SPACING, streetLampPieces } from './lamps';

const layout = layoutCity({ planet: 'verdan', population: 500_000 });

describe('festivalPieces', () => {
  const pieces = festivalPieces(layout);
  it('puts banners on every road and lanterns round the plaza, lanterns glowing', () => {
    expect(pieces.filter((p) => p.glow).length).toBe(LANTERN_COUNT);
    expect(pieces.length).toBeGreaterThan(layout.roads.length * 6 * 2);
  });
  it('is deterministic', () => {
    expect(festivalPieces(layout)).toEqual(pieces);
  });
});

describe('streetLampPieces', () => {
  const pieces = streetLampPieces(layout);
  it('lights come as lamp-flagged glowing heads on posts, none on the carriageway', () => {
    const heads = pieces.filter((p) => p.glow);
    expect(heads.length).toBeGreaterThan(layout.roads.length * 6);
    expect(heads.every((p) => p.lamp)).toBe(true);
    expect(pieces.length).toBe(heads.length * 2);
    expect(heads.every((p) => layout.distanceToRoad(p.x, p.z) >= ROAD_WIDTH / 2)).toBe(true);
  });
  it('spaces them out', () => {
    expect(LAMP_SPACING).toBeGreaterThan(8);
  });
});

describe('fireworks', () => {
  it('fires occasionally, the same way every time', () => {
    let shots = 0;
    for (let t = 0; t < 200; t += 0.25) {
      const a = activeBursts(t, 'verdan');
      expect(activeBursts(t, 'verdan')).toEqual(a);
      shots += a.length > 0 ? 1 : 0;
    }
    expect(shots).toBeGreaterThan(20);
    expect(shots).toBeLessThan(800 * FIRE_CHANCE * 1.3);
  });

  it('climbs, then bursts into sparks that fall and fade', () => {
    const b = activeBursts(0, 'verdan').concat(...Array.from({ length: 60 }, (_, i) => activeBursts(i * 1.7, 'verdan')))[0]!;
    const rising = { ...b, age: RISE_SECONDS / 2 };
    expect(rocketPosition(rising)![1]).toBeGreaterThan(0);
    expect(sparkPosition(rising, 0)).toBeNull();
    const burst = { ...b, age: RISE_SECONDS + 0.5 };
    expect(rocketPosition(burst)).toBeNull();
    const ys = Array.from({ length: SPARKS }, (_, i) => sparkPosition(burst, i)![1]);
    expect(Math.max(...ys)).toBeGreaterThan(b.height);
    expect(Math.min(...ys)).toBeLessThan(b.height);
    expect(sparkFade({ ...b, age: RISE_SECONDS + 0.1 })).toBeGreaterThan(sparkFade({ ...b, age: RISE_SECONDS + 2 }));
  });
});
