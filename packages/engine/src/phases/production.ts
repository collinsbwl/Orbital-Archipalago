import { LedgerError } from '@orbital/contracts';
import type { AgentId, Ledger, PlanetConfig, PlanetId, Recipe, WorldConfig } from '@orbital/contracts';
import { agentId } from '../agents.js';

/** planet -> good -> units produced. */
export type Counts = Record<string, Record<string, number>>;

/** `planet|good` -> multiplier (shocks); missing = 1. */
export type Multipliers = ReadonlyMap<string, number>;
export const multKey = (planet: string, good: string): string => `${planet}|${good}`;

/** Colonists living on each planet, in a fixed order (they may have moved there from another planet). */
export type Residents = ReadonlyMap<PlanetId, readonly AgentId[]>;

/** Every colonist on its home planet: the world before anyone migrates. */
export function homeResidents(world: WorldConfig): Residents {
  return new Map(world.planets.map((p) => [p.id, Array.from({ length: p.agents.colonist }, (_, i) => agentId(p.id, 'colonist', i))]));
}

/**
 * Output elasticity of labour. A planet's batches per cycle scale with (residents / configured colonists) to this
 * power: more hands make more, each extra one a bit less (land and equipment stay fixed), and an emptied planet keeps
 * more output per head. 1 would be linear.
 */
export const LABOR_EXPONENT = 0.85;

/** Batches of one recipe a planet runs with `residents` colonists; exactly `batchesPerCycle` at its configured size. */
export function batchesFor(planet: PlanetConfig, batchesPerCycle: number, residents: number): number {
  const base = planet.agents.colonist;
  if (residents === base || base === 0) return batchesPerCycle;
  return Math.round(batchesPerCycle * (residents / base) ** LABOR_EXPONENT);
}

/**
 * Each planet runs each recipe up to its batches per cycle (see `batchesFor`). Batches go round-robin to the colonists
 * living there (start rotates with the cycle). A batch whose owner lacks the inputs on that planet is skipped. `used`,
 * when given, is filled with the input units consumed per planet/good (for value-added GDP). `outputMult` scales the
 * output of a good on a planet (floored; inputs are still consumed, and an output scaled to 0 is simply not produced).
 * `residents` defaults to each planet's own colonists.
 */
export async function runProduction(
  world: WorldConfig, ledger: Ledger, cycle: number, used: Counts = {}, outputMult?: Multipliers, residents: Residents = homeResidents(world),
): Promise<Counts> {
  const recipes = new Map(world.recipes.map((r) => [r.id, r]));
  const produced: Counts = {};
  // Batches grouped by owner: one owner's batches run in order (a later one may need an earlier one's output), while
  // different owners only touch their own inventory and run concurrently (one transaction each on a chain ledger).
  const byOwner = new Map<string, { planet: string; recipe: Recipe }[]>();
  for (const p of world.planets) {
    produced[p.id] = {};
    used[p.id] = {};
    const here = residents.get(p.id) ?? [];
    const n = here.length;
    if (n === 0) continue;
    const batches = p.recipes.map((pr) => batchesFor(p, pr.batchesPerCycle, n));
    const total = batches.reduce((s, b) => s + b, 0);
    let k = (cycle * total) % n;
    for (const [r, pr] of p.recipes.entries()) {
      const recipe = recipes.get(pr.recipe)!;
      for (let b = 0; b < batches[r]!; b++, k = (k + 1) % n) {
        const owner = here[k]!;
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
