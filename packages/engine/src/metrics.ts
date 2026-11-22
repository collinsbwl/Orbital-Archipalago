import type { PlanetConfig, PlanetSnapshot, SurveyAnswer, WorldConfig } from '@orbital/contracts';
import type { TradeFlow } from './universe.js';

export type PlanetMetrics = PlanetSnapshot['metrics'];

export const INITIAL_CONFIDENCE = 50;
export const CPI_BASE = 10_000;

/** Price of a good on one planet: its last clearing price, else the base price. */
export type PriceFn = (good: string) => number;

const sum = (counts: Record<string, number>, price: PriceFn) => Object.entries(counts).reduce((s, [g, q]) => s + q * price(g), 0);

/** Value added of one cycle's production: output value minus input value, floored at 0. */
export const valueAdded = (produced: Record<string, number>, used: Record<string, number>, price: PriceFn): number =>
  Math.max(0, sum(produced, price) - sum(used, price));

/** Colonist-needs basket cost at current prices over its cost at base prices, x CPI_BASE, rounded. 10_000 with no needs. */
export function basketCpi(world: WorldConfig, price: PriceFn): number {
  const cost = (p: PriceFn) => world.colonistNeeds.reduce((s, n) => s + n.qty * p(n.good), 0);
  const base = cost((g) => world.goods.find((x) => x.id === g)!.basePrice);
  return base > 0 ? Math.round((cost(price) * CPI_BASE) / base) : CPI_BASE;
}

export const tradeBalance = (f: TradeFlow): number => f.exports - f.imports;

/** Rounded mean of this cycle's answers of `type`; `prev` carries forward when there are none. */
export function confidence(surveys: readonly SurveyAnswer[], type: SurveyAnswer['type'], prev: number): number {
  const xs = surveys.filter((s) => s.type === type);
  return xs.length ? Math.round(xs.reduce((s, x) => s + x.confidence, 0) / xs.length) : prev;
}

export interface MetricsInput {
  produced: Record<string, number>;
  used: Record<string, number>;
  price: PriceFn;
  flow: TradeFlow;
  /** Survey answers of agents acting on this planet this cycle. */
  surveys: readonly SurveyAnswer[];
  prev?: Pick<PlanetMetrics, 'consumerConfidence' | 'businessConfidence'>;
  /** Colonists living on the planet now (migration moves them); default: its configured colonist count. */
  population?: number;
}

export function computeMetrics(world: WorldConfig, planet: PlanetConfig, inp: MetricsInput): PlanetMetrics {
  return {
    gdp: valueAdded(inp.produced, inp.used, inp.price),
    cpi: basketCpi(world, inp.price),
    tradeBalance: tradeBalance(inp.flow),
    population: inp.population ?? planet.agents.colonist,
    consumerConfidence: confidence(inp.surveys, 'consumer', inp.prev?.consumerConfidence ?? INITIAL_CONFIDENCE),
    businessConfidence: confidence(inp.surveys, 'business', inp.prev?.businessConfidence ?? INITIAL_CONFIDENCE),
  };
}

