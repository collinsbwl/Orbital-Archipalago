import type { Ledger, WorldConfig } from '@orbital/contracts';
import { agentId } from '../agents.js';
import { multKey } from './production.js';
import type { Counts, Multipliers } from './production.js';

/**
 * Each colonist consumes what it has of each need, up to the need. Returns unmet units per planet/good. `needMult`
 * scales a planet's need of a good; the scaled total floor(n * qty * m) is spread evenly over the colonists (so a +50%
 * surge on a need of 1 makes every second colonist need 2).
 */
export async function runConsumption(world: WorldConfig, ledger: Ledger, needMult?: Multipliers): Promise<Counts> {
  const unmet: Counts = {};
  for (const p of world.planets) {
    const out: Record<string, number> = (unmet[p.id] = {});
    for (let i = 0; i < p.agents.colonist; i++) {
      const id = agentId(p.id, 'colonist', i);
      for (const n of world.colonistNeeds) {
        const m = needMult?.get(multKey(p.id, n.good)) ?? 1;
        const needed = Math.floor(n.qty * m * (i + 1) + 1e-9) - Math.floor(n.qty * m * i + 1e-9);
        const have = await ledger.getInventory(id, p.id, n.good);
        const take = Math.min(have, needed);
        if (take > 0) await ledger.consume({ owner: id, planet: p.id, cargo: [{ good: n.good, qty: take }] });
        if (take < needed) out[n.good] = (out[n.good] ?? 0) + (needed - take);
      }
    }
  }
  return unmet;
}
