import type { Snapshot } from '@orbital/contracts';

export interface PlanetMetricsRow {
  universeId: string;
  cycle: number;
  planet: string;
  gdp: number;
  cpi: number;
  tradeBalance: number;
  population: number;
  consumerConfidence: number;
  businessConfidence: number;
  realGdp: number;
  labourInput: number;
  capitalStock: number;
  realGdpGrowthBp: number;
  labourContribBp: number;
  capitalContribBp: number;
  tfpContribBp: number;
  children: number;
  workingAge: number;
  retired: number;
  dependencyRatioBp: number;
  participationBp: number;
}
export interface PriceRow { universeId: string; cycle: number; planet: string; good: string; price: number }
export interface FxRateRow { universeId: string; cycle: number; pair: string; ratePpm: number }
export interface GatewayCostRow { universeId: string; cycle: number; costUsd: number }

export interface CycleRows {
  planetMetrics: PlanetMetricsRow[];
  prices: PriceRow[];
  fxRates: FxRateRow[];
  gatewayCost: GatewayCostRow[];
}

/** Pure mapping from a snapshot to the rows we persist for that cycle. */
export function snapshotToRows(snapshot: Snapshot): CycleRows {
  const { universeId, cycle } = snapshot;
  const planetMetrics: PlanetMetricsRow[] = [];
  const prices: PriceRow[] = [];
  for (const p of snapshot.planets) {
    const m = p.metrics;
    planetMetrics.push({
      universeId, cycle, planet: p.planet,
      gdp: m.gdp, cpi: m.cpi, tradeBalance: m.tradeBalance, population: m.population,
      consumerConfidence: m.consumerConfidence, businessConfidence: m.businessConfidence,
      realGdp: m.realGdp, labourInput: m.labourInput, capitalStock: m.capitalStock,
      realGdpGrowthBp: m.realGdpGrowthBp, labourContribBp: m.labourContribBp, capitalContribBp: m.capitalContribBp, tfpContribBp: m.tfpContribBp,
      children: m.children, workingAge: m.workingAge, retired: m.retired, dependencyRatioBp: m.dependencyRatioBp, participationBp: m.participationBp,
    });
    for (const [good, price] of Object.entries(p.prices)) prices.push({ universeId, cycle, planet: p.planet, good, price });
  }
  const fxRates: FxRateRow[] = snapshot.fx.map((q) => ({ universeId, cycle, pair: `${q.base}/${q.quote}`, ratePpm: q.ratePpm }));
  return { planetMetrics, prices, fxRates, gatewayCost: [{ universeId, cycle, costUsd: snapshot.gatewayCostUsd }] };
}
