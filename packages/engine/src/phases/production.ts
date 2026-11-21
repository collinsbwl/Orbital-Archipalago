import { LedgerError } from '@orbital/contracts';
import type { Ledger, WorldConfig } from '@orbital/contracts';
import { agentId } from '../agents.js';

/** planet -> good -> units produced. */
export type Counts = Record<string, Record<string, number>>;

/** `planet|good` -> multiplier (shocks); missing = 1. */
export type Multipliers = ReadonlyMap<string, number>;
export const multKey = (planet: string, good: string): string => `${planet}|${good}`;

/**
 * Each planet runs each recipe up to batchesPerCycle. Batches go round-robin to the planet's colonists (start rotates
 * with the cycle). A batch whose owner lacks the inputs on that planet is skipped. `used`, when given, is filled with
 * the input units consumed per planet/good (for value-added GDP). `outputMult` scales the output of a good on a planet
 * (floored; inputs are still consumed, and an output scaled to 0 is simply not produced).
 */
export async function runProduction(world: WorldConfig, ledger: Ledger, cycle: number, used: Counts = {}, outputMult?: Multipliers): Promise<Counts> {
  const recipes = new Map(world.recipes.map((r) => [r.id, r]));
  const produced: Counts = {};
  for (const p of world.planets) {
    const out: Record<string, number> = (produced[p.id] = {});
    const inp: Record<string, number> = (used[p.id] = {});
    const n = p.agents.colonist;
    if (n === 0) continue;
    const total = p.recipes.reduce((s, r) => s + r.batchesPerCycle, 0);
    let k = (cycle * total) % n;
    for (const pr of p.recipes) {
      const recipe = recipes.get(pr.recipe)!;
      for (let b = 0; b < pr.batchesPerCycle; b++, k = (k + 1) % n) {
        try {
          const qty = Math.floor(recipe.output.qty * (outputMult?.get(multKey(p.id, recipe.output.good)) ?? 1));
          await ledger.produce({ owner: agentId(p.id, 'colonist', k), planet: p.id, inputs: recipe.inputs, outputs: qty > 0 ? [{ good: recipe.output.good, qty }] : [] });
          out[recipe.output.good] = (out[recipe.output.good] ?? 0) + qty;
          for (const i of recipe.inputs) inp[i.good] = (inp[i.good] ?? 0) + i.qty;
        } catch (e) {
          if (!(e instanceof LedgerError && e.code === 'insufficient_inventory')) throw e;
        }
      }
    }
  }
  return produced;
}
