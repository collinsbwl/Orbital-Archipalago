import type { ChartSeries, Snapshot, UniverseId } from '@orbital/contracts';
import type { MetricsSink, SeriesSource } from './ports.js';

export const MAX_SERIES_POINTS = 1_000;

/** Test/dev stand-in for Tiger's continuous aggregates: builds chart series from the snapshots written to it. */
export class InMemorySeries implements MetricsSink, SeriesSource {
  /** universe -> series key -> series (insertion order = first-seen order). */
  private readonly data = new Map<UniverseId, Map<string, ChartSeries>>();

  async writeCycle(s: Snapshot): Promise<void> {
    let all = this.data.get(s.universeId);
    if (!all) this.data.set(s.universeId, (all = new Map()));
    const add = (key: string, head: Omit<ChartSeries, 'points'>, value: number) => {
      let series = all.get(key);
      if (!series) all.set(key, (series = { ...head, points: [] }));
      const last = series.points[series.points.length - 1];
      if (last && last[0] >= s.cycle) series.points = series.points.filter((p) => p[0] < s.cycle); // re-written cycle (e.g. after a fork)
      series.points.push([s.cycle, value]);
      if (series.points.length > MAX_SERIES_POINTS) series.points.splice(0, series.points.length - MAX_SERIES_POINTS);
    };
    for (const p of s.planets) {
      add(`gdp|${p.planet}`, { metric: 'gdp', planet: p.planet }, p.metrics.gdp);
      add(`real_gdp|${p.planet}`, { metric: 'real_gdp', planet: p.planet }, p.metrics.realGdp);
      add(`cpi|${p.planet}`, { metric: 'cpi', planet: p.planet }, p.metrics.cpi);
      add(`trade_balance|${p.planet}`, { metric: 'trade_balance', planet: p.planet }, p.metrics.tradeBalance);
      for (const [good, price] of Object.entries(p.prices)) add(`price|${p.planet}|${good}`, { metric: 'price', planet: p.planet, good }, price);
    }
    for (const f of s.fx) add(`fx_rate|${f.base}/${f.quote}`, { metric: 'fx_rate', pair: `${f.base}/${f.quote}` }, f.ratePpm);
  }

  async readSeries(universeId: UniverseId): Promise<ChartSeries[]> {
    return [...(this.data.get(universeId)?.values() ?? [])].map((x) => ({ ...x, points: [...x.points] }));
  }
}
