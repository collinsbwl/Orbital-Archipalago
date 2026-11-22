import type { Pool } from 'pg';

/** Cycles per hypertable chunk. */
export const CHUNK_CYCLES = 1000;
/** Continuous-aggregate bucket width, in cycles. */
export const BUCKET_CYCLES = 5;
/** Chunks older than this many cycles behind "now" are compressed. */
export const COMPRESS_AFTER_CYCLES = 1000;

interface HyperSpec {
  table: string;
  columns: string;
  /** Unique key; must include `cycle` (the partitioning column). */
  primaryKey: string;
  segmentBy: string;
}

const HYPERTABLES: HyperSpec[] = [
  {
    table: 'planet_metrics',
    columns: `universe_id text NOT NULL,
      cycle integer NOT NULL,
      planet text NOT NULL,
      gdp bigint NOT NULL,
      cpi integer NOT NULL,
      trade_balance bigint NOT NULL,
      population integer NOT NULL,
      consumer_confidence integer NOT NULL,
      business_confidence integer NOT NULL`,
    primaryKey: 'universe_id, cycle, planet',
    segmentBy: 'universe_id, planet',
  },
  {
    table: 'prices',
    columns: `universe_id text NOT NULL,
      cycle integer NOT NULL,
      planet text NOT NULL,
      good text NOT NULL,
      price bigint NOT NULL`,
    primaryKey: 'universe_id, cycle, planet, good',
    segmentBy: 'universe_id, planet, good',
  },
  {
    table: 'fx_rates',
    columns: `universe_id text NOT NULL,
      cycle integer NOT NULL,
      pair text NOT NULL,
      rate_ppm bigint NOT NULL`,
    primaryKey: 'universe_id, cycle, pair',
    segmentBy: 'universe_id, pair',
  },
  {
    table: 'gateway_cost',
    columns: `universe_id text NOT NULL,
      cycle integer NOT NULL,
      cost_usd double precision NOT NULL`,
    primaryKey: 'universe_id, cycle',
    segmentBy: 'universe_id',
  },
  {
    // One row per agent per cycle: what it saw, what it chose and why (raw, before engine validation).
    table: 'agent_decisions',
    columns: `universe_id text NOT NULL,
      cycle integer NOT NULL,
      agent_id text NOT NULL,
      role text NOT NULL,
      planet text NOT NULL,
      source text NOT NULL,
      reason text NOT NULL,
      memo text,
      actions jsonb NOT NULL,
      survey jsonb,
      observation jsonb NOT NULL,
      model text,
      input_tokens integer,
      cached_tokens integer,
      output_tokens integer,
      cost_usd double precision,
      latency_ms double precision`,
    primaryKey: 'universe_id, cycle, agent_id',
    segmentBy: 'universe_id, role',
  },
];

function hypertableStatements(h: HyperSpec): string[] {
  const nowFn = `orbital_now_${h.table}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${h.table} (
      ${h.columns},
      PRIMARY KEY (${h.primaryKey})
    )`,
    `SELECT create_hypertable('${h.table}', by_range('cycle', ${CHUNK_CYCLES}), if_not_exists => TRUE)`,
    // Integer time dimensions have no wall clock: tell Timescale what "now" means (latest cycle written).
    `CREATE OR REPLACE FUNCTION ${nowFn}() RETURNS integer LANGUAGE sql STABLE AS
      $$ SELECT coalesce(max(cycle), 0)::integer FROM ${h.table} $$`,
    `SELECT set_integer_now_func('${h.table}', '${nowFn}', replace_if_exists => TRUE)`,
    // Guarded: re-running ALTER ... SET (timescaledb.compress) errors once chunks are compressed.
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                     WHERE hypertable_name = '${h.table}' AND compression_enabled) THEN
        ALTER TABLE ${h.table} SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = '${h.segmentBy}',
          timescaledb.compress_orderby = 'cycle DESC'
        );
      END IF;
    END $$`,
    `SELECT add_compression_policy('${h.table}', compress_after => ${COMPRESS_AFTER_CYCLES}, if_not_exists => TRUE)`,
  ];
}

interface CaggSpec {
  view: string;
  source: string;
  select: string;
  groupBy: string;
}

export const CAGGS: CaggSpec[] = [
  {
    view: 'planet_metrics_5',
    source: 'planet_metrics',
    select: `universe_id, planet, time_bucket(${BUCKET_CYCLES}, cycle) AS bucket,
      avg(gdp) AS gdp_avg,
      last(cpi, cycle) AS cpi_last,
      sum(trade_balance) AS trade_balance_sum`,
    groupBy: 'universe_id, planet, bucket',
  },
  {
    view: 'prices_5',
    source: 'prices',
    select: `universe_id, planet, good, time_bucket(${BUCKET_CYCLES}, cycle) AS bucket,
      last(price, cycle) AS price_last`,
    groupBy: 'universe_id, planet, good, bucket',
  },
  {
    view: 'fx_rates_5',
    source: 'fx_rates',
    select: `universe_id, pair, time_bucket(${BUCKET_CYCLES}, cycle) AS bucket,
      last(rate_ppm, cycle) AS rate_ppm_last`,
    groupBy: 'universe_id, pair, bucket',
  },
];

function caggStatements(c: CaggSpec): string[] {
  return [
    // materialized_only = false: real-time aggregation, so unmaterialized recent cycles are still charted.
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${c.view}
      WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
      SELECT ${c.select}
      FROM ${c.source}
      GROUP BY ${c.groupBy}
      WITH NO DATA`,
    `SELECT add_continuous_aggregate_policy('${c.view}',
      start_offset => 100000, end_offset => ${BUCKET_CYCLES}, schedule_interval => INTERVAL '30 seconds',
      if_not_exists => TRUE)`,
  ];
}

/**
 * Idempotent migration, one statement per entry. Run them one at a time and outside a transaction:
 * CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) cannot run in a transaction block.
 */
export const MIGRATIONS: string[] = [
  'CREATE EXTENSION IF NOT EXISTS timescaledb',
  `CREATE TABLE IF NOT EXISTS universes (
    id text PRIMARY KEY,
    name text NOT NULL,
    seed bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS world_configs (
    universe_id text PRIMARY KEY REFERENCES universes(id) ON DELETE CASCADE,
    config jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS god_mode_audit (
    id bigserial PRIMARY KEY,
    universe_id text NOT NULL,
    cycle integer NOT NULL,
    auth0_sub text NOT NULL,
    command jsonb NOT NULL,
    ok boolean NOT NULL,
    error text,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  ...HYPERTABLES.flatMap(hypertableStatements),
  ...CAGGS.flatMap(caggStatements),
];

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Serialise concurrent migrators (e.g. several engine processes booting together).
    await client.query('SELECT pg_advisory_lock(727274)');
    try {
      for (const sql of MIGRATIONS) await client.query(sql);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)');
    }
  } finally {
    client.release();
  }
}
