import { describe, expect, it } from 'vitest';
import { BOOM, initialBoom, squashScale, stepBoom } from './boom';

const run = (seconds: number, s = initialBoom(), dt = 1 / 60) => {
  const impacts: number[] = [];
  for (let t = 0; t < seconds; t += dt) {
    const hit = stepBoom(s, dt);
    if (hit !== null) impacts.push(hit);
  }
  return { s, impacts };
};

describe('boom entrance', () => {
  it('waits for the title before the island appears', () => {
    const { s } = run(BOOM.delay - 0.1);
    expect(s.phase).toBe('wait');
  });

  it('bursts toward the camera and overshoots in size', () => {
    const { s } = run(BOOM.delay + BOOM.launch - 0.02);
    expect(s.phase).toBe('launch');
    expect(s.scale).toBeGreaterThan(1.3);
    expect(s.z).toBeGreaterThan(0);
  });

  it('lands once with a shake, bounces, then settles to rest', () => {
    const { s, impacts } = run(5);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toBeGreaterThan(10);
    expect(s.phase).toBe('idle');
    expect(s.bounces).toBeGreaterThanOrEqual(2);
    expect(Math.abs(s.y)).toBeLessThanOrEqual(0.12);
    expect(s.scale).toBeCloseTo(1, 2);
    expect(s.shake).toBeLessThan(0.01);
  });

  it('never sinks below the ground while falling', () => {
    const s = initialBoom();
    for (let i = 0; i < 300; i++) {
      stepBoom(s, 1 / 60);
      if (s.phase === 'fall') expect(s.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('squashes on impact and springs back without inverting', () => {
    const s = initialBoom();
    let squashed = 0;
    for (let i = 0; i < 400; i++) {
      stepBoom(s, 1 / 60);
      const [, y] = squashScale(s);
      squashed = Math.max(squashed, 1 - y);
      expect(y).toBeGreaterThan(0.6);
    }
    expect(squashed).toBeGreaterThan(0.1);
    expect(squashScale(s)[1]).toBeCloseTo(1, 2);
  });

  it('caps a long frame so a stalled tab does not tunnel through the ground', () => {
    const s = initialBoom();
    run(BOOM.delay + BOOM.launch, s);
    stepBoom(s, 5);
    expect(s.t).toBeLessThan(BOOM.delay + BOOM.launch + 0.1);
    expect(s.y).toBeGreaterThanOrEqual(0);
  });

  it('starts at rest when reduced motion is asked for', () => {
    const s = initialBoom(true);
    expect(s.phase).toBe('idle');
    expect(stepBoom(s, 1 / 60)).toBeNull();
    expect(s.scale).toBe(1);
  });
});
