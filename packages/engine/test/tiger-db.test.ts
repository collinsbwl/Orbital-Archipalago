import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChartSeriesSchema, SnapshotSchema } from '@orbital/contracts';
import type { Snapshot } from '@orbital/contracts';
import { TigerStore } from '../src/tiger/tiger-store.js';

const url = process.env.TIGER_DATABASE_URL;
const policy = { tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 200 };

function snap(universeId: string, cycle: number): Snapshot {
  return SnapshotSchema.parse({
    universeId, cycle, paused: false,
    planets: [
      { planet: 'helion', currency: 'HEL', prices: { iron: 100 + cycle }, policy,
        metrics: { gdp: 1_000 + cycle, cpi: 10_000 + cycle, tradeBalance: cycle % 2 === 0 ? 10 : -4, population: 500, consumerConfidence: 60, businessConfidence: 55 },
        orbitPhaseCycles: 0 },
      { planet: 'vesta', currency: 'VES', prices: { iron: 90 }, policy,
        metrics: { gdp: 2_000, cpi: 9_900, tradeBalance: 40, population: 800, consumerConfidence: 70, businessConfidence: 65 },
        orbitPhaseCycles: 0 },
    ],
    fx: [{ base: 'HEL', quote: 'VES', ratePpm: 1_000_000 + cycle }],
    shipments: [], events: [], series: [], gatewayCostUsd: cycle * 0.01,
  });
}

describe.skipIf(!url)('TigerStore (TimescaleDB integration)', () => {
  const universeId = `t${Date.now().toString(36)}`;
  let store: TigerStore;

  beforeAll(async () => {
    store = TigerStore.fromUrl(url);
    await store.migrate();
    await store.migrate(); // idempotent
  }, 120_000);

  afterAll(async () => {
    await store?.close();
  });

  it('registers a universe (twice) and writes 30 cycles idempotently', async () => {
    await store.registerUniverse(universeId, 'Test', 7, { name: 'Test', seed: 7 });
    await store.registerUniverse(universeId, 'Test', 7, { name: 'Test', seed: 7 });
    for (let c = 0; c < 30; c++) await store.writeCycle(snap(universeId, c));
    await store.writeCycle(snap(universeId, 29)); // re-write: ON CONFLICT DO NOTHING
  }, 120_000);

  const check = async () => {
    const series = await store.readSeries(universeId);
    for (const s of series) expect(ChartSeriesSchema.safeParse(s).success).toBe(true);
    const find = (metric: string, extra: object = {}) =>
      series.find((s) => s.metric === metric && Object.entries(extra).every(([k, v]) => (s as Record<string, unknown>)[k] === v));

    const gdp = find('gdp', { planet: 'helion' });
    expect(gdp?.points.map((p) => p[0])).toEqual([0, 5, 10, 15, 20, 25]); // 30 cycles / 5-cycle buckets
    expect(gdp?.points[0]?.[1]).toBe(1_002); // avg(1000..1004)
    expect(find('cpi', { planet: 'helion' })?.points[0]?.[1]).toBe(10_004); // last in bucket
    expect(find('trade_balance', { planet: 'helion' })?.points[0]?.[1]).toBe(10 - 4 + 10 - 4 + 10); // cycles 0..4
    expect(find('price', { planet: 'helion', good: 'iron' })?.points[5]?.[1]).toBe(129);
    expect(find('fx_rate', { pair: 'HEL/VES' })?.points.at(-1)).toEqual([25, 1_000_029]);
    expect(find('gdp', { planet: 'vesta' })).toBeDefined();
  };

  it('reads schema-valid series via real-time aggregation', check);

  it('reads the same series after materialising the aggregates', async () => {
    await store.refreshAggregates();
    await check();
  }, 60_000);

  it('records god-mode audit rows', async () => {
    await store.recordGodModeAudit({ universeId, cycle: 12, sub: 'auth0|abc', command: { kind: 'pause' }, ok: true });
    await store.recordGodModeAudit({ universeId, cycle: 13, sub: 'auth0|abc', command: { kind: 'resume' }, ok: false, error: 'boom' });
  });
});

describe.skipIf(!url)('TigerStore.resetUniverse (TimescaleDB integration)', () => {
  const id = `r${Date.now().toString(36)}`;
  const fork = `${id}-f1`;
  const other = `${id}x`; // shares the prefix but is not a fork: must survive
  let store: TigerStore;
  let pool: pg.Pool;

  beforeAll(async () => {
    store = TigerStore.fromUrl(url);
    pool = new pg.Pool({ connectionString: url });
    await store.migrate();
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  const helionGdp = async (u: string) => (await store.readSeries(u)).find((s) => s.metric === 'gdp' && s.planet === 'helion')?.points;
  const count = async (sql: string, args: unknown[]) => Number((await pool.query(sql, args)).rows[0].n);

  it("gives a restarted run a clean slate: the old run's rows, forks and chart buckets are gone, the audit log stays", async () => {
    // Run A: 30 cycles, a fork, an unrelated universe, materialised charts.
    for (const u of [id, fork, other]) await store.registerUniverse(u, u, 1, {});
    for (let c = 0; c < 30; c++) for (const u of [id, fork, other]) await store.writeCycle(snap(u, c));
    await store.writeDecisions(
      [{ universeId: id, cycle: 3, agentId: 'helion:colonist:0', role: 'colonist', planet: 'helion', observation: {}, allowedActions: [], deadlineMs: 1 }] as never,
      [{ agentId: 'helion:colonist:0', actions: [], reason: 'r', source: 'stub' }] as never,
    );
    await store.recordGodModeAudit({ universeId: id, cycle: 4, sub: 'auth0|op', command: { kind: 'pause' }, ok: true });
    await store.refreshAggregates();
    expect((await helionGdp(id))?.map((p) => p[0])).toEqual([0, 5, 10, 15, 20, 25]);

    expect(await store.resetUniverse(id)).toBeGreaterThan(0);
    expect(await helionGdp(id)).toBeUndefined();
    expect(await helionGdp(fork)).toBeUndefined();
    expect((await helionGdp(other))?.length).toBe(6);
    expect(await count(`SELECT count(*) AS n FROM universes WHERE id = ANY($1)`, [[id, fork]])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM agent_decisions WHERE universe_id = $1`, [id])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM god_mode_audit WHERE universe_id = $1`, [id])).toBe(1);

    // Run B: different numbers for the same cycles. They must be stored, not dropped as conflicts with run A's rows,
    // and charted with run B's values. (Here other universes sit at cycle 29, so the shared real-time watermark stays
    // there and run B shows once materialised; with nothing else ahead it is charted at once.)
    await store.registerUniverse(id, id, 1, {});
    for (let c = 0; c < 10; c++) {
      const s = snap(id, c);
      s.planets[0]!.metrics.gdp += 5_000;
      await store.writeCycle(s);
    }
    expect(await count(`SELECT count(*) AS n FROM planet_metrics WHERE universe_id = $1 AND gdp > 5000`, [id])).toBe(10);
    await store.refreshAggregates();
    expect(await helionGdp(id)).toEqual([[0, 6_002], [5, 6_007]]);
    expect((await helionGdp(other))?.length).toBe(6);
    expect(await store.resetUniverse(`${id}-nothing-here`)).toBe(0);
  }, 120_000);
});
