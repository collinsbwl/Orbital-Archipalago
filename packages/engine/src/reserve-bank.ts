/** Rule-based reserve bank (Taylor-style). All rates in integer basis points. */
export const RESERVE_BANK_CONFIG = {
  /** Policy is reset when `cycle % intervalCycles === 0` (and cycle > 0); inflation is measured over the same span. */
  intervalCycles: 5,
  neutralBp: 20,
  targetBp: 0,
  inflationWeight: 1.5,
  outputGapWeight: 0.5,
  minBp: 0,
  maxBp: 500,
  /** Output gap = GDP vs the mean of this many trailing cycles. */
  gdpWindow: 20,
};

export type ReserveBankConfig = typeof RESERVE_BANK_CONFIG;

/** CPI change over the span in bp of the earlier CPI (0 if the earlier CPI is not positive). */
export const inflationBp = (cpiNow: number, cpiEarlier: number): number =>
  cpiEarlier > 0 ? Math.round(((cpiNow - cpiEarlier) * 10_000) / cpiEarlier) : 0;

/** `gdpNow` vs the mean of `trailing` (the last cycles' GDP, including now) in bp; 0 if there is no history or mean. */
export function outputGapBp(gdpNow: number, trailing: readonly number[]): number {
  if (trailing.length === 0) return 0;
  const mean = trailing.reduce((s, x) => s + x, 0) / trailing.length;
  return mean > 0 ? Math.round(((gdpNow - mean) * 10_000) / mean) : 0;
}

/** rate = neutral + w_pi * (inflation - target) + w_y * gap, rounded to an integer and clamped to [min, max]. */
export function taylorRateBp(inflation: number, outputGap: number, cfg: ReserveBankConfig = RESERVE_BANK_CONFIG): number {
  const raw = cfg.neutralBp + cfg.inflationWeight * (inflation - cfg.targetBp) + cfg.outputGapWeight * outputGap;
  return Math.min(cfg.maxBp, Math.max(cfg.minBp, Math.round(raw)));
}
