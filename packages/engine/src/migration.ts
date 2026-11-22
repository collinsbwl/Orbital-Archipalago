import type { PlanetId } from '@orbital/contracts';
import { PPM, allocate } from './demographics.js';
import type { PlanetDemography } from './demographics.js';

/**
 * Migration between planets. Working-age people move from less to more attractive planets, at a cost of travel time only
 * (no fare, no freighter capacity). People in transit consume and produce nothing. All sizes are integer ppm of a person.
 */
export const MIGRATION_CONFIG = {
  /** Migration is reviewed every this many cycles. */
  reviewIntervalCycles: 5,
  /** No reviews before this cycle (start-up metrics are not signal). */
  warmupCycles: 10,
  /** Share of an origin's working-age people that leaves per review, per unit (1.0) of attractiveness gap, in bp. */
  rateBp: 2_000,
  /** Distance damping: a pair's flow is scaled by k / (k + travelCycles). */
  distanceK: 4,
  /** Most an origin can send in one review, bp of its working-age people (200 = 2%). */
  maxOutflowBp: 200,
  /** Attractiveness weights in bp (sum 10_000): food security, relative wage, consumer confidence. */
  weights: { foodBp: 4_000, wageBp: 4_000, confidenceBp: 2_000 },
  /** The relative wage (planet wage / mean wage) is clamped to [0, this], in ppm (2.0). */
  wageCapPpm: 2 * PPM,
  /** A single flow of at least this many whole people is announced in the event feed. */
  eventMinPeople: 10,
  /** In-transit groups reported in a snapshot. */
  snapshotMaxGroups: 100,
};
export type MigrationConfig = typeof MIGRATION_CONFIG;

/** Last cycle's readings of one planet. */
export interface MigrationInput {
  planet: PlanetId;
  /** Real GDP per labour-input unit (not normalised). */
  wage: number;
  /** Unmet-needs share of last cycle, ppm. */
  unmetPpm: number;
  consumerConfidence: number;
}

export interface MigrantGroup {
  from: PlanetId;
  to: PlanetId;
  /** People in ppm. */
  ppm: number;
  departCycle: number;
  arriveCycle: number;
}

export interface MigrationFlow {
  from: PlanetId;
  to: PlanetId;
  /** ppm of a person. */
  ppm: number;
}

/** Attractiveness per planet in ppm (1_000_000 = best on every weight): food security, wage relative to the cross-planet mean, confidence. */
export function attractiveness(inputs: readonly MigrationInput[], cfg: MigrationConfig = MIGRATION_CONFIG): Map<PlanetId, number> {
  const mean = inputs.length > 0 ? inputs.reduce((s, i) => s + i.wage, 0) / inputs.length : 0;
  const w = cfg.weights;
  const out = new Map<PlanetId, number>();
  for (const i of inputs) {
    const food = PPM - Math.min(PPM, Math.max(0, i.unmetPpm));
    const wage = mean > 0 ? Math.min(cfg.wageCapPpm, Math.max(0, Math.round((i.wage * PPM) / mean))) : PPM;
    const conf = Math.round((Math.min(100, Math.max(0, i.consumerConfidence)) * PPM) / 100);
    out.set(i.planet, Math.round((w.foodBp * food + w.wageBp * wage + w.confidenceBp * conf) / 10_000));
  }
  return out;
}

export interface FlowInput {
  planet: PlanetId;
  /** Working-age people, ppm. */
  workingAge: number;
}

/**
 * Directed flows, in origin then destination order of `planets`. flow(i->j) = rate * workingAge_i * max(0, A_j - A_i) * k / (k + travel(i,j)),
 * each origin's total capped at maxOutflowBp of its working-age people (pairs scaled down together). `blocked` pairs carry nothing.
 */
export function migrationFlows(
  planets: readonly FlowInput[], attract: ReadonlyMap<PlanetId, number>, travel: (from: PlanetId, to: PlanetId) => number,
  blocked: (from: PlanetId, to: PlanetId) => boolean, cfg: MigrationConfig = MIGRATION_CONFIG,
): MigrationFlow[] {
  const out: MigrationFlow[] = [];
  const k = BigInt(cfg.distanceK);
  for (const a of planets) {
    const flows: MigrationFlow[] = [];
    for (const b of planets) {
      if (a.planet === b.planet || blocked(a.planet, b.planet)) continue;
      const gap = (attract.get(b.planet) ?? 0) - (attract.get(a.planet) ?? 0);
      if (gap <= 0) continue;
      const ppm = Number((BigInt(a.workingAge) * BigInt(cfg.rateBp) * BigInt(gap) * k) / (10_000n * BigInt(PPM) * (k + BigInt(travel(a.planet, b.planet)))));
      if (ppm > 0) flows.push({ from: a.planet, to: b.planet, ppm });
    }
    const total = flows.reduce((s, f) => s + f.ppm, 0);
    const cap = Math.floor((a.workingAge * cfg.maxOutflowBp) / 10_000);
    if (total > cap) for (const f of flows) f.ppm = Number((BigInt(f.ppm) * BigInt(cap)) / BigInt(total));
    out.push(...flows.filter((f) => f.ppm > 0));
  }
  return out;
}

/** Takes `ppm` working-age people out of a planet: from the cohort and, in proportion to size, from the households. Returns what was removed. */
export function removeMigrants(d: PlanetDemography, ppm: number): number {
  const take = Math.min(ppm, d.workingAge);
  if (take <= 0) return 0;
  d.workingAge -= take;
  const lost = allocate(take, d.households);
  for (let i = 0; i < d.households.length; i++) d.households[i] = d.households[i]! - lost[i]!;
  return take;
}

/** Settles `ppm` arrivals into the working-age cohort and the households, weighted to small, well-fed households. */
export function addMigrants(d: PlanetDemography, ppm: number): void {
  if (ppm <= 0) return;
  d.workingAge += ppm;
  const floor = Math.max(1, Math.floor(d.avgHouseholdPpm / 10));
  const weights = d.households.map((size, i) => Math.round(((d.securityBp[i] ?? 10_000) * d.avgHouseholdPpm * 1_000) / Math.max(size, floor)));
  const gain = allocate(ppm, weights.some((w) => w > 0) ? weights : weights.map(() => 1));
  for (let i = 0; i < d.households.length; i++) d.households[i] = d.households[i]! + gain[i]!;
}
