import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { GROWTH_CONFIG, ZERO_GROWTH, accrueWear, accumulateInstalledPpm, investmentPpm, capacityMultiplierPpm, decompose, growthBp, realGdp, scaleBatches } from '../src/growth.js';
import { batchKey, runProduction } from '../src/phases/production.js';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import type { DecisionProvider } from '../src/index.js';
import { makeUniverse } from './helpers.js';

const { windowCycles: W, smoothCycles: S, cyclesPerYear: CPY } = GROWTH_CONFIG;
const flat = (n: number, v: number) => Array<number>(n).fill(v);

describe('growthBp', () => {
  it('annualises log growth over the window', () => {
    expect(growthBp(100, 100, 50, 50)).toBe(0);
    expect(growthBp(Math.E, 1, 50, 50)).toBe(10_000); // ln(e) = 1 over exactly one year
    expect(growthBp(Math.E, 1, 25, 50)).toBe(20_000); // same change in half a year
    expect(growthBp(50, 100, 50, 50)).toBe(Math.round(Math.log(0.5) * 10_000));
  });

  it('is 0 when either level is not positive', () => {
    expect(growthBp(0, 100, 50, 50)).toBe(0);
    expect(growthBp(100, 0, 50, 50)).toBe(0);
    expect(growthBp(-1, 5, 50, 50)).toBe(0);
  });
});

describe('decompose', () => {
  it('is all zeros until window + smoothing cycles exist', () => {
    const short = { realGdp: flat(W + S - 1, 100), labour: flat(W + S - 1, 30), capital: flat(W + S - 1, 5) };
    expect(decompose(short)).toEqual(ZERO_GROWTH);
    expect(decompose({ realGdp: [], labour: [], capital: [] })).toEqual(ZERO_GROWTH);
  });

  it('is 0 for flat series', () => {
    const n = W + S;
    expect(decompose({ realGdp: flat(n, 100), labour: flat(n, 30), capital: flat(n, 5) })).toEqual(ZERO_GROWTH);
  });

  it('splits growth into labour, capital and a TFP residual that sum exactly to real GDP growth', () => {
    const n = W + S;
    // Earlier span (first S entries) at 100 / 30 / 10, latest span at 150 / 33 / 20.
    const step = (a: number, b: number) => [...flat(S, a), ...flat(n - 2 * S, a), ...flat(S, b)];
    const d = decompose({ realGdp: step(100, 150), labour: step(30, 33), capital: step(10, 20) });
    const a = GROWTH_CONFIG.capitalShareBp / 10_000;
    expect(d.realGdpGrowthBp).toBe(growthBp(150, 100, W, CPY));
    expect(d.capitalContribBp).toBe(Math.round(growthBp(20, 10, W, CPY) * a));
    expect(d.labourContribBp).toBe(Math.round(growthBp(33, 30, W, CPY) * (1 - a)));
    expect(d.realGdpGrowthBp).toBeGreaterThan(0);
    expect(d.tfpContribBp).toBe(d.realGdpGrowthBp - d.capitalContribBp - d.labourContribBp);
    expect(d.labourContribBp + d.capitalContribBp + d.tfpContribBp).toBe(d.realGdpGrowthBp);
  });

  it('with no capital attributes all growth to labour and TFP (K = 0 gives a zero capital term)', () => {
    const n = W + S;
    const step = (a: number, b: number) => [...flat(n - S, a), ...flat(S, b)];
    const d = decompose({ realGdp: step(100, 120), labour: step(30, 30), capital: flat(n, 0) });
    expect(d.capitalContribBp).toBe(0);
    expect(d.labourContribBp).toBe(0);
    expect(d.tfpContribBp).toBe(d.realGdpGrowthBp);
    expect(d.realGdpGrowthBp).toBeGreaterThan(0);
  });

  it('with zero output growth, capital deepening is offset by negative TFP', () => {
    const n = W + S;
    const d = decompose({ realGdp: flat(n, 100), labour: flat(n, 30), capital: [...flat(n - S, 10), ...flat(S, 20)] });
    expect(d.realGdpGrowthBp).toBe(0);
    expect(d.capitalContribBp).toBeGreaterThan(0);
    expect(d.tfpContribBp).toBe(-d.capitalContribBp);
  });
});

describe('realGdp', () => {
  it('values output less inputs at base prices, ignoring clearing prices', () => {
    const p = (id: string) => DEFAULT_WORLD.goods.find((g) => g.id === id)!.basePrice;
    expect(realGdp({ tools: 2 }, { iron: 1 }, DEFAULT_WORLD)).toBe(2 * p('tools') - p('iron'));
    expect(realGdp({}, { iron: 5 }, DEFAULT_WORLD)).toBe(0);
  });
});

describe('growth metrics in a run', () => {
  it('accumulates tools on tethys, reports real GDP, and keeps the decomposition exact', async () => {
    const { universe, world } = makeUniverse({ seed: 42, checkInvariants: false });
    await universe.init();
    const reports = [];
    for (let c = 0; c < 200; c++) reports.push(await universe.step());
    const tethys = reports.map((r) => r.metrics['tethys']!);
    expect(tethys[0]!.capitalStock).toBeGreaterThanOrEqual(0);
    expect(Math.max(...tethys.map((m) => m.capitalStock))).toBeGreaterThan(tethys[0]!.capitalStock);
    expect(tethys.some((m) => m.realGdp > 0)).toBe(true);
    for (const r of reports) {
      for (const p of world.planets) {
        const m = r.metrics[p.id]!;
        expect(Math.abs(m.labourInput - (m.workingAge * m.participationBp) / 10_000)).toBeLessThanOrEqual(1); // workingAge is itself rounded
        expect(m.labourContribBp + m.capitalContribBp + m.tfpContribBp).toBe(m.realGdpGrowthBp);
      }
    }
    expect(reports[W + S - 2]!.metrics['tethys']!).toMatchObject({ realGdpGrowthBp: 0, tfpContribBp: 0 }); // not enough history yet (tools only start forging after ~90 cycles under RandomValidPolicy, hence 200)
  }, 120_000);
});

const PPM = 1_000_000;
const pass: DecisionProvider = {
  decideAll: async (tasks: AgentTask[]): Promise<AgentDecision[]> => tasks.map((t) => ({ agentId: t.agentId, actions: [{ kind: 'pass' }], reason: 'hold', source: 'stub' })),
  fork: () => pass,
};
const giveTools = (ledger: InMemoryLedger, owner: string, qty: number) =>
  ledger.produce({ owner, planet: 'tethys', inputs: [], outputs: [{ good: GROWTH_CONFIG.capitalGood, qty }] });

describe('capacity multiplier', () => {
  it('is exactly 1 with no capital, and rises monotonically with it at the capital share', () => {
    expect(capacityMultiplierPpm(0)).toBe(PPM);
    let prev = PPM;
    for (let k = 1; k <= 500; k++) {
      const m = capacityMultiplierPpm(k);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
    expect(capacityMultiplierPpm(GROWTH_CONFIG.baseCapital)).toBe(Math.round(2 ** (GROWTH_CONFIG.capitalShareBp / 10_000) * PPM));
    expect(capacityMultiplierPpm(100, { ...GROWTH_CONFIG, capitalAffectsProduction: false })).toBe(PPM);
  });

  it('a multiplier of 1 never adds or drops a batch', () => {
    expect(scaleBatches(10, PPM, 0)).toEqual({ batches: 10, carryPpm: 0 });
  });

  it('carries the fraction: 10 batches x 1.05 averages 10.5 per cycle, never off by a whole batch', () => {
    let carry = 0, sum = 0;
    for (let c = 1; c <= 200; c++) {
      const r = scaleBatches(10, 1_050_000, carry);
      carry = r.carryPpm;
      sum += r.batches;
      expect(Math.abs(sum - 10.5 * c)).toBeLessThan(1);
      expect(r.batches === 10 || r.batches === 11).toBe(true);
    }
    expect(sum).toBe(2_100);
  });

  it('runProduction runs the overridden batch count, inputs scaling with it', async () => {
    const { ledger, universe } = makeUniverse({ agents: pass });
    await universe.init();
    const used: Record<string, Record<string, number>> = {};
    const base = await runProduction(DEFAULT_WORLD, ledger, 0, {}, undefined, undefined);
    expect(base['tethys']!['water']).toBe(60);
    const more = await runProduction(DEFAULT_WORLD, ledger, 0, used, undefined, new Map([[batchKey('tethys', 'pump_water'), 13]]));
    expect(more['tethys']!['water']).toBe(78);
    const none = await runProduction(DEFAULT_WORLD, ledger, 0, used, undefined, new Map([[batchKey('verdan', 'farm_grain'), 0]]));
    expect(none['verdan']!['grain'] ?? 0).toBe(0);
    expect(used['verdan']!['water'] ?? 0).toBe(0); // farm_grain (the water consumer) was skipped
  });

  it('a planet holding tools produces more than one holding none; a planet without tools is unchanged', async () => {
    const a = makeUniverse({ agents: pass, checkInvariants: false });
    const b = makeUniverse({ agents: pass, checkInvariants: false });
    await a.universe.init(); await b.universe.init();
    await giveTools(b.ledger, 'tethys:colonist:0', 100);
    const ra = await a.universe.step();
    const rb = await b.universe.step();
    expect(rb.produced['tethys']!['water']!).toBeGreaterThan(ra.produced['tethys']!['water']!);
    expect(rb.produced['helion']).toEqual(ra.produced['helion']);
  });
});

describe('capital depreciation', () => {
  it('accrues K x rate in ppm, releases whole units only, and keeps the remainder', () => {
    const cfg = { ...GROWTH_CONFIG, depreciationPpm: 5_000 };
    const rate = cfg.depreciationPpm;
    expect(accrueWear(0, 0, cfg)).toEqual({ units: 0, accPpm: 0 });
    expect(accrueWear(100, 0, cfg)).toEqual({ units: 0, accPpm: 100 * rate });
    let acc = 0, units = 0;
    for (let c = 0; c < 10; c++) {
      const w = accrueWear(100, acc, cfg);
      acc = w.accPpm;
      units += w.units;
    }
    expect(units).toBe(Math.floor((10 * 100 * rate) / PPM));
    expect(acc).toBe(10 * 100 * rate - units * PPM);
    expect(accrueWear(3, 999_000, cfg).units).toBeLessThanOrEqual(3);
  });

  it('destroys whole units from the largest holder first, ties in roster order', async () => {
    const { universe, ledger } = makeUniverse({ agents: pass, checkInvariants: false });
    await universe.init();
    await giveTools(ledger, 'tethys:colonist:0', 5);
    await giveTools(ledger, 'tethys:colonist:1', 2);
    await giveTools(ledger, 'tethys:colonist:2', 2);
    const wear = (capital: number) => (universe as unknown as { wearCapital(m: Map<string, number>): Promise<void> }).wearCapital(new Map([['tethys', capital]]));
    const held = async () => Promise.all([0, 1, 2].map((i) => ledger.getInventory(`tethys:colonist:${i}`, 'tethys', 'tools')));
    await wear(400); // 400 x 1.5% = 6 units: colonist 0 loses all 5, then the 2-way tie goes to colonist 1
    expect(await held()).toEqual([0, 1, 2]);
    await wear(34); // accumulator 0 -> 510k: nothing yet
    expect(await held()).toEqual([0, 1, 2]);
    await wear(34); // 1.02M: one more unit, from the (now) largest holder colonist 2
    expect(await held()).toEqual([0, 1, 1]);
  });

  it('wears the stock down in a run (nothing else consumes tools) and conserves invariants', async () => {
    const { universe, ledger } = makeUniverse({ agents: pass });
    await universe.init();
    await giveTools(ledger, 'tethys:colonist:0', 400);
    const before = (await universe.step()).metrics['tethys']!.capitalStock;
    let last = before;
    for (let c = 0; c < 30; c++) last = (await universe.step()).metrics['tethys']!.capitalStock;
    expect(last).toBeLessThan(before + 30 * 5); // forging adds at most 5 per cycle; wear takes ~6 per cycle
  });
});

describe('fork copies capital state', () => {
  it('deep-copies carries and wear accumulators and then runs identically', async () => {
    const { universe, ledger } = makeUniverse({ agents: pass, checkInvariants: false });
    await universe.init();
    await giveTools(ledger, 'tethys:colonist:0', 30);
    for (let c = 0; c < 5; c++) await universe.step();
    const fork = await universe.fork('u0-f1');
    type State = { batchCarry: Map<string, number>; wearPpm: Map<string, number> };
    const a = universe as unknown as State, f = fork as unknown as State;
    expect(a.batchCarry.size).toBeGreaterThan(0);
    expect([...a.batchCarry.values()].some((v) => v !== 0)).toBe(true);
    expect(f.batchCarry).toEqual(a.batchCarry);
    expect(f.wearPpm).toEqual(a.wearPpm);
    expect(f.batchCarry).not.toBe(a.batchCarry);
    expect(f.wearPpm).not.toBe(a.wearPpm);
    const k = [...a.batchCarry.keys()][0]!;
    const orig = a.batchCarry.get(k);
    f.batchCarry.set(k, 123);
    expect(a.batchCarry.get(k)).toBe(orig);
    f.batchCarry.set(k, orig!);
    const ra = [], rb = [];
    for (let c = 0; c < 10; c++) { ra.push(await universe.step()); rb.push(await fork.step()); }
    expect(rb).toEqual(ra);
  });
});

describe('saving and investment', () => {
  const price = DEFAULT_WORLD.goods.find((g) => g.id === GROWTH_CONFIG.capitalGood)!.basePrice;
  type Inner = { installedCapitalPpm: Map<string, number> };

  it('investment is savingsRate x real GDP / capital base price in ppm tool-equivalents, deterministically', () => {
    expect(investmentPpm(0, price)).toBe(0);
    expect(investmentPpm(-5, price)).toBe(0);
    expect(investmentPpm(6_000, 300, { ...GROWTH_CONFIG, savingsRateBp: 1_000 })).toBe(2 * PPM); // 10% of 6000 = 600 = 2 tools
    expect(investmentPpm(1_000, 300, { ...GROWTH_CONFIG, savingsRateBp: 500 })).toBe(Math.round((500 * 1_000 * PPM) / (10_000 * 300)));
    expect(investmentPpm(1_000, price)).toBe(investmentPpm(1_000, price));
    expect(investmentPpm(1_000, price, { ...GROWTH_CONFIG, capitalAffectsProduction: false })).toBe(0);
  });

  it('accumulation adds investment then depreciates the sum by delta (ppm), converging to s*Y/(delta*p)', () => {
    const cfg = { ...GROWTH_CONFIG, depreciationPpm: 10_000 };
    expect(accumulateInstalledPpm(0, 0, cfg)).toBe(0);
    expect(accumulateInstalledPpm(0, 1_000_000, cfg)).toBe(990_000);
    expect(accumulateInstalledPpm(990_000, 1_000_000, cfg)).toBe(1_990_000 - 19_900);
    let k = 0;
    const inv = investmentPpm(6_000, 300, { ...cfg, savingsRateBp: 1_000 });
    for (let c = 0; c < 5_000; c++) k = accumulateInstalledPpm(k, inv, cfg);
    const steady = (inv * (1 - 0.01)) / 0.01; // fixed point of k = (k + inv)(1 - delta)
    expect(Math.abs(k - steady)).toBeLessThan(steady * 0.001);
  });

  it('K for metrics and capacity is floor(installed) + tools held', async () => {
    const { universe, ledger } = makeUniverse({ agents: pass, checkInvariants: false });
    await universe.init();
    await giveTools(ledger, 'tethys:colonist:0', 10);
    const inner = universe as unknown as Inner;
    inner.installedCapitalPpm.set('tethys', 7_900_000);
    const r = await universe.step();
    // 10 held, minus wear of at most 1 unit this cycle (10 x 1.5% accrues < 1), plus 7 whole installed units; metrics read after wear.
    expect(r.metrics['tethys']!.capitalStock).toBe(10 + 7);
    expect(r.metrics['helion']!.capitalStock).toBe(0);
  });

  it('accrues from each planet\'s real GDP after metrics, and depreciates it, in a run', async () => {
    const { universe } = makeUniverse({ agents: pass, checkInvariants: false });
    await universe.init();
    const inner = universe as unknown as Inner;
    expect(inner.installedCapitalPpm.size).toBe(0);
    const r = await universe.step();
    const expected = accumulateInstalledPpm(0, investmentPpm(r.metrics['verdan']!.realGdp, price));
    expect(expected).toBeGreaterThan(0);
    expect(inner.installedCapitalPpm.get('verdan')).toBe(expected);
  });

  it('fork deep-copies installed capital and then runs identically', async () => {
    const { universe } = makeUniverse({ agents: pass, checkInvariants: false });
    await universe.init();
    for (let c = 0; c < 5; c++) await universe.step();
    const fork = await universe.fork('u0-f2');
    const a = (universe as unknown as Inner).installedCapitalPpm, f = (fork as unknown as Inner).installedCapitalPpm;
    expect([...a.values()].some((v) => v > 0)).toBe(true);
    expect(f).toEqual(a);
    expect(f).not.toBe(a);
    const orig = a.get('verdan');
    f.set('verdan', 1);
    expect(a.get('verdan')).toBe(orig);
    f.set('verdan', orig!);
    const ra = [], rb = [];
    for (let c = 0; c < 10; c++) { ra.push(await universe.step()); rb.push(await fork.step()); }
    expect(rb).toEqual(ra);
  });
});
