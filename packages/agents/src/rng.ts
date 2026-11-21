// Seeded PRNG. Mulberry32 keyed by hash(seed, universeId, cycle, agentId). The
// same task always yields the same stub decision, which is what makes CI,
// replay and forks reproducible.

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(xs: readonly T[]): T;
  bool(probability?: number): boolean;
}

function fnv1a(str: string, seed: number): number {
  // 32-bit FNV-1a for the key hash; cheap and no deps.
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rngFor(args: { seed: number; universeId: string; cycle: number; agentId: string }): Rng {
  const h = fnv1a(`${args.universeId}|${args.cycle}|${args.agentId}`, args.seed);
  const next = mulberry32(h);
  return {
    next,
    int(maxExclusive: number): number {
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('pick from empty array');
      return xs[Math.floor(next() * xs.length)]!;
    },
    bool(p = 0.5): boolean {
      return next() < p;
    },
  };
}
