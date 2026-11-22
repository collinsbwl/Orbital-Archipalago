import { describe, expect, it } from 'vitest';
import { alienActivity, alienRig, PARTS, RAMP, TURN_TIME } from './alien-rig';

const cycle = { walkSpan: 10, talkSpan: 4, cycleOffset: 0 };

describe('alienActivity', () => {
  it('walks, then stops to talk, then walks again', () => {
    expect(alienActivity(cycle, 5)).toMatchObject({ walk: 1, talk: 0 });
    expect(alienActivity(cycle, 12)).toMatchObject({ walk: 0, talk: 1 });
    expect(alienActivity(cycle, 19)).toMatchObject({ walk: 1, talk: 0 });
  });

  it('eases between the two, never jumping', () => {
    let prev = alienActivity(cycle, 0);
    for (let t = 0.01; t < 60; t += 0.01) {
      const a = alienActivity(cycle, t);
      expect(Math.abs(a.walk - prev.walk)).toBeLessThan(0.1);
      expect(Math.abs(a.talk - prev.talk)).toBeLessThan(0.1);
      expect(a.walk + a.talk).toBeLessThanOrEqual(1.0001);
      prev = a;
    }
  });

  it('turns to face a partner slowly: facing forward when walking, turned mid-talk, never a jump', () => {
    expect(alienActivity(cycle, 5).face).toBe(0);
    expect(alienActivity(cycle, 12).face).toBe(1);
    let prev = alienActivity(cycle, 0).face;
    let fastest = 0;
    for (let t = 0.01; t < 60; t += 0.01) {
      const f = alienActivity(cycle, t).face;
      fastest = Math.max(fastest, Math.abs(f - prev) / 0.01);
      prev = f;
    }
    // A smoothstep over TURN_TIME peaks at 1.5 / TURN_TIME per second.
    expect(fastest).toBeLessThan((1.5 / TURN_TIME) * 1.2);
    expect(TURN_TIME).toBeGreaterThan(RAMP);
  });

  it('only moves forward, and not while talking', () => {
    let prev = alienActivity(cycle, 0).walked;
    for (let t = 0.05; t < 60; t += 0.05) {
      const w = alienActivity(cycle, t).walked;
      expect(w).toBeGreaterThanOrEqual(prev - 1e-9);
      // Distance gained per step never beats full pace, and ends at zero gain mid-talk.
      expect(w - prev).toBeLessThanOrEqual(0.05 + 1e-9);
      prev = w;
    }
    expect(alienActivity(cycle, 12).walked).toBeCloseTo(alienActivity(cycle, 13).walked, 9);
  });

  it('matches a numeric integral of the walking pace', () => {
    let sum = 0;
    const dt = 0.001;
    for (let t = 0; t < 33; t += dt) sum += alienActivity(cycle, t + dt / 2).walk * dt;
    expect(alienActivity(cycle, 33).walked).toBeCloseTo(sum, 2);
  });

  it('shifts with the cycle offset', () => {
    expect(alienActivity({ ...cycle, cycleOffset: 10 }, 2)).toMatchObject({ walk: 0, talk: 1 });
    expect(RAMP).toBeGreaterThan(0);
  });
});

describe('alienRig', () => {
  it('swings legs against each other and arms against the legs when walking', () => {
    const r = alienRig({ walk: 1, talk: 0, stride: Math.PI / 2 }, 3, 0);
    expect(r.legL.rx).toBeCloseTo(-r.legR.rx, 9);
    expect(r.legL.rx).toBeGreaterThan(0.3);
    expect(Math.sign(r.armL.rx)).toBe(-Math.sign(r.legL.rx));
    expect(r.mouth.sy).toBe(1);
  });

  it('stands still when neither walking nor talking', () => {
    const r = alienRig({ walk: 0, talk: 0, stride: 1.234 }, 7, 2);
    for (const def of PARTS) {
      const p = r[def.name];
      expect([Math.abs(p.rx), Math.abs(p.ry), Math.abs(p.rz), p.sy]).toEqual([0, 0, 0, 1]);
    }
  });

  it('opens and closes the mouth and raises an arm when talking', () => {
    const sy: number[] = [];
    for (let t = 0; t < 10; t += 0.02) sy.push(alienRig({ walk: 0, talk: 1, stride: 0 }, t, 1).mouth.sy);
    expect(Math.min(...sy)).toBeLessThan(1.5);
    expect(Math.max(...sy)).toBeGreaterThan(3);
    expect(alienRig({ walk: 0, talk: 1, stride: 0 }, 2, 1).armR.rx).toBeLessThan(-0.5);
  });

  it('keeps a listener quiet and its arm low, while the speaker talks', () => {
    const listening = { walk: 0, talk: 1, stride: 0, speak: 0, paired: true };
    const speaking = { walk: 0, talk: 1, stride: 0, speak: 1, paired: true };
    let loud = 1;
    for (let t = 0; t < 10; t += 0.02) {
      expect(alienRig(listening, t, 1).mouth.sy).toBe(1);
      loud = Math.max(loud, alienRig(speaking, t, 1).mouth.sy);
    }
    expect(loud).toBeGreaterThan(3);
    expect(alienRig(listening, 2, 1).armR.rx).toBeGreaterThan(alienRig(speaking, 2, 1).armR.rx + 0.4);
  });

  it('is deterministic', () => {
    const input = { walk: 0.4, talk: 0.6, stride: 2 };
    expect(alienRig(input, 5, 1)).toEqual(alienRig(input, 5, 1));
    expect(alienRig(input, 5, 1)).not.toEqual(alienRig(input, 5, 2));
  });
});
