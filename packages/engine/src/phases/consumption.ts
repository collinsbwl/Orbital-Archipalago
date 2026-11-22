import type { Ledger, WorldConfig } from '@orbital/contracts';
import { agentId } from '../agents.js';
import type { HouseholdLoad } from '../demographics.js';
import { multKey } from './production.js';
import type { Counts, Multipliers } from './production.js';

/** Household sizes (ppm of a person) per planet, and the mean initial size a base need refers to. */
export interface HouseholdSizes {
  sizesPpm: readonly number[];
  avgPpm: number;
}
export interface ConsumptionHouseholds {
  households: ReadonlyMap<string, HouseholdSizes>;
  /** Filled per planet with each household's needed and unmet units (all needs together). */
  loads?: Map<string, HouseholdLoad[]>;
}

/**
 * Each colonist household consumes what it has of each need, up to the need. Returns unmet units per planet/good.
 * A planet's total need of a good is floor(qty * m * people / avgHouseholdSize), `m` being the `needMult` shock; it is
 * spread over the households in proportion to their size (cumulative floors, so the parts sum exactly). Without
 * `demo` every colonist is a household of one, which gives the old even spread.
 */
export async function runConsumption(world: WorldConfig, ledger: Ledger, needMult?: Multipliers, demo?: ConsumptionHouseholds): Promise<Counts> {
  const unmet: Counts = {};
  for (const p of world.planets) {
    const out: Record<string, number> = (unmet[p.id] = {});
    const n = p.agents.colonist;
    const hh = demo?.households.get(p.id);
    const sizes = hh && hh.sizesPpm.length === n ? hh.sizesPpm : Array<number>(n).fill(1_000_000);
    const avg = hh && hh.sizesPpm.length === n ? hh.avgPpm : 1_000_000;
    const total = sizes.reduce((s, x) => s + x, 0);
    const loads: HouseholdLoad[] = sizes.map(() => ({ needed: 0, unmet: 0 }));
    const cum = [0];
    for (const s of sizes) cum.push(cum[cum.length - 1]! + s);
    for (const need of world.colonistNeeds) {
      const m = needMult?.get(multKey(p.id, need.good)) ?? 1;
      const totalNeed = total > 0 ? Math.floor((need.qty * m * total) / avg + 1e-9) : 0;
      for (let i = 0; i < n; i++) {
        const id = agentId(p.id, 'colonist', i);
        const needed = Math.floor((totalNeed * cum[i + 1]!) / total) - Math.floor((totalNeed * cum[i]!) / total);
        const have = await ledger.getInventory(id, p.id, need.good);
        const take = Math.min(have, needed);
        if (take > 0) await ledger.consume({ owner: id, planet: p.id, cargo: [{ good: need.good, qty: take }] });
        loads[i]!.needed += needed;
        if (take < needed) {
          out[need.good] = (out[need.good] ?? 0) + (needed - take);
          loads[i]!.unmet += needed - take;
        }
      }
    }
    demo?.loads?.set(p.id, loads);
  }
  return unmet;
}
