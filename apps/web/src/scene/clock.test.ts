import { describe, expect, it } from 'vitest';
import { CycleClock } from './clock';

describe('CycleClock', () => {
  it('starts at 0 before any snapshot', () => {
    expect(new CycleClock().now(1000, false)).toBe(0);
  });

  it('glides between cycles and never reaches the next one', () => {
    const c = new CycleClock();
    c.observe(10, 0);
    c.observe(11, 500); // learns 500 ms per cycle
    expect(c.cycleMs).toBe(500);
    expect(c.now(500, false)).toBe(11);
    expect(c.now(750, false)).toBeCloseTo(11.5, 5);
    expect(c.now(60_000, false)).toBeLessThan(12); // waits for the next snapshot
  });

  it('smooths the estimate when the pace changes', () => {
    const c = new CycleClock();
    c.observe(0, 0);
    c.observe(1, 1000);
    c.observe(2, 1500); // now 500 ms per cycle
    expect(c.cycleMs).toBe(750);
  });

  it('handles skipped cycles and ignores repeats', () => {
    const c = new CycleClock();
    c.observe(0, 0);
    c.observe(0, 5);
    c.observe(4, 2000); // 4 cycles in 2 s
    expect(c.cycleMs).toBe(500);
  });

  it('holds still while frozen and resumes without a jump', () => {
    const c = new CycleClock();
    c.observe(5, 0);
    c.observe(6, 1000);
    expect(c.now(1500, false)).toBeCloseTo(6.5, 5);
    expect(c.now(1500, true)).toBeCloseTo(6.5, 5); // froze at 6.5
    expect(c.now(9000, true)).toBeCloseTo(6.5, 5); // stays there however long it is frozen
    expect(c.now(9000, false)).toBeCloseTo(6.5, 5); // resumes where it left off
    expect(c.now(9250, false)).toBeCloseTo(6.75, 5);
  });

  it('restarts cleanly when the cycle goes backwards (a fixture loop)', () => {
    const c = new CycleClock();
    c.observe(40, 0);
    c.observe(41, 500);
    c.observe(0, 1000);
    expect(c.now(1000, false)).toBe(0);
    expect(c.cycleMs).toBe(500);
  });
});
