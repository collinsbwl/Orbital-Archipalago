// Small, pure economics helpers shared by the rule policies and the candidate
// generators. Integer math only (minor units, basis points).

import type { WorldConfig } from '@orbital/contracts';

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

export function applyBand(reference: number, bp: number): number {
  return Math.max(1, Math.floor((reference * (10_000 + bp)) / 10_000));
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
