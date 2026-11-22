import type { AgentId, GoodId, Ledger, WorldConfig } from '@orbital/contracts';
import { homeResidents, multKey, settleAll } from './production.js';
import type { Counts, Multipliers, Residents } from './production.js';

export interface ConsumptionOpts {
  /** Colonists living on each planet, in order (default: each planet's own colonists). */
  residents?: Residents;
  /** Filled with the units each colonist went without this cycle, per need good (colonists with every need met are absent). */
  unmetByAgent?: Map<AgentId, Record<GoodId, number>>;
}

/**
 * Each colonist consumes what it has of each need on the planet it lives on, up to the need. Returns unmet units per
 * planet/good. `needMult` scales a planet's need of a good; the scaled total floor(n * qty * m) is spread evenly over
 * the planet's residents (so a +50% surge on a need of 1 makes every second colonist need 2).
 */
export async function runConsumption(world: WorldConfig, ledger: Ledger, needMult?: Multipliers, opts: ConsumptionOpts = {}): Promise<Counts> {
  const residents = opts.residents ?? homeResidents(world);
  const unmet: Counts = {};
  const tasks: Promise<void>[] = [];
  for (const p of world.planets) {
    const out: Record<string, number> = (unmet[p.id] = {});
    // Colonists only touch their own inventory, so they run concurrently (one transaction each on a chain ledger).
    (residents.get(p.id) ?? []).forEach((id, i) => {
      tasks.push((async () => {
        for (const n of world.colonistNeeds) {
          const m = needMult?.get(multKey(p.id, n.good)) ?? 1;
          const needed = Math.floor(n.qty * m * (i + 1) + 1e-9) - Math.floor(n.qty * m * i + 1e-9);
          const have = await ledger.getInventory(id, p.id, n.good);
          const take = Math.min(have, needed);
          if (take > 0) await ledger.consume({ owner: id, planet: p.id, cargo: [{ good: n.good, qty: take }] });
          if (take < needed) {
            out[n.good] = (out[n.good] ?? 0) + (needed - take);
            if (opts.unmetByAgent) {
              const mine = opts.unmetByAgent.get(id) ?? {};
              mine[n.good] = (mine[n.good] ?? 0) + (needed - take);
              opts.unmetByAgent.set(id, mine);
            }
          }
        }
      })());
    });
  }
  await settleAll(tasks);
  return unmet;
}
