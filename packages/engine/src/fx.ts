import type { CurrencyId, Observation, WorldConfig } from '@orbital/contracts';

export type FxView = Observation['fx'][number];

export const fxKey = (base: CurrencyId, quote: CurrencyId) => `${base}/${quote}`;

/** Every currency pair once, canonical: base is the currency of the planet listed earlier in `world.planets`. */
export function fxPairs(world: WorldConfig): { base: CurrencyId; quote: CurrencyId }[] {
  const out: { base: CurrencyId; quote: CurrencyId }[] = [];
  world.planets.forEach((a, i) => {
    for (const b of world.planets.slice(i + 1)) out.push({ base: a.currency, quote: b.currency });
  });
  return out;
}

/** Observation view of all pairs (the schema allows at most 6); `rates` holds the last non-null clearing rate per pair. */
export function fxViews(world: WorldConfig, rates: ReadonlyMap<string, number>): FxView[] {
  return fxPairs(world).slice(0, 6).map((p) => ({ ...p, lastRatePpm: rates.get(fxKey(p.base, p.quote)) ?? null }));
}
