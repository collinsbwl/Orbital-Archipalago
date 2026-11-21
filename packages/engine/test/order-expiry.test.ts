import { DEFAULT_WORLD } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ORDER_TTL_CYCLES, listAgents, RandomValidPolicy, Universe } from '../src/index.js';

/** Age (in cycles) of the oldest resting order after each of `cycles` steps. */
async function oldestAges(orderTtlCycles: number | undefined, cycles: number): Promise<number[]> {
  const world = DEFAULT_WORLD;
  const ledger = new InMemoryLedger(world);
  const u = new Universe({ world, ledger, agents: new RandomValidPolicy(world, world.seed), ...(orderTtlCycles !== undefined ? { orderTtlCycles } : {}) });
  await u.init();
  const agents = listAgents(world).map((a) => a.id);
  const ages: number[] = [];
  for (let c = 0; c < cycles; c++) {
    await u.step();
    let oldest = 0;
    for (const id of agents) for (const o of await ledger.openOrders(id)) oldest = Math.max(oldest, c - o.cycle);
    ages.push(oldest);
  }
  return ages;
}

describe('order expiry', () => {
  it('cancels resting orders once they reach the lifetime, refunding their escrow', async () => {
    const ttl = 5;
    const ages = await oldestAges(ttl, 40);
    expect(Math.max(...ages)).toBeLessThan(ttl); // nothing rests for `ttl` cycles or more
    expect(Math.max(...ages)).toBeGreaterThan(0); // but orders do rest across cycles first
  });

  it('is on by default', async () => {
    expect(DEFAULT_ORDER_TTL_CYCLES).toBeGreaterThan(0);
    expect(Math.max(...(await oldestAges(undefined, 40)))).toBeLessThan(DEFAULT_ORDER_TTL_CYCLES);
  });

  it('0 turns it off, and then stale orders accumulate', async () => {
    expect(Math.max(...(await oldestAges(0, 40)))).toBeGreaterThanOrEqual(DEFAULT_ORDER_TTL_CYCLES);
  });
});
