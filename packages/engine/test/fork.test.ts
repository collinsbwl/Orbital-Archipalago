import { DEFAULT_WORLD } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { describe, expect, it } from 'vitest';
import { RandomValidPolicy, Universe } from '../src/index.js';
import type { CycleReport } from '../src/index.js';
import { makeUniverse, scripted } from './helpers.js';

async function run(u: Universe, cycles: number): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < cycles; i++) out.push(await u.step());
  return out;
}

describe('Universe.fork', () => {
  it('fork at cycle 30 then 20 cycles each with no input gives identical reports (the copy is complete)', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    await run(universe, 30);
    const fork = await universe.fork('u0-f1');
    expect(fork.cycle).toBe(30);
    expect(fork.universeId).toBe('u0-f1');
    const a = await run(universe, 20);
    const b = await run(fork, 20);
    expect(b).toEqual(a);
    const sa = await universe.snapshot({ series: [] });
    const sb = await fork.snapshot({ series: [] });
    expect(sb.universeId).toBe('u0-f1');
    expect({ ...sb, universeId: sa.universeId }).toEqual(sa);
    expect(fork.metricsHistory()).toEqual(universe.metricsHistory());
  }, 30_000);

  it('carries queued commands and active shocks into the fork; a tariff only on the fork makes it diverge', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    await run(universe, 30);
    universe.enqueue({ kind: 'shock', planet: 'verdan', shock: 'drought', good: 'grain', magnitudeBp: -5_000, durationCycles: 10 }, { sub: 't' });
    const fork = await universe.fork('u0-f1'); // forked with the shock still queued
    const a = await run(universe, 20);
    const b = await run(fork, 20);
    expect(b).toEqual(a);
    expect((await fork.snapshot({ series: [] })).events.some((e) => e.kind === 'shock' && e.text.includes('[god mode]'))).toBe(true);

    // Same again, but a tariff only on the fork.
    const twin = await universe.fork('u0-f2');
    twin.enqueue({ kind: 'tariff', planet: 'helion', good: 'iron', rateBp: 5_000 }, { sub: 't' });
    const c = await run(universe, 20);
    const d = await run(twin, 20);
    expect(d).not.toEqual(c);
    expect((await twin.snapshot({ series: [] })).planets.find((p) => p.planet === 'helion')!.policy.tariffsBp.iron).toBe(5_000);
    expect((await universe.snapshot({ series: [] })).planets.find((p) => p.planet === 'helion')!.policy.tariffsBp.iron).toBeUndefined();
  }, 30_000);

  it('throws when the ledger or the provider cannot fork', async () => {
    const { world, universe } = makeUniverse({ agents: scripted(() => []) });
    await universe.init();
    await expect(universe.fork('x')).rejects.toThrow(/provider/);
    const noClone = new Universe({ world, ledger: { ...new InMemoryLedger(world) } as never, agents: new RandomValidPolicy(world, 1) });
    await expect(noClone.fork('x')).rejects.toThrow(/ledger/);
  });
});
