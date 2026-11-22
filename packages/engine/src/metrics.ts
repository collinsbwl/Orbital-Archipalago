import type { PlanetConfig, PlanetSnapshot, SurveyAnswer, WorldConfig } from '@orbital/contracts';
import { DEMOGRAPHICS_CONFIG } from './demographics.js';
import type { DemographyReading } from './demographics.js';
import { decompose, realGdp } from './growth.js';
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
  /** Total holdings of the capital good on this planet, read after production and consumption. */
  capitalStock?: number;
  /** This planet's earlier metrics, oldest first, excluding this cycle (only the last window + smoothing span is needed). */
  trail?: readonly Pick<PlanetMetrics, 'realGdp' | 'labourInput' | 'capitalStock'>[];
  /** Cohorts, participation and labour of this cycle; absent = all colonists working-age at the base participation. */
  demography?: DemographyReading;
  /** People who left and arrived this cycle (whole people); absent = none. */
  migration?: { emigrants: number; immigrants: number };
}

/** The reading of a planet with no demography state: every colonist is a working-age person. */
export function defaultDemography(planet: PlanetConfig): DemographyReading {
  const n = planet.agents.colonist;
  const participationBp = DEMOGRAPHICS_CONFIG.baseParticipationBp;
  return { population: n, children: 0, workingAge: n, retired: 0, dependencyRatioBp: 0, participationBp, labourInput: Math.round((n * participationBp * DEMOGRAPHICS_CONFIG.hoursBp) / 100_000_000) };
}


export function computeMetrics(world: WorldConfig, planet: PlanetConfig, inp: MetricsInput): PlanetMetrics {
  const rgdp = realGdp(inp.produced, inp.used, world);
  const demo = inp.demography ?? defaultDemography(planet);
  const labourInput = demo.labourInput;
  const capitalStock = inp.capitalStock ?? 0;
  const trail = inp.trail ?? [];
  const growth = decompose({
    realGdp: [...trail.map((t) => t.realGdp), rgdp],
    labour: [...trail.map((t) => t.labourInput), labourInput],
    capital: [...trail.map((t) => t.capitalStock), capitalStock],
  });
  return {
    gdp: valueAdded(inp.produced, inp.used, inp.price),
    cpi: basketCpi(world, inp.price),
    tradeBalance: tradeBalance(inp.flow),
    population: demo.population,
    consumerConfidence: confidence(inp.surveys, 'consumer', inp.prev?.consumerConfidence ?? INITIAL_CONFIDENCE),
    businessConfidence: confidence(inp.surveys, 'business', inp.prev?.businessConfidence ?? INITIAL_CONFIDENCE),
    realGdp: rgdp,
    labourInput,
    capitalStock,
    ...growth,
    children: demo.children,
    workingAge: demo.workingAge,
    retired: demo.retired,
    dependencyRatioBp: demo.dependencyRatioBp,
    participationBp: demo.participationBp,
    netMigration: (inp.migration?.immigrants ?? 0) - (inp.migration?.emigrants ?? 0),
    emigrants: inp.migration?.emigrants ?? 0,
    immigrants: inp.migration?.immigrants ?? 0,
  };
}

