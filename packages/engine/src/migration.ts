import type { AgentId, GoodId, PlanetId, WorldConfig } from '@orbital/contracts';
import type { Residents } from './phases/production.js';

/** DEFAULT: tuning for colonist migration. */
export const MIGRATION_CONFIG = {
  /** A colonist leaves once a need has gone unmet this many cycles in a row. */
  hungerToLeave: 3,
  /** At most this many colonists leave one planet per cycle. */
  maxLeavingPerCycle: 4,
  /** Nobody leaves a planet with this many residents or fewer. */
  minPopulation: 5,
  /** A planet takes no newcomers at this multiple of its configured colonists. */
  maxPopulationMultiple: 3,
  /** The destination's fed share must beat the origin's by at least this much (0..1). */
  minFedAdvantage: 0.25,
  /** Share of a migrant's savings lost to the move, in bp. */
  movingCostBp: 1_000,
} as const;

/** Per colonist, per need good: cycles in a row it went unmet. */
export type Hunger = ReadonlyMap<AgentId, Readonly<Record<GoodId, number>>>;

export interface PlannedMove {
  agentId: AgentId;
  from: PlanetId;
  to: PlanetId;
  /** Longest run of unmet cycles across the colonist's needs. */
  hungerCycles: number;
  /** Needs unmet this cycle. */
  hungryFor: GoodId[];
}

/** Longest current run of unmet cycles across a colonist's needs (0 when fed). */
export const longestHunger = (h: Readonly<Record<GoodId, number>> | undefined): number => Math.max(0, ...Object.values(h ?? {}));

/**
 * Share of each planet's residents who had every need met this cycle (null for an empty planet). `unmetByAgent` holds
 * only the colonists who went without something.
 */
export function fedShares(residents: Residents, unmetByAgent: ReadonlyMap<AgentId, unknown>): Map<PlanetId, number | null> {
  const out = new Map<PlanetId, number | null>();
  for (const [planet, ids] of residents) {
    out.set(planet, ids.length === 0 ? null : ids.filter((id) => !unmetByAgent.has(id)).length / ids.length);
  }
  return out;
}

/**
 * Who moves this cycle. On each planet (world order), colonists hungry for at least `hungerToLeave` cycles leave,
 * longest-hungry first, for the planet that fed the largest share of its residents this cycle, if it beats home by
 * `minFedAdvantage` and has room. Ties go to the emptier planet, then world order. Pure and deterministic.
 */
export function planMigrations(
  world: WorldConfig, residents: Residents, hunger: Hunger, unmetByAgent: ReadonlyMap<AgentId, Readonly<Record<GoodId, number>>>,
  cfg: typeof MIGRATION_CONFIG = MIGRATION_CONFIG,
): PlannedMove[] {
  const fed = fedShares(residents, unmetByAgent);
  const pop = new Map(world.planets.map((p) => [p.id, residents.get(p.id)?.length ?? 0]));
  const cap = new Map(world.planets.map((p) => [p.id, Math.floor(p.agents.colonist * cfg.maxPopulationMultiple)]));
  const moves: PlannedMove[] = [];

  for (const p of world.planets) {
    const homeFed = fed.get(p.id);
    if (homeFed === null || homeFed === undefined) continue;
    const leaving = (residents.get(p.id) ?? [])
      .map((id, i) => ({ id, i, h: longestHunger(hunger.get(id)) }))
      .filter((c) => c.h >= cfg.hungerToLeave)
      .sort((a, b) => b.h - a.h || a.i - b.i);
    let left = 0;
    for (const c of leaving) {
      if (left >= cfg.maxLeavingPerCycle || pop.get(p.id)! <= cfg.minPopulation) break;
      const to = destination(world, p.id, homeFed, fed, pop, cap, cfg.minFedAdvantage);
      if (!to) break; // nowhere better for anyone here
      moves.push({ agentId: c.id, from: p.id, to, hungerCycles: c.h, hungryFor: Object.keys(unmetByAgent.get(c.id) ?? {}) });
      pop.set(p.id, pop.get(p.id)! - 1);
      pop.set(to, pop.get(to)! + 1);
      left++;
    }
  }
  return moves;
}

function destination(
  world: WorldConfig, from: PlanetId, homeFed: number, fed: ReadonlyMap<PlanetId, number | null>,
  pop: ReadonlyMap<PlanetId, number>, cap: ReadonlyMap<PlanetId, number>, minAdvantage: number,
): PlanetId | null {
  let best: { id: PlanetId; fed: number; fill: number } | null = null;
  for (const q of world.planets) {
    const f = fed.get(q.id);
    if (q.id === from || f === null || f === undefined || f < homeFed + minAdvantage) continue;
    if (pop.get(q.id)! >= cap.get(q.id)!) continue;
    const fill = pop.get(q.id)! / Math.max(1, cap.get(q.id)!);
    if (!best || f > best.fed || (f === best.fed && fill < best.fill)) best = { id: q.id, fed: f, fill };
  }
  return best?.id ?? null;
}
