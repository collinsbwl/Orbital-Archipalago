// Small, pure economics helpers shared by the rule policies and the candidate
// generators. Integer math only (minor units, basis points).

import type { AgentTask, WorldConfig } from '@orbital/contracts';
import { RATE_SCALE } from '@orbital/contracts';

type FxView = AgentTask['observation']['fx'][number];

export function baseOf(world: WorldConfig, good: string): number | null {
  const g = world.goods.find((x) => x.id === good);
  return g ? g.basePrice : null;
}

export function producedGoods(world: WorldConfig, planet: string): string[] {
  const p = world.planets.find((x) => x.id === planet);
  if (!p) return [];
  const outputs = new Set<string>();
  for (const pr of p.recipes) {
    const recipe = world.recipes.find((r) => r.id === pr.recipe);
    if (recipe) outputs.add(recipe.output.good);
  }
  return [...outputs];
}

/**
 * `reference` moved by `bp` basis points, floored to whole units (min 1). A non-zero band always moves the price by at
 * least one unit: flooring alone would turn +1% on a price under 100 into +0, and prices could never creep up.
 */
export function applyBand(reference: number, bp: number): number {
  const moved = Math.floor((reference * (10_000 + bp)) / 10_000);
  return Math.max(1, bp > 0 ? Math.max(moved, reference + 1) : moved);
}

export function confidenceFromTrend(trend: number[]): number {
  if (trend.length < 2) return 50;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  if (first === 0) return 50;
  const changeBp = Math.floor(((last - first) * 10_000) / first);
  // Falling prices raise consumer confidence; cap to [0, 100].
  return Math.max(0, Math.min(100, 50 - Math.floor(changeBp / 100)));
}

/** ppm rate quoting `quote` per `base` from the last clearing FX views; inverts the pair if needed. Null if unknown. */
export function fxRatePpm(fx: readonly FxView[], base: string, quote: string): number | null {
  if (base === quote) return RATE_SCALE;
  const direct = fx.find((f) => f.base === base && f.quote === quote);
  if (direct?.lastRatePpm) return direct.lastRatePpm;
  const inverse = fx.find((f) => f.base === quote && f.quote === base);
  if (inverse?.lastRatePpm) return Math.floor((RATE_SCALE * RATE_SCALE) / inverse.lastRatePpm);
  return null;
}

/** Convert an amount of `from` minor units into `to` minor units at the last FX rate. Null if unknown. */
export function convert(fx: readonly FxView[], amount: number, from: string, to: string): number | null {
  const rate = fxRatePpm(fx, from, to);
  return rate === null ? null : Math.floor((amount * rate) / RATE_SCALE);
}

export function currencyOf(world: WorldConfig, planet: string): string {
  return world.planets.find((p) => p.id === planet)?.currency ?? '';
}
