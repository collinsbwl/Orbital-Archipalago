import type { PlanetSnapshot } from '@orbital/contracts';

const n = (v: number) => v.toLocaleString('en-US');

/** The name shown beside a planet: its id, capitalised ("helion" becomes "Helion"). */
export function planetTitle(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The few lines shown when you hover a planet: its currency and a quick read of its economy. */
export function planetDetails(p: PlanetSnapshot): string[] {
  return [p.currency, `GDP ${n(p.metrics.gdp)}`, `CPI ${(p.metrics.cpi / 100).toFixed(1)}`, `Population ${n(p.metrics.population)}`];
}
