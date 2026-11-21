import type { Ledger, WorldConfig } from '@orbital/contracts';
import { agentId } from '../agents.js';
import type { Counts } from './production.js';

/** Each colonist consumes what it has of each need, up to the need. Returns unmet units per planet/good. */
export async function runConsumption(world: WorldConfig, ledger: Ledger): Promise<Counts> {
  const unmet: Counts = {};
  for (const p of world.planets) {
    const out: Record<string, number> = (unmet[p.id] = {});
    for (let i = 0; i < p.agents.colonist; i++) {
      const id = agentId(p.id, 'colonist', i);
      for (const need of world.colonistNeeds) {
        const have = await ledger.getInventory(id, p.id, need.good);
        const take = Math.min(have, need.qty);
        if (take > 0) await ledger.consume({ owner: id, planet: p.id, cargo: [{ good: need.good, qty: take }] });
        if (take < need.qty) out[need.good] = (out[need.good] ?? 0) + (need.qty - take);
      }
    }
  }
  return unmet;
}
