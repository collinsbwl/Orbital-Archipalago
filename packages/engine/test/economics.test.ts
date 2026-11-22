import { describe, expect, it } from 'vitest';
import { ChartSeriesSchema, DEFAULT_WORLD, SnapshotSchema } from '@orbital/contracts';
import type { Loan, Snapshot } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { InMemorySeries, RESERVE_BANK_CONFIG, RandomValidPolicy, Universe, basketCpi, confidence, inflationBp, outputGapBp, taylorRateBp, tradeBalance, valueAdded } from '../src/index.js';
import type { CycleReport } from '../src/index.js';
import { initialSupply } from './helpers.js';

describe('taylorRateBp', () => {
  it('is the neutral rate at target inflation and no gap, and rises with inflation and the output gap', () => {
    expect(taylorRateBp(0, 0)).toBe(RESERVE_BANK_CONFIG.neutralBp);
    // Per-cycle terms: 5-cycle inflation / 5, output gap / cyclesPerYear (50).
    expect(taylorRateBp(500, 0)).toBe(20 + 150);
    expect(taylorRateBp(100, 0)).toBeGreaterThan(taylorRateBp(50, 0));
    expect(taylorRateBp(0, 10_000)).toBe(20 + 100);
  });

  it('clamps to 0..500 and returns integers', () => {
    expect(taylorRateBp(-5_000, 0)).toBe(0);
    expect(taylorRateBp(0, -50_000)).toBe(0);
    expect(taylorRateBp(5_000, 5_000)).toBe(500);
    for (const [i, g] of [[1, 1], [3, 7], [-3, 5], [33, -17], [0.5, 0.5]] as const) expect(Number.isInteger(taylorRateBp(i, g))).toBe(true);
    expect(taylorRateBp(10, 100)).toBe(Math.round(20 + 1.5 * 2 + (0.5 * 100) / 50));
  });

  it('measures inflation and the output gap in integer bp', () => {
    expect(inflationBp(10_500, 10_000)).toBe(500);
    expect(inflationBp(9_000, 10_000)).toBe(-1_000);
    expect(inflationBp(5, 0)).toBe(0);
    expect(outputGapBp(120, [100, 100, 120])).toBe(Math.round(((120 - 106.666666) * 10_000) / 106.666666));
    expect(outputGapBp(50, [])).toBe(0);
    expect(outputGapBp(50, [0, 0])).toBe(0);
  });
});

describe('metrics', () => {
  const base = (g: string) => DEFAULT_WORLD.goods.find((x) => x.id === g)!.basePrice;

  it('CPI is 10_000 at base prices and tracks the needs basket', () => {
    expect(basketCpi(DEFAULT_WORLD, base)).toBe(10_000);
    // needs: 1 grain (40) + 1 water (20) at base = 60; doubling grain -> 100/60.
    expect(basketCpi(DEFAULT_WORLD, (g) => (g === 'grain' ? 80 : base(g)))).toBe(Math.round((100 * 10_000) / 60));
    expect(basketCpi(DEFAULT_WORLD, (g) => (g === 'iron' ? 1 : base(g)))).toBe(10_000);
  });

  it('GDP is output value minus input value, floored at 0', () => {
    expect(valueAdded({ iron: 4 }, {}, base)).toBe(400);
    expect(valueAdded({ fuel: 1 }, { water: 3 }, base)).toBe(60 - 60);
    expect(valueAdded({ grain: 4 }, { water: 1 }, base)).toBe(160 - 20);
    expect(valueAdded({ grain: 4 }, { water: 1 }, (g) => (g === 'water' ? 1_000 : base(g)))).toBe(0);
  });

  it('trade balance is exports minus imports', () => {
    expect(tradeBalance({ exports: 500, imports: 200 })).toBe(300);
    expect(tradeBalance({ exports: 100, imports: 450 })).toBe(-350);
  });

  it('confidence is the rounded mean of its type, carrying the previous value forward', () => {
    const s = [{ type: 'consumer', confidence: 10 }, { type: 'consumer', confidence: 21 }, { type: 'business', confidence: 90 }] as const;
    expect(confidence(s, 'consumer', 50)).toBe(16);
    expect(confidence(s, 'business', 50)).toBe(90);
    expect(confidence([], 'business', 73)).toBe(73);
  });
});

const CYCLES = 200;
type Burn = { loan: Loan; cycle: number };

/** One 200-cycle run with a ledger wrapper that records every borrow and repay (from the returned Loan values). */
async function run(seed: number) {
  const world = DEFAULT_WORLD;
  const ledger = new InMemoryLedger(world);
  const series = new InMemorySeries();
  const universe = new Universe({ world, ledger, agents: new RandomValidPolicy(world, seed), checkInvariants: false, sink: series });
  const issued: Loan[] = [];
  const repaid: Burn[] = [];
  const tracked = new Map<string, { outstanding: number; lastAccrual: number }>();
  const minted: Record<string, number> = {};
  const burned: Record<string, number> = {};
  const borrow = ledger.borrow.bind(ledger);
  const repay = ledger.repay.bind(ledger);
  ledger.borrow = async (req) => {
    const l = await borrow(req);
    issued.push(l);
    tracked.set(l.id, { outstanding: l.outstanding, lastAccrual: l.issuedCycle });
    minted[l.currency] = (minted[l.currency] ?? 0) + l.principal;
    return l;
  };
  ledger.repay = async (req) => {
    const l = await repay(req);
    const t = tracked.get(l.id)!;
    const interest = Math.floor((l.principal * l.rateBp * (req.cycle - t.lastAccrual)) / 10_000);
    burned[l.currency] = (burned[l.currency] ?? 0) + t.outstanding + interest - l.outstanding;
    tracked.set(l.id, { outstanding: l.outstanding, lastAccrual: req.cycle });
    repaid.push({ loan: l, cycle: req.cycle });
    return l;
  };

  await universe.init();
  const supply = initialSupply(world);
  const reports: CycleReport[] = [];
  const snapshots: Snapshot[] = [];
  for (let c = 0; c < CYCLES; c++) {
    reports.push(await universe.step());
    const inv = await ledger.checkInvariants();
    expect(inv.ok, `cycle ${c}: ${JSON.stringify(inv.violations)}`).toBe(true);
    for (const cur of Object.keys(supply)) {
      expect(inv.totals.currency[cur], `cycle ${c} ${cur}`).toBe(supply[cur]! + (minted[cur] ?? 0) - (burned[cur] ?? 0));
    }
    snapshots.push(await universe.snapshot({ series: await series.readSeries(world.universeId) }));
  }
  return { reports, snapshots, issued, repaid, series, universe, world };
}

const shared = { run: undefined as ReturnType<typeof run> | undefined };
const run42 = () => (shared.run ??= run(42));

describe('200-cycle economy on DEFAULT_WORLD', () => {
  it('issues and repays loans, keeps money supply = initial + borrowed - burned, and is deterministic', async () => {
    const a = await run42();
    expect(a.issued.length).toBeGreaterThan(0);
    expect(a.repaid.length).toBeGreaterThan(0);
    expect(a.reports.reduce((s, r) => s + r.rejections, 0)).toBe(0);
    expect(a.reports.reduce((s, r) => s + r.ledgerRejections, 0)).toBe(0);
    const b = await run(42);
    expect(b.reports).toEqual(a.reports);
    expect(b.snapshots).toEqual(a.snapshots);
  }, 60_000);

  it('reserve banks move policy rates within 0..500 bp and emit policy events', async () => {
    const { snapshots, world } = await run42();
    for (const p of world.planets) {
      const rates = snapshots.map((s) => s.planets.find((x) => x.planet === p.id)!.policy.policyRateBp);
      expect(rates.every((r) => r >= 0 && r <= 500), p.id).toBe(true);
      expect(new Set(rates).size, p.id).toBeGreaterThan(1);
      // The rate only changes on cycles divisible by 5.
      rates.forEach((r, i) => i > 0 && r !== rates[i - 1] && expect(i % RESERVE_BANK_CONFIG.intervalCycles).toBe(0));
    }
    expect(snapshots[CYCLES - 1]!.events.some((e) => e.kind === 'policy')).toBe(true);
  });

  it('reports integer metrics, with CPI near base and confidence from surveys', async () => {
    const { reports, world } = await run42();
    for (const r of reports) {
      for (const p of world.planets) {
        const m = r.metrics[p.id]!;
        for (const v of Object.values(m)) expect(Number.isInteger(v)).toBe(true);
        expect(m.population).toBe(m.children + m.workingAge + m.retired);
        expect(m.population).toBeGreaterThan(0);
        expect(m.consumerConfidence).toBeGreaterThanOrEqual(0);
        expect(m.businessConfidence).toBeLessThanOrEqual(100);
      }
    }
    expect(reports.some((r) => world.planets.some((p) => r.metrics[p.id]!.gdp > 0))).toBe(true);
    expect(reports.some((r) => world.planets.some((p) => r.metrics[p.id]!.consumerConfidence !== 50))).toBe(true);
    expect(reports.some((r) => world.planets.some((p) => r.metrics[p.id]!.tradeBalance !== 0))).toBe(true);
  });

  it('snapshots every cycle pass SnapshotSchema, events are capped and sequentially numbered', async () => {
    const { snapshots, universe } = await run42();
    for (const s of snapshots) SnapshotSchema.parse(s);
    const last = snapshots[snapshots.length - 1]!;
    expect(last.cycle).toBe(CYCLES - 1);
    expect(last.events.length).toBeLessThanOrEqual(50);
    const ids = last.events.map((e) => Number(e.id.slice(1)));
    expect(ids.every((n, i) => i === 0 || n === ids[i - 1]! + 1)).toBe(true);
    expect(last.fx.length).toBe(3);
    expect(universe.metricsHistory().length).toBe(CYCLES);
  });

  it('InMemorySeries builds schema-valid series for every metric', async () => {
    const { series, world } = await run42();
    const all = await series.readSeries(world.universeId);
    for (const s of all) ChartSeriesSchema.parse(s);
    expect(all.length).toBe(world.planets.length * (4 + world.goods.length) + 3);
    expect(new Set(all.map((s) => s.metric))).toEqual(new Set(['gdp', 'real_gdp', 'cpi', 'trade_balance', 'price', 'fx_rate']));
    expect(all.find((s) => s.metric === 'fx_rate')!.pair).toMatch(/^[A-Z]+\/[A-Z]+$/);
    expect(all.every((s) => s.points.length > 0 && s.points.length <= 1_000)).toBe(true);
    expect(all.find((s) => s.metric === 'gdp')!.points.length).toBe(CYCLES);
    expect(await series.readSeries('nope')).toEqual([]);
  });
});
