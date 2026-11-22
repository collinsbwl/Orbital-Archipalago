import pg from 'pg';
import type { ChartSeries, GodModeCommand, Snapshot, UniverseId } from '@orbital/contracts';
import type { MetricsSink, SeriesSource } from '../ports.js';
import { migrate } from './schema.js';
import { snapshotToRows } from './rows.js';

/** Max points per series (matches `ChartSeriesSchema`). */
const MAX_POINTS = 1_000;
/** Postgres allows 65535 bind parameters per statement; stay well below it. */
const MAX_PARAMS = 30_000;

export interface GodModeAuditEntry {
  universeId: UniverseId;
  cycle: number;
  sub: string;
  command: GodModeCommand;
  ok: boolean;
  error?: string;
}

/** TimescaleDB-backed metrics sink and chart-series source. */
export class TigerStore implements MetricsSink, SeriesSource {
  constructor(private readonly pool: pg.Pool) {}

  /** Build a store from a connection string (default: `TIGER_DATABASE_URL`). */
  static fromUrl(url: string | undefined = process.env.TIGER_DATABASE_URL): TigerStore {
    if (!url) throw new Error('TIGER_DATABASE_URL is not set');
    // Managed providers (Tiger Cloud) use CAs Node doesn't trust by default. `pg` 8.x
    // aliases `sslmode=require` to `verify-full` AND its URL parser overrides our `ssl`
    // option. Strip the param and pass an explicit TLS-without-verify config.
    const sslRe = /[?&]sslmode=(require|verify-ca|verify-full|prefer)\b/i;
    const useSsl = sslRe.test(url);
    const cleanUrl = useSsl ? url.replace(sslRe, (m) => (m.startsWith('?') ? '?' : '&')).replace(/[?&]$/, '') : url;
    return new TigerStore(
      new pg.Pool({
        connectionString: cleanUrl,
        ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      }),
    );
  }

  migrate(): Promise<void> {
    return migrate(this.pool);
  }

  async registerUniverse(id: UniverseId, name: string, seed: number, config: unknown): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO universes (id, name, seed) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, seed = EXCLUDED.seed`,
        [id, name, seed],
      );
      await client.query(
        `INSERT INTO world_configs (universe_id, config) VALUES ($1, $2::jsonb)
         ON CONFLICT (universe_id) DO UPDATE SET config = EXCLUDED.config`,
        [id, JSON.stringify(config)],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async writeCycle(snapshot: Snapshot): Promise<void> {
    const rows = snapshotToRows(snapshot);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await insertMany(client, 'planet_metrics',
        ['universe_id', 'cycle', 'planet', 'gdp', 'cpi', 'trade_balance', 'population', 'consumer_confidence', 'business_confidence',
          'real_gdp', 'labour_input', 'capital_stock', 'real_gdp_growth_bp', 'labour_contrib_bp', 'capital_contrib_bp', 'tfp_contrib_bp',
          'children', 'working_age', 'retired', 'dependency_ratio_bp', 'participation_bp',
          'net_migration', 'emigrants', 'immigrants'],
        rows.planetMetrics.map((r) => [r.universeId, r.cycle, r.planet, r.gdp, r.cpi, r.tradeBalance, r.population, r.consumerConfidence, r.businessConfidence,
          r.realGdp, r.labourInput, r.capitalStock, r.realGdpGrowthBp, r.labourContribBp, r.capitalContribBp, r.tfpContribBp,
          r.children, r.workingAge, r.retired, r.dependencyRatioBp, r.participationBp, r.netMigration, r.emigrants, r.immigrants]));
      await insertMany(client, 'prices', ['universe_id', 'cycle', 'planet', 'good', 'price'],
        rows.prices.map((r) => [r.universeId, r.cycle, r.planet, r.good, r.price]));
      await insertMany(client, 'fx_rates', ['universe_id', 'cycle', 'pair', 'rate_ppm'],
        rows.fxRates.map((r) => [r.universeId, r.cycle, r.pair, r.ratePpm]));
      await insertMany(client, 'gateway_cost', ['universe_id', 'cycle', 'cost_usd'],
        rows.gatewayCost.map((r) => [r.universeId, r.cycle, r.costUsd]));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Force-materialise the continuous aggregates (the refresh policy does this on a schedule). */
  async refreshAggregates(): Promise<void> {
    for (const view of ['planet_metrics_5', 'planet_metrics_growth_5', 'prices_5', 'fx_rates_5']) {
      await this.pool.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
    }
  }

  async readSeries(universeId: UniverseId): Promise<ChartSeries[]> {
    const out: ChartSeries[] = [];

    const metrics = await this.pool.query(
      `SELECT planet, bucket, gdp_avg::float8 AS gdp, cpi_last::float8 AS cpi, trade_balance_sum::float8 AS trade_balance
       FROM (SELECT *, row_number() OVER (PARTITION BY planet ORDER BY bucket DESC) AS rn
             FROM planet_metrics_5 WHERE universe_id = $1) t
       WHERE rn <= $2 ORDER BY planet, bucket ASC`,
      [universeId, MAX_POINTS],
    );
    const byPlanet = groupRows(metrics.rows, (r) => r.planet);
    for (const [metric, col] of [['gdp', 'gdp'], ['cpi', 'cpi'], ['trade_balance', 'trade_balance']] as const) {
      for (const [planet, rs] of byPlanet) {
        out.push({ metric, planet, points: rs.map((r) => [Number(r.bucket), Math.round(Number(r[col]))]) });
      }
    }

    const growth = await this.pool.query(
      `SELECT planet, bucket, real_gdp_avg::float8 AS real_gdp
       FROM (SELECT *, row_number() OVER (PARTITION BY planet ORDER BY bucket DESC) AS rn
             FROM planet_metrics_growth_5 WHERE universe_id = $1) t
       WHERE rn <= $2 ORDER BY planet, bucket ASC`,
      [universeId, MAX_POINTS],
    );
    for (const [planet, rs] of groupRows(growth.rows, (r) => r.planet)) {
      out.push({ metric: 'real_gdp', planet, points: rs.map((r) => [Number(r.bucket), Math.round(Number(r.real_gdp))]) });
    }

    const prices = await this.pool.query(
      `SELECT planet, good, bucket, price_last::float8 AS price
       FROM (SELECT *, row_number() OVER (PARTITION BY planet, good ORDER BY bucket DESC) AS rn
             FROM prices_5 WHERE universe_id = $1) t
       WHERE rn <= $2 ORDER BY planet, good, bucket ASC`,
      [universeId, MAX_POINTS],
    );
    for (const [key, rs] of groupRows(prices.rows, (r) => `${r.planet}\u0000${r.good}`)) {
      const [planet, good] = key.split('\u0000') as [string, string];
      out.push({ metric: 'price', planet, good, points: rs.map((r) => [Number(r.bucket), Math.round(Number(r.price))]) });
    }

    const fx = await this.pool.query(
      `SELECT pair, bucket, rate_ppm_last::float8 AS rate_ppm
       FROM (SELECT *, row_number() OVER (PARTITION BY pair ORDER BY bucket DESC) AS rn
             FROM fx_rates_5 WHERE universe_id = $1) t
       WHERE rn <= $2 ORDER BY pair, bucket ASC`,
      [universeId, MAX_POINTS],
    );
    for (const [pair, rs] of groupRows(fx.rows, (r) => r.pair)) {
      out.push({ metric: 'fx_rate', pair, points: rs.map((r) => [Number(r.bucket), Math.round(Number(r.rate_ppm))]) });
    }
    return out;
  }

  async recordGodModeAudit(entry: GodModeAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO god_mode_audit (universe_id, cycle, auth0_sub, command, ok, error)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [entry.universeId, entry.cycle, entry.sub, JSON.stringify(entry.command), entry.ok, entry.error ?? null],
    );
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

type Row = Record<string, unknown> & { bucket: unknown };

function groupRows(rows: Row[], key: (r: any) => string): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Multi-row `INSERT ... ON CONFLICT DO NOTHING`, chunked under the bind-parameter limit. */
async function insertMany(client: pg.PoolClient, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`);
    await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params);
  }
}
