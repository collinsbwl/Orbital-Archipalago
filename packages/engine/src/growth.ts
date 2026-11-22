import type { WorldConfig } from '@orbital/contracts';
import { valueAdded } from './metrics.js';
import type { PriceFn } from './metrics.js';
import { RESERVE_BANK_CONFIG } from './reserve-bank.js';

/**
 * Growth accounting: g_Y = g_A + alpha * g_K + (1 - alpha) * g_L, TFP (g_A) being the residual.
 * Measurement only: nothing in the simulation reads these numbers.
 */
export const GROWTH_CONFIG = {
  /** The produced-but-never-consumed good that stands in for physical capital (Tethys `forge_tools`). */
  capitalGood: 'tools',
  /** Capital share alpha in basis points (30%). */
  capitalShareBp: 3_000,
  /** Growth is measured between two means this many cycles apart. */
  windowCycles: 50,
  /** Each mean is taken over this many cycles, to damp cycle-to-cycle noise. */
  smoothCycles: 10,
  cyclesPerYear: RESERVE_BANK_CONFIG.cyclesPerYear,
  /** Installed capital every planet starts with, in units of the capital good; the scale against which stock K is read. */
  baseCapital: 100,
  /** Share of the planet's capital stock that wears out each cycle, in ppm (15_000 = 1.5%, applied to both held tools and installed capital). */
  depreciationPpm: 15_000,
  /**
   * Share of real GDP saved and invested each cycle, in bp (Solow). Steady state K* = s * Y / (delta * p), p being the base price
   * of the capital good. Simplification: investment is not yet funded from consumption or the treasury; it is created from
   * nothing, so it does not move any balance.
   */
  savingsRateBp: 500,
  /** When false, capital neither raises production nor wears out (Phase 1 behaviour: measurement only). */
  capitalAffectsProduction: true,
};

/** How many earlier cycles `computeMetrics` wants in `trail` (the current cycle makes up the rest). */
export const GROWTH_TRAIL = GROWTH_CONFIG.windowCycles + GROWTH_CONFIG.smoothCycles - 1;

export type GrowthConfig = typeof GROWTH_CONFIG;

export interface GrowthBp {
  realGdpGrowthBp: number;
  labourContribBp: number;
  capitalContribBp: number;
  tfpContribBp: number;
}

export const ZERO_GROWTH: GrowthBp = { realGdpGrowthBp: 0, labourContribBp: 0, capitalContribBp: 0, tfpContribBp: 0 };

const PPM = 1_000_000;

/** Production multiplier ((baseCapital + K) / baseCapital)^alpha as integer ppm. K = 0 gives exactly 1_000_000. */
export function capacityMultiplierPpm(capital: number, cfg: GrowthConfig = GROWTH_CONFIG): number {
  if (!cfg.capitalAffectsProduction || !(capital > 0) || !(cfg.baseCapital > 0)) return PPM;
  return Math.round(Math.pow((cfg.baseCapital + capital) / cfg.baseCapital, cfg.capitalShareBp / 10_000) * PPM);
}

/**
 * Whole batches to run this cycle: floor(base * m + carry), the fractional remainder (ppm) carried to the next cycle.
 * Integer ppm math, so a multiplier of exactly 1 never creates or loses a batch.
 */
export function scaleBatches(base: number, multiplierPpm: number, carryPpm: number): { batches: number; carryPpm: number } {
  const total = base * multiplierPpm + carryPpm;
  const batches = Math.floor(total / PPM);
  return { batches, carryPpm: total - batches * PPM };
}

/** Wear on a stock of `capital` units: accrue capital * depreciationPpm, release whole units, keep the remainder (ppm). */
export function accrueWear(capital: number, accPpm: number, cfg: GrowthConfig = GROWTH_CONFIG): { units: number; accPpm: number } {
  const total = accPpm + Math.max(0, capital) * cfg.depreciationPpm;
  const units = Math.min(Math.floor(total / PPM), Math.max(0, capital));
  return { units, accPpm: total - units * PPM };
}

/** Investment in ppm tool-equivalents: savingsRateBp/10_000 * realGdp / basePrice(capitalGood), rounded; 0 for a non-positive input. */
export function investmentPpm(realGdpValue: number, capitalBasePrice: number, cfg: GrowthConfig = GROWTH_CONFIG): number {
  if (!cfg.capitalAffectsProduction || !(realGdpValue > 0) || !(capitalBasePrice > 0)) return 0;
  return Math.round((cfg.savingsRateBp * realGdpValue * PPM) / (10_000 * capitalBasePrice));
}

/** One cycle of Solow accumulation on the installed stock (ppm): add investment, then depreciate by `depreciationPpm`. */
export function accumulateInstalledPpm(installedPpm: number, investment: number, cfg: GrowthConfig = GROWTH_CONFIG): number {
  const grown = Math.max(0, installedPpm) + Math.max(0, investment);
  return grown - Math.round((grown * cfg.depreciationPpm) / PPM);
}

/** Real GDP: one cycle's value added at the world's base prices, so price movements do not count as growth. */
export const realGdp = (produced: Record<string, number>, used: Record<string, number>, world: WorldConfig): number => {
  const base: PriceFn = (g) => world.goods.find((x) => x.id === g)?.basePrice ?? 0;
  return valueAdded(produced, used, base);
};

/** Annualised log growth from `then` to `now` (`windowCycles` apart) in integer bp; 0 if either level is not positive. */
export function growthBp(now: number, then: number, windowCycles: number, cyclesPerYear: number): number {
  if (!(now > 0) || !(then > 0) || windowCycles <= 0) return 0;
  return Math.round(Math.log(now / then) * (cyclesPerYear / windowCycles) * 10_000);
}

export interface GrowthSeries {
  /** Oldest first, ending at the current cycle. */
  realGdp: readonly number[];
  labour: readonly number[];
  capital: readonly number[];
}

const meanOf = (xs: readonly number[], end: number, len: number): number => {
  let s = 0;
  for (let i = end - len; i < end; i++) s += xs[i]!;
  return s / len;
};

/**
 * Growth of the mean over the last `smoothCycles` vs the mean over the same-length span `windowCycles` earlier.
 * All zeros until `windowCycles + smoothCycles` cycles exist. The capital and labour terms are rounded; TFP is the
 * remainder, so the three contributions sum exactly to `realGdpGrowthBp`.
 */
export function decompose(s: GrowthSeries, cfg: GrowthConfig = GROWTH_CONFIG): GrowthBp {
  const { windowCycles: w, smoothCycles: m, cyclesPerYear: cpy, capitalShareBp } = cfg;
  const n = Math.min(s.realGdp.length, s.labour.length, s.capital.length);
  if (n < w + m) return { ...ZERO_GROWTH };
  const g = (xs: readonly number[]) => growthBp(meanOf(xs, n, m), meanOf(xs, n - w, m), w, cpy);
  const gY = g(s.realGdp);
  const capitalContribBp = Math.round((g(s.capital) * capitalShareBp) / 10_000);
  const labourContribBp = Math.round((g(s.labour) * (10_000 - capitalShareBp)) / 10_000);
  return { realGdpGrowthBp: gY, labourContribBp, capitalContribBp, tfpContribBp: gY - capitalContribBp - labourContribBp };
}
