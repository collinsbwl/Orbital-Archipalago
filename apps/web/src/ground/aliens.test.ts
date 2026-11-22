import { describe, expect, it } from 'vitest';
import { ALIEN_COUNT, PAIR_COUNT, PAIR_GAP, ALIEN_SKINS, alienCount, alienPose, alienSkin, makeAliens } from './aliens';
import { layoutCity } from './city-layout';

describe('alienCount', () => {
  it('is always 30', () => {
    expect(alienCount()).toBe(30);
    expect(ALIEN_COUNT).toBe(30);
  });
});

describe('aliens', () => {
  const layout = layoutCity({ planet: 'helion' });
  const loops = layout.gatherLoops;
  const specs = makeAliens(loops, ALIEN_COUNT, 'helion');

  it('makes the fixed number, deterministically', () => {
    expect(specs).toHaveLength(30);
    expect(makeAliens(loops, ALIEN_COUNT, 'helion')).toEqual(specs);
    expect(makeAliens(loops, ALIEN_COUNT, 'verdan')).not.toEqual(specs);
  });

  it('spreads walkers over every gathering loop', () => {
    for (let l = 0; l < loops.length; l++) expect(specs.some((s) => s.loop === l)).toBe(true);
  });

  it('keeps walkers on the sidewalk or plaza at street level, never in a building', () => {
    for (const t of [0, 7.3, 31, 120, 999]) {
      for (const s of specs) {
        const p = alienPose(loops, s, t);
        expect(layout.onStreet(p.x, p.z, 0.5)).toBe(true);
        // On the plaza floor between the fountain and the market stalls.
        const r = Math.hypot(p.x, p.z);
        expect(r).toBeGreaterThan(3.2);
        expect(r).toBeLessThan(7.6);
        for (const b of layout.buildings) expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeGreaterThan(Math.min(b.w, b.d) / 2);
        expect(p.bob).toBeGreaterThanOrEqual(0);
        expect(p.bob).toBeLessThan(0.1);
      }
    }
  });

  it('moves over time and faces the way it walks', () => {
    // Find an alien and a moment where it is walking at full pace.
    const s = specs.find((x) => alienPose(loops, x, 1).walk === 1 && alienPose(loops, x, 1.5).walk === 1)!;
    const a = alienPose(loops, s, 1);
    const b = alienPose(loops, s, 1.5);
    const moved = Math.hypot(b.x - a.x, b.z - a.z);
    expect(moved).toBeGreaterThan(0.2);
    expect(moved).toBeLessThan(1.2);
    expect(Math.sin(a.heading) * (b.x - a.x) + Math.cos(a.heading) * (b.z - a.z)).toBeGreaterThan(0);
  });

  it('stops to talk: stands still, then walks on', () => {
    const s = specs[0]!;
    const cycle = s.walkSpan + s.talkSpan;
    // Seconds into its cycle are (t + offset) mod cycle; pick the middle of the talk and of the walk.
    const at = (phase: number) => (((phase - s.cycleOffset) % cycle) + cycle) % cycle;
    const talkT = at(s.walkSpan + s.talkSpan / 2);
    const a = alienPose(loops, s, talkT);
    const b = alienPose(loops, s, talkT + 0.5);
    expect(a.talk).toBe(1);
    expect(a.walk).toBe(0);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1e-9);
    expect(a.heading).toBeCloseTo(b.heading, 9);
    expect(alienPose(loops, s, at(s.walkSpan / 2)).walk).toBe(1);
  });

  describe('talking pairs', () => {
    const pairs = Array.from({ length: PAIR_COUNT }, (_, i) => [specs[2 * i]!, specs[2 * i + 1]!] as const);

    it('makes 10 pairs and 10 loners out of the 30', () => {
      expect(specs.filter((s) => s.role !== 0)).toHaveLength(20);
      expect(specs.filter((s) => s.role === 0)).toHaveLength(10);
      for (const [a, b] of pairs) expect(a.role).toBe(-b.role);
    });

    it('walks each pair abreast on one path and timing', () => {
      for (const [a, b] of pairs) {
        expect([a.loop, a.offset, a.speed, a.direction, a.walkSpan, a.talkSpan, a.cycleOffset]).toEqual([b.loop, b.offset, b.speed, b.direction, b.walkSpan, b.talkSpan, b.cycleOffset]);
        for (const t of [0, 5, 40, 200]) {
          const pa = alienPose(loops, a, t);
          const pb = alienPose(loops, b, t);
          expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeGreaterThan(PAIR_GAP * 0.8);
          expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeLessThan(PAIR_GAP * 1.01);
        }
      }
    });

    it('turns to face each other while talking, and walks side by side otherwise', () => {
      for (const [a, b] of pairs) {
        const cycle = a.walkSpan + a.talkSpan;
        const at = (phase: number) => (((phase - a.cycleOffset) % cycle) + cycle) % cycle;
        const talkT = at(a.walkSpan + a.talkSpan / 2);
        const pa = alienPose(loops, a, talkT);
        const pb = alienPose(loops, b, talkT);
        const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        // Each one's facing points at the other.
        expect(Math.sin(pa.heading) * (pb.x - pa.x) / d + Math.cos(pa.heading) * (pb.z - pa.z) / d).toBeGreaterThan(0.99);
        expect(Math.sin(pb.heading) * (pa.x - pb.x) / d + Math.cos(pb.heading) * (pa.z - pb.z) / d).toBeGreaterThan(0.99);
        // Walking, they both face the way they go (the same way).
        const w1 = alienPose(loops, a, at(a.walkSpan / 2));
        const w2 = alienPose(loops, b, at(a.walkSpan / 2));
        expect(w1.heading).toBeCloseTo(w2.heading, 9);
      }
    });

    it('trades turns speaking, and a loner always speaks', () => {
      const [a, b] = pairs[0]!;
      let aLead = 0;
      let bLead = 0;
      for (let t = 0; t < 60; t += 0.1) {
        const pa = alienPose(loops, a, t);
        const pb = alienPose(loops, b, t);
        if (pa.speak > 0.9) aLead++;
        if (pb.speak > 0.9) bLead++;
        expect(pa.speak + pb.speak).toBeCloseTo(1, 0);
      }
      expect(aLead).toBeGreaterThan(100);
      expect(bLead).toBeGreaterThan(100);
      const solo = specs.find((s) => s.role === 0)!;
      expect(alienPose(loops, solo, 12).speak).toBe(1);
      expect(alienPose(loops, solo, 12).paired).toBe(false);
    });

    it('keeps pairs inside the plaza band too', () => {
      for (const [a, b] of pairs) for (const t of [0, 9, 33, 111]) for (const s of [a, b]) {
        const p = alienPose(loops, s, t);
        const r = Math.hypot(p.x, p.z);
        expect(r).toBeGreaterThan(3.2);
        expect(r).toBeLessThan(7.6);
      }
    });
  });

  it('moves and turns smoothly, frame to frame', () => {
    const dt = 1 / 60;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    let worstTurn = 0;
    let worstStep = 0;
    for (const s of specs) {
      let prev = alienPose(loops, s, 0);
      for (let t = dt; t < 150; t += dt) {
        const p = alienPose(loops, s, t);
        worstTurn = Math.max(worstTurn, Math.abs(wrap(p.heading - prev.heading)));
        worstStep = Math.max(worstStep, Math.hypot(p.x - prev.x, p.z - prev.z));
        prev = p;
      }
    }
    // No snapping round corners and no jumps: the fastest legitimate turn is the quarter turn to face a partner, eased over about a second.
    expect(worstTurn).toBeLessThan(0.05);
    // Top speed is 1.7 m/s, about 0.03 m a frame (a little more on the outside of a ring).
    expect(worstStep).toBeLessThan(0.045);
  });

  it('gives each planet its own skin colour, shaded a little per alien', () => {
    expect(alienSkin('verdan', 1)).toBe(ALIEN_SKINS.verdan);
    expect(alienSkin('tethys', 1)).toBe(ALIEN_SKINS.tethys);
    expect(alienSkin('helion', 1)).toBe(ALIEN_SKINS.helion);
    expect(alienSkin('zz', 1)).toBe(ALIEN_SKINS.verdan);
    expect(alienSkin('helion', 0)).not.toBe(alienSkin('helion', 1));
    expect(alienSkin('helion', 0)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
