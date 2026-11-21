import type { Ledger, WorldConfig } from '@orbital/contracts';
import { listAgents } from './agents.js';

/** Starting inventory of a colonist: this many cycles' worth of each need. */
export const STARTING_NEED_CYCLES = 3;

/** Opens treasuries and every agent account. Call once on a fresh ledger. */
export async function bootstrap(world: WorldConfig, ledger: Ledger): Promise<void> {
  const planets = new Map(world.planets.map((p) => [p.id, p]));
  for (const p of world.planets) {
    await ledger.openAccount({ owner: p.id, planet: p.id, purse: { [p.currency]: p.purses.treasury } });
  }
  for (const a of listAgents(world)) {
    const p = planets.get(a.planet)!;
    const amount = a.role === 'colonist' ? p.purses.colonist : a.role === 'trader' ? p.purses.trader : 0;
    const inventory: Record<string, number> = {};
    if (a.role === 'colonist') {
      for (const n of world.colonistNeeds) inventory[n.good] = (inventory[n.good] ?? 0) + n.qty * STARTING_NEED_CYCLES;
    }
    await ledger.openAccount({ owner: a.id, planet: a.planet, purse: { [p.currency]: amount }, inventory });
  }
}
