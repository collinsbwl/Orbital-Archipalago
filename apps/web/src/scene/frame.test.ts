import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../test-fixtures';
import { orbitOf } from '../orbits';
import { PLANETS_ORBIT, planetPositions, SCALE, shipPosition, shipProgress, shipTooltip } from './frame';
import type { Shipment } from '@orbital/contracts';

const ship: Shipment = {
  id: 's1', owner: 'helion:trader:1', from: 'helion', to: 'verdan', cargo: [{ good: 'iron', qty: 12 }, { good: 'tools', qty: 3 }],
  departCycle: 10, arriveCycle: 14, status: 'in_flight',
};

describe('frame math', () => {
  it('keeps planets still on their orbit rings, spread evenly around the sun', () => {
    expect(PLANETS_ORBIT).toBe(false);
    const snap = makeSnapshot(7);
    const now = planetPositions(snap, snap.cycle);
    const later = planetPositions(snap, snap.cycle + 25.5);
    snap.planets.forEach((p, i) => {
      expect(now[p.planet]).toEqual(later[p.planet]); // does not move with the cycle
      expect(now[p.planet]!.y).toBe(0);
      expect(Math.hypot(now[p.planet]!.x, now[p.planet]!.z)).toBeCloseTo(orbitOf(p.planet, i).radius * SCALE, 9);
    });
    // evenly spread: neighbouring planets are an equal angle apart
    const angles = snap.planets.map((p) => Math.atan2(now[p.planet]!.z, now[p.planet]!.x));
    const gap = (a: number, b: number) => (((b - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    angles.forEach((a, i) => expect(gap(a, angles[(i + 1) % angles.length]!)).toBeCloseTo((2 * Math.PI) / angles.length, 9));
  });

  it('measures how far along a trip a ship is, clamped', () => {
    expect(shipProgress(ship, 10)).toBe(0);
    expect(shipProgress(ship, 12)).toBe(0.5);
    expect(shipProgress(ship, 99)).toBe(1);
    expect(shipProgress(ship, 0)).toBe(0);
  });

  it('puts a ship at its origin at departure and its destination at arrival', () => {
    const planets = { helion: { x: 0, y: 0, z: 2 }, verdan: { x: 4, y: 0, z: 0 } };
    expect(shipPosition(ship, planets, 10)).toEqual(planets.helion);
    expect(shipPosition(ship, planets, 14)).toEqual(planets.verdan);
    expect(shipPosition(ship, { helion: planets.helion }, 12)).toBeNull();
  });

  it('describes a ship for the hover tooltip', () => {
    const lines = shipTooltip(ship, 12.4);
    expect(lines).toEqual(['helion:trader:1', 'helion to verdan', 'iron x12, tools x3', 'arrives cycle 14 (in 2)']);
    expect(shipTooltip(ship, 14.2)[3]).toBe('arriving (cycle 14)');
  });
});
