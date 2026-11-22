import type { PlanetConfig } from '@orbital/contracts';
import { RESERVE_BANK_CONFIG } from './reserve-bank.js';

/**
 * Population by age cohort and the households that make it up. Cohorts are integers in ppm of a person so that flows
 * far below one person per cycle still accumulate; households are integer ppm sizes that always sum to the cohort total.
 */
export const DEMOGRAPHICS_CONFIG = {
  cyclesPerYear: RESERVE_BANK_CONFIG.cyclesPerYear,
  /** Births per working-age person per year, ppm (4%). Reduced by the planet's unmet-needs share. */
  birthRatePpm: 40_000,
  /** Years spent as a child and as a working-age person (1/years of the cohort moves on each year). */
  childYears: 18,
  workingYears: 45,
  /** Deaths per person per year by cohort, ppm. Raised by the unmet-needs share. */
  childDeathPpm: 2_000,
  workingDeathPpm: 3_000,
  retiredDeathPpm: 50_000,
  /** Deaths are scaled by 1 + this * unmetShare. */
  unmetDeathMultiple: 2,
  /** Share of working-age people who work, bp, before feedback. */
  baseParticipationBp: 8_000,
  /** Participation lost at a 100% unmet share, as a fraction of the base (bp). */
  unmetParticipationPenaltyBp: 5_000,
  /** Participation lost per consumer-confidence point below `confidenceNeutral`, bp. */
  confidencePenaltyBpPerPoint: 10,
  confidenceNeutral: 50,
  /** Hours worked per participant, bp of the standard week (10_000 = 1.0). */
  hoursBp: 10_000,
};
export type DemographicsConfig = typeof DEMOGRAPHICS_CONFIG;

export const PPM = 1_000_000;

export interface Cohorts {
  children: number;
  workingAge: number;
  retired: number;
}

/** One planet's demographic state. All sizes are integer ppm of a person. */
export interface PlanetDemography extends Cohorts {
  /** Colonist households, in agent index order; sums to children + workingAge + retired. */
  households: number[];
  /** Initial mean household size (ppm); a household's need is the base need times size / this. */
  avgHouseholdPpm: number;
  /** Labour input at cycle 0 (the L0 of the production multiplier). */
  l0: number;
  /** Planet-wide unmet-needs share of the last completed cycle (ppm of needed units). */
  unmetPpm: number;
  /** Cohorts and rates only move when the planet has a configured population (otherwise static). */
  dynamic: boolean;
}

/** What households consumed and failed to consume in one cycle, by household. */
export interface HouseholdLoad {
  needed: number;
  unmet: number;
}

/** Splits `total` over `sizes` as evenly as possible, remainder to the lowest indexes. */
function evenSplit(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export function initDemography(planet: PlanetConfig, cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): PlanetDemography {
  const n = planet.agents.colonist;
  const pop = planet.population;
  const cohorts: Cohorts = pop
    ? { children: pop.children * PPM, workingAge: pop.workingAge * PPM, retired: pop.retired * PPM }
    : { children: 0, workingAge: n * PPM, retired: 0 };
  const total = cohorts.children + cohorts.workingAge + cohorts.retired;
  const d: PlanetDemography = {
    ...cohorts,
    households: n > 0 ? evenSplit(total, n) : [],
    avgHouseholdPpm: n > 0 ? total / n : PPM,
    l0: 0, unmetPpm: 0, dynamic: pop !== undefined,
  };
  d.l0 = labourInput(d, cfg.baseParticipationBp, cfg);
  return d;
}

export const totalPpm = (c: Cohorts): number => c.children + c.workingAge + c.retired;

/** Largest-remainder split of `total` in proportion to `weights` (BigInt, exact). Ties go to the lower index. Sums to `total`. */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (weights.length === 0 || total <= 0 || sum === 0n) return weights.map(() => 0);
  const t = BigInt(total);
  const parts = weights.map((w) => ({ q: (t * BigInt(w)) / sum, r: (t * BigInt(w)) % sum }));
  let left = Number(t - parts.reduce((s, p) => s + p.q, 0n));
  const order = parts.map((_, i) => i).sort((a, b) => (parts[a]!.r === parts[b]!.r ? a - b : parts[a]!.r > parts[b]!.r ? -1 : 1));
  const out = parts.map((p) => Number(p.q));
  for (const i of order) {
    if (left-- <= 0) break;
    out[i]!++;
  }
  return out;
}

/** Unmet units over needed units, in ppm (0 with no needs). */
export function unmetSharePpm(loads: readonly HouseholdLoad[]): number {
  let needed = 0, unmet = 0;
  for (const l of loads) { needed += l.needed; unmet += l.unmet; }
  return needed > 0 ? Math.min(PPM, Math.floor((unmet * PPM) / needed)) : 0;
}

export interface CohortFlows {
  births: number;
  toWorking: number;
  toRetired: number;
  deathsChildren: number;
  deathsWorking: number;
  deathsRetired: number;
}

/**
 * One cycle of flows (ppm of a person) from the cohorts at the start of the cycle. Births scale with (1 - share), deaths
 * with (1 + unmetDeathMultiple * share). Each flow is rounded once; deaths are clamped to what aging leaves in the cohort.
 */
export function cohortFlows(c: Cohorts, unmetPpm: number, cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): CohortFlows {
  const cpy = cfg.cyclesPerYear;
  const share = Math.min(PPM, Math.max(0, unmetPpm)) / PPM;
  const toWorking = Math.min(c.children, Math.round(c.children / (cfg.childYears * cpy)));
  const toRetired = Math.min(c.workingAge, Math.round(c.workingAge / (cfg.workingYears * cpy)));
  const death = (cohort: number, outflow: number, ratePpm: number) =>
    Math.min(cohort - outflow, Math.round(((cohort * ratePpm) / (PPM * cpy)) * (1 + cfg.unmetDeathMultiple * share)));
  return {
    births: Math.round(((c.workingAge * cfg.birthRatePpm) / (PPM * cpy)) * (1 - share)),
    toWorking, toRetired,
    deathsChildren: death(c.children, toWorking, cfg.childDeathPpm),
    deathsWorking: death(c.workingAge, toRetired, cfg.workingDeathPpm),
    deathsRetired: death(c.retired, 0, cfg.retiredDeathPpm),
  };
}

/** Advances the cohorts one cycle; returns the flows (so the households can be updated). */
export function advanceCohorts(d: Cohorts, unmetPpm: number, cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): CohortFlows {
  const f = cohortFlows(d, unmetPpm, cfg);
  const c = { ...d };
  d.children = c.children + f.births - f.toWorking - f.deathsChildren;
  d.workingAge = c.workingAge + f.toWorking - f.toRetired - f.deathsWorking;
  d.retired = c.retired + f.toRetired - f.deathsRetired;
  return f;
}

/**
 * Applies a cycle's births and deaths to the households: deaths in proportion to size, births in proportion to
 * size * (1 + food security), food security being 1 - the household's unmet share. Sizes stay integers and sum to the cohort total.
 */
export function advanceHouseholds(households: number[], births: number, deaths: number, loads: readonly HouseholdLoad[]): void {
  if (households.length === 0) return;
  const dead = allocate(deaths, households);
  const weights = households.map((s, i) => {
    const l = loads[i];
    const security = l && l.needed > 0 ? 10_000 - Math.floor((l.unmet * 10_000) / l.needed) : 10_000;
    return s * (10_000 + security);
  });
  const born = allocate(births, weights);
  for (let i = 0; i < households.length; i++) households[i] = households[i]! - dead[i]! + born[i]!;
}

/** One cycle of demographics for a dynamic planet: flows from the cohorts, then households, then the new unmet share. */
export function stepDemography(d: PlanetDemography, loads: readonly HouseholdLoad[], cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): CohortFlows | undefined {
  d.unmetPpm = unmetSharePpm(loads);
  if (!d.dynamic) return undefined;
  const f = advanceCohorts(d, d.unmetPpm, cfg);
  advanceHouseholds(d.households, f.births, f.deathsChildren + f.deathsWorking + f.deathsRetired, loads);
  return f;
}

/** Participation in bp: the base lowered by the unmet-needs share and by consumer confidence below neutral. Fixed at the base unless dynamic. */
export function participationBp(unmetPpm: number, consumerConfidence: number, dynamic: boolean, cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): number {
  if (!dynamic) return cfg.baseParticipationBp;
  const unmet = Math.round((cfg.baseParticipationBp * cfg.unmetParticipationPenaltyBp * Math.min(PPM, Math.max(0, unmetPpm))) / (10_000 * PPM));
  const conf = Math.max(0, cfg.confidenceNeutral - consumerConfidence) * cfg.confidencePenaltyBpPerPoint;
  return Math.max(0, cfg.baseParticipationBp - unmet - conf);
}

/** Labour input: working-age people x participation x hours, rounded to whole person-hours-equivalents. */
export function labourInput(c: Cohorts, participation: number, cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): number {
  return Math.round((c.workingAge * participation * cfg.hoursBp) / (PPM * 10_000 * 10_000));
}

export interface DemographyReading {
  population: number;
  children: number;
  workingAge: number;
  retired: number;
  dependencyRatioBp: number;
  participationBp: number;
  labourInput: number;
}

/** Whole-person reading of a planet's demography for metrics; `retired` is the remainder so the cohorts sum to `population`. */
export function readDemography(d: Cohorts, participation: number, cfg: DemographicsConfig = DEMOGRAPHICS_CONFIG): DemographyReading {
  const population = Math.round(totalPpm(d) / PPM);
  const children = Math.min(population, Math.round(d.children / PPM));
  const workingAge = Math.min(population - children, Math.round(d.workingAge / PPM));
  const retired = population - children - workingAge;
  return {
    population, children, workingAge, retired,
    dependencyRatioBp: workingAge > 0 ? Math.round(((children + retired) * 10_000) / workingAge) : 0,
    participationBp: participation,
    labourInput: labourInput(d, participation, cfg),
  };
}
