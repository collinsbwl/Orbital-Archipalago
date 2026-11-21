import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { orbitPhase, planetPosition, travelCycles } from '../src/index.js';

const [helion, verdan, tethys] = DEFAULT_WORLD.planets as [(typeof DEFAULT_WORLD.planets)[number], (typeof DEFAULT_WORLD.planets)[number], (typeof DEFAULT_WORLD.planets)[number]];

describe('orbits', () => {
  it('phase is (cycle + phase) mod period', () => {
    expect(orbitPhase(helion, 0)).toBe(0);
    expect(orbitPhase(verdan, 0)).toBe(8);
    expect(orbitPhase(verdan, 24)).toBe(0);
    expect(orbitPhase(tethys, 100)).toBe((100 + 16) % 48);
  });

  it('places planets on their circle, repeating every period', () => {
    for (const p of DEFAULT_WORLD.planets) {
      for (const c of [0, 3, 17, 101]) {
        const { x, y } = planetPosition(p, c);
        expect(Math.hypot(x, y)).toBeCloseTo(p.orbit.radius, 9);
        const again = planetPosition(p, c + p.orbit.periodCycles);
        expect(again.x).toBeCloseTo(x, 9);
        expect(again.y).toBeCloseTo(y, 9);
      }
    }
    expect(planetPosition(helion, 0)).toEqual({ x: 100, y: 0 });
    expect(planetPosition(verdan, 0).y).toBeCloseTo(160, 9); // quarter period ahead
  });

  it('travel time is symmetric, at least minCycles, deterministic, and changes over the orbit', () => {
    const ids = DEFAULT_WORLD.planets.map((p) => p.id);
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const seen = new Set<number>();
        for (let c = 0; c < 240; c++) {
          const t = travelCycles(DEFAULT_WORLD, a, b, c);
          expect(t).toBe(travelCycles(DEFAULT_WORLD, b, a, c));
          expect(t).toBe(travelCycles(DEFAULT_WORLD, a, b, c));
          expect(t).toBeGreaterThanOrEqual(DEFAULT_WORLD.travel.minCycles);
          seen.add(t);
        }
        expect(seen.size, `${a}->${b}`).toBeGreaterThan(1);
      }
    }
    expect(travelCycles(DEFAULT_WORLD, 'helion', 'verdan', 0)).toBe(10); // ceil(sqrt(100^2 + 160^2) / 20)
  });

  it('respects minCycles when planets are close', () => {
    const world = { ...DEFAULT_WORLD, travel: { speedUnitsPerCycle: 1_000, minCycles: 3 } };
    expect(travelCycles(world, 'helion', 'verdan', 0)).toBe(3);
  });
});
