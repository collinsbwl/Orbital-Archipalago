import { LedgerError } from '@orbital/contracts';
import type { Ledger, Recipe, WorldConfig } from '@orbital/contracts';
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
  // Batches grouped by owner: one owner's batches run in order (a later one may need an earlier one's output), while
  // different owners only touch their own inventory and run concurrently (one transaction each on a chain ledger).
  const byOwner = new Map<string, { planet: string; recipe: Recipe }[]>();
  for (const p of world.planets) {
    produced[p.id] = {};
    used[p.id] = {};
    const n = p.agents.colonist;
    if (n === 0) continue;
    const total = p.recipes.reduce((s, r) => s + r.batchesPerCycle, 0);
    let k = (cycle * total) % n;
    for (const pr of p.recipes) {
      const recipe = recipes.get(pr.recipe)!;
      for (let b = 0; b < pr.batchesPerCycle; b++, k = (k + 1) % n) {
        const owner = agentId(p.id, 'colonist', k);
        const list = byOwner.get(owner) ?? [];
        list.push({ planet: p.id, recipe });
        byOwner.set(owner, list);
      }
    }
  }
  await settleAll([...byOwner].map(async ([owner, batches]) => {
    for (const { planet, recipe } of batches) {
      try {
        const qty = Math.floor(recipe.output.qty * (outputMult?.get(multKey(planet, recipe.output.good)) ?? 1));
        await ledger.produce({ owner, planet, inputs: recipe.inputs, outputs: qty > 0 ? [{ good: recipe.output.good, qty }] : [] });
        const out = produced[planet]!;
        const inp = used[planet]!;
        out[recipe.output.good] = (out[recipe.output.good] ?? 0) + qty;
        for (const i of recipe.inputs) inp[i.good] = (inp[i.good] ?? 0) + i.qty;
      } catch (e) {
        if (!(e instanceof LedgerError && e.code === 'insufficient_inventory')) throw e;
      }
    }
  }));
  return produced;
}

/** Waits for every task (so none is left running against the ledger), then rethrows the first failure, if any. */
export async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}
