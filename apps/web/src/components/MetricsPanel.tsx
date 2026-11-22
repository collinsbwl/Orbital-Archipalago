import type { ChartSeries, Snapshot } from '@orbital/contracts';
import { Sparkline } from './Sparkline';

const n = (v: number) => v.toLocaleString('en-US');

/** Annualised growth in bp as a signed percentage per year. */
const growthPct = (bp: number) => `${bp > 0 ? '+' : ''}${(bp / 100).toFixed(1)}%/yr`;

function Chart({ title, series }: { title: string; series: ChartSeries | undefined }) {
  const last = series?.points[series.points.length - 1];
  return (
    <div className="chart">
      <div className="muted">{title}{last ? `: ${n(last[1])}` : ''}</div>
      <Sparkline points={series?.points ?? []} label={title} />
    </div>
  );
}

export function MetricsPanel({ snapshot }: { snapshot: Snapshot }) {
  const find = (metric: ChartSeries['metric'], planet: string) => snapshot.series.find((s) => s.metric === metric && s.planet === planet);
  return (
    <section>
      <h2>Planets</h2>
      <table>
        <thead>
          <tr><th>Planet</th><th>Pop (C/W/R)</th><th>GDP</th><th>Real GDP</th><th>Growth</th><th>CPI</th><th>Trade bal.</th><th>Rate</th><th>Cons. conf.</th><th>Biz conf.</th><th>Prices</th></tr>
        </thead>
        <tbody>
          {snapshot.planets.map((p) => (
            <tr key={p.planet}>
              <td>{p.planet} <span className="muted">{p.currency}</span></td>
              <td>{n(p.metrics.population)} <span className="muted">({p.metrics.children}/{p.metrics.workingAge}/{p.metrics.retired})</span></td>
              <td>{n(p.metrics.gdp)}</td>
              <td>{n(p.metrics.realGdp)}</td>
              <td>{growthPct(p.metrics.realGdpGrowthBp)}</td>
              <td>{(p.metrics.cpi / 100).toFixed(1)}</td>
              <td>{n(p.metrics.tradeBalance)}</td>
              <td>{(p.policy.policyRateBp / 100).toFixed(2)}%</td>
              <td>{p.metrics.consumerConfidence}</td>
              <td>{p.metrics.businessConfidence}</td>
              <td>{Object.entries(p.prices).map(([g, v]) => `${g} ${n(v)}`).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Charts</h2>
      <div className="charts">
        {snapshot.planets.map((p) => (
          <div key={p.planet} className="chart-group">
            <strong>{p.planet}</strong>
            <Chart title="GDP" series={find('gdp', p.planet)} />
            <Chart title="Real GDP" series={find('real_gdp', p.planet)} />
            <Chart title="CPI" series={find('cpi', p.planet)} />
            <Chart title="Trade balance" series={find('trade_balance', p.planet)} />
          </div>
        ))}
        <div className="chart-group">
          <strong>FX (ppm)</strong>
          {snapshot.series.filter((s) => s.metric === 'fx_rate').map((s) => <Chart key={s.pair} title={s.pair ?? 'fx'} series={s} />)}
        </div>
      </div>
    </section>
  );
}
