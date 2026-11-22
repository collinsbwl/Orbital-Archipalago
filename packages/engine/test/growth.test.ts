import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { GROWTH_CONFIG, ZERO_GROWTH, decompose, growthBp, realGdp } from '../src/growth.js';
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
    expect(tethys.at(-1)!.capitalStock).toBeGreaterThan(tethys[0]!.capitalStock);
    expect(tethys.some((m) => m.realGdp > 0)).toBe(true);
    for (const r of reports) {
      for (const p of world.planets) {
        const m = r.metrics[p.id]!;
        expect(m.labourInput).toBe(p.agents.colonist);
        expect(m.labourContribBp + m.capitalContribBp + m.tfpContribBp).toBe(m.realGdpGrowthBp);
      }
    }
    expect(reports[W + S - 2]!.metrics['tethys']!).toMatchObject({ realGdpGrowthBp: 0, tfpContribBp: 0 }); // not enough history yet (tools only start forging after ~90 cycles under RandomValidPolicy, hence 200)
  }, 120_000);
});
