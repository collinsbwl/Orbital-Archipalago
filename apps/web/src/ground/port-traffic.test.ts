import { describe, expect, it } from 'vitest';
import type { Shipment } from '@orbital/contracts';
import { APPROACH_ALTITUDE, padFor, PARKED_CYCLES, portTraffic, REST_HEIGHT, shipPhase, shipPose } from './port-traffic';

const ship = (id: string, from: string, to: string, departCycle: number, arriveCycle: number): Shipment => ({
  id, owner: 'a', from, to, cargo: [{ good: 'iron', qty: 1 }], departCycle, arriveCycle, status: 'in_flight',
});

describe('shipPhase', () => {
  const s = ship('s', 'helion', 'verdan', 10, 20);
  it('lands during the last cycle before arrival', () => {
    expect(shipPhase(s, 'verdan', 18.9)).toBeNull();
    expect(shipPhase(s, 'verdan', 19)).toEqual({ phase: 'landing', t: 0 });
    expect(shipPhase(s, 'verdan', 19.5)?.t).toBeCloseTo(0.5);
  });
  it('parks after arrival, then leaves', () => {
    expect(shipPhase(s, 'verdan', 20)?.phase).toBe('parked');
    expect(shipPhase(s, 'verdan', 20 + PARKED_CYCLES - 0.01)?.phase).toBe('parked');
    expect(shipPhase(s, 'verdan', 20 + PARKED_CYCLES)).toBeNull();
  });
  it('takes off in the first cycle after departing, at the origin planet only', () => {
    expect(shipPhase(s, 'helion', 9.9)).toBeNull();
    expect(shipPhase(s, 'helion', 10.25)).toEqual({ phase: 'takeoff', t: 0.25 });
    expect(shipPhase(s, 'helion', 11)).toBeNull();
    expect(shipPhase(s, 'tethys', 10.25)).toBeNull();
  });
  it('ignores a ship that goes nowhere', () => {
    expect(shipPhase(ship('x', 'verdan', 'verdan', 1, 2), 'verdan', 1.5)).toBeNull();
  });
});

describe('portTraffic', () => {
  it('puts each ship on a different pad and never exceeds the pad count', () => {
    const many = Array.from({ length: 9 }, (_, i) => ship(`s${i}`, 'helion', 'verdan', 0, 10));
    const out = portTraffic(many, 'verdan', 9.5, 4);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((o) => o.pad)).size).toBe(4);
  });
  it('is stable: same input, same pads; a lone ship gets its hashed pad', () => {
    const one = [ship('abc', 'helion', 'verdan', 0, 10)];
    expect(portTraffic(one, 'verdan', 9.5, 4)).toEqual(portTraffic(one, 'verdan', 9.5, 4));
    expect(portTraffic(one, 'verdan', 9.5, 4)[0]!.pad).toBe(padFor('abc', 4));
  });
  it('gives ships in the air a pad before parked ones', () => {
    const parked = Array.from({ length: 4 }, (_, i) => ship(`a${i}`, 'helion', 'verdan', 0, 10));
    const landing = ship('z', 'tethys', 'verdan', 5, 20);
    const out = portTraffic([...parked, landing], 'verdan', 19.5, 4);
    expect(out.find((o) => o.shipment.id === 'z')).toBeDefined();
  });
  it('is empty when nothing is near', () => {
    expect(portTraffic([ship('s', 'helion', 'verdan', 0, 10)], 'tethys', 9.5)).toEqual([]);
  });
});

describe('shipPose', () => {
  it('is on the pad, nose up, when parked', () => {
    const p = shipPose({ phase: 'parked', t: 0.3 }, 1);
    expect([p.x, p.y, p.z]).toEqual([0, REST_HEIGHT, 0]);
    expect(p.nose).toEqual([0, 1, 0]);
    expect(p.burning).toBe(false);
  });
  it('lands: starts far and high, ends on the pad nose up, and only ever descends', () => {
    const start = shipPose({ phase: 'landing', t: 0 }, 0.5);
    const end = shipPose({ phase: 'landing', t: 1 }, 0.5);
    expect(start.y).toBeCloseTo(REST_HEIGHT + APPROACH_ALTITUDE);
    expect(start.fade).toBeLessThan(0.01);
    expect(end.y).toBeCloseTo(REST_HEIGHT);
    expect(Math.hypot(end.x, end.z)).toBeLessThan(0.01);
    expect(end.nose[1]).toBeGreaterThan(0.99);
    let prev = Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const y = shipPose({ phase: 'landing', t }, 0.5).y;
      expect(y).toBeLessThanOrEqual(prev + 1e-9);
      prev = y;
    }
  });
  it('takes off along the landing path backwards', () => {
    for (const t of [0, 0.3, 0.8, 1]) {
      const up = shipPose({ phase: 'takeoff', t }, 0.5);
      const down = shipPose({ phase: 'landing', t: 1 - t }, 0.5);
      expect(up.x).toBeCloseTo(down.x);
      expect(up.y).toBeCloseTo(down.y);
      expect(up.z).toBeCloseTo(down.z);
    }
    expect(shipPose({ phase: 'takeoff', t: 0 }, 0.5).nose[1]).toBeGreaterThan(0.99);
  });
  it('keeps the nose a unit vector', () => {
    for (const phase of ['landing', 'takeoff'] as const) {
      for (let t = 0; t <= 1; t += 0.1) {
        const n = shipPose({ phase, t }, 2).nose;
        expect(Math.hypot(...n)).toBeCloseTo(1);
      }
    }
  });
});
