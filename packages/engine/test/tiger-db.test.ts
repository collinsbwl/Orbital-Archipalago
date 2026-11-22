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
        metrics: { gdp: 1_000 + cycle, cpi: 10_000 + cycle, tradeBalance: cycle % 2 === 0 ? 10 : -4, population: 500, consumerConfidence: 60, businessConfidence: 55, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90 },
        orbitPhaseCycles: 0 },
      { planet: 'vesta', currency: 'VES', prices: { iron: 90 }, policy,
        metrics: { gdp: 2_000, cpi: 9_900, tradeBalance: 40, population: 800, consumerConfidence: 70, businessConfidence: 65, realGdp: 900, labourInput: 30, capitalStock: 5, realGdpGrowthBp: 120, labourContribBp: 0, capitalContribBp: 30, tfpContribBp: 90 },
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
    expect(find('real_gdp', { planet: 'helion' })?.points[0]?.[1]).toBe(900);
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
