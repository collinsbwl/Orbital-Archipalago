import type { ChartSeries, Snapshot } from '@orbital/contracts';
import { Tick, type Better } from './motion';
import { Sparkline } from './Sparkline';

const n = (v: number) => v.toLocaleString('en-US');

function Chart({ title, series, better }: { title: string; series: ChartSeries | undefined; better: Better }) {
  const last = series?.points[series.points.length - 1];
  return (
    <div className="chart">
      <div className="muted">{title}{last && <>: <Tick value={last[1]} better={better}>{n(last[1])}</Tick></>}</div>
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
          <tr><th>Planet</th><th>GDP</th><th>CPI</th><th>Trade bal.</th><th>Rate</th><th>Cons. conf.</th><th>Biz conf.</th><th>Prices</th></tr>
        </thead>
        <tbody>
          {snapshot.planets.map((p) => (
            <tr key={p.planet}>
              <td>{p.planet} <span className="muted">{p.currency}</span></td>
              <td><Tick value={p.metrics.gdp} better="up">{n(p.metrics.gdp)}</Tick></td>
              <td><Tick value={p.metrics.cpi} better="down">{(p.metrics.cpi / 100).toFixed(1)}</Tick></td>
              <td><Tick value={p.metrics.tradeBalance} better="up">{n(p.metrics.tradeBalance)}</Tick></td>
              <td><Tick value={p.policy.policyRateBp} better="none">{(p.policy.policyRateBp / 100).toFixed(2)}%</Tick></td>
              <td><Tick value={p.metrics.consumerConfidence} better="up">{p.metrics.consumerConfidence}</Tick></td>
              <td><Tick value={p.metrics.businessConfidence} better="up">{p.metrics.businessConfidence}</Tick></td>
              <td>{Object.entries(p.prices).map(([g, v], i) => (
                <span key={g}>{i > 0 && ', '}{g} <Tick value={v} better="none">{n(v)}</Tick></span>
              ))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Charts</h2>
      <div className="charts">
        {snapshot.planets.map((p) => (
          <div key={p.planet} className="chart-group">
            <strong>{p.planet}</strong>
            <Chart title="GDP" series={find('gdp', p.planet)} better="up" />
            <Chart title="CPI" series={find('cpi', p.planet)} better="down" />
            <Chart title="Trade balance" series={find('trade_balance', p.planet)} better="up" />
          </div>
        ))}
        <div className="chart-group">
          <strong>FX (ppm)</strong>
          {snapshot.series.filter((s) => s.metric === 'fx_rate').map((s) => <Chart key={s.pair} title={s.pair ?? 'fx'} series={s} better="none" />)}
        </div>
      </div>
    </section>
  );
}
