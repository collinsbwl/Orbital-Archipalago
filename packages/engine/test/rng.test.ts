import { describe, expect, it } from 'vitest';
import { Rng } from '../src/index.js';

describe('Rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new Rng(7), b = new Rng(7), c = new Rng(8);
    const xs = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('round-trips state (fork)', () => {
    const a = new Rng(1);
    for (let i = 0; i < 5; i++) a.next();
    const fork = new Rng(999);
    fork.setState(a.getState());
    expect(Array.from({ length: 10 }, () => fork.next())).toEqual(Array.from({ length: 10 }, () => a.next()));
  });

  it('int, pick and shuffle stay in range / are permutations', () => {
    const r = new Rng(3);
    const ints = Array.from({ length: 500 }, () => r.int(2, 5));
    expect(Math.min(...ints)).toBe(2);
    expect(Math.max(...ints)).toBe(5);
    expect([10, 20, 30]).toContain(r.pick([10, 20, 30]));
    const xs = [1, 2, 3, 4, 5, 6];
    expect(r.shuffle(xs).sort()).toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
