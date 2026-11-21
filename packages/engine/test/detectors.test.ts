import { describe, expect, it } from 'vitest';
import type { ArriveResult, PolicyState } from '@orbital/contracts';
import { DETECTOR_CONFIG, Detectors } from '../src/detectors/index.js';
import type { DetectedEvent, DetectorInput } from '../src/detectors/index.js';

const pol = (tariffsBp: Record<string, number> = {}, embargoes: string[] = []): PolicyState => ({ tariffsBp, quotas: {}, embargoes, policyRateBp: 0 });
const M = (gdp = 1000, consumerConfidence = 50, businessConfidence = 50) => ({ gdp, consumerConfidence, businessConfidence });

function arrival(from: string, to: string, good: string, qty: number, cycle: number): ArriveResult {
  return {
    shipment: { id: `s${from}${to}${cycle}${good}`, owner: 'x', from, to, cargo: [{ good, qty }], departCycle: cycle - 1, arriveCycle: cycle, status: 'arrived' },
    delivered: [{ good, qty }], withheld: [], duty: { currency: 'AAA', amount: 0 },
  };
}

const input = (cycle: number, p: Partial<DetectorInput> = {}): DetectorInput => ({
  cycle, metrics: { helion: M(), verdan: M() }, policies: { helion: pol(), verdan: pol() }, fx: [], arrivals: [], ...p,
});

function run(d: Detectors, from: number, to: number, make: (c: number) => DetectorInput): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  for (let c = from; c <= to; c++) out.push(...d.observe(make(c)));
  return out;
}
const only = (evs: DetectedEvent[], kind: DetectedEvent['detector']) => evs.filter((e) => e.detector === kind);
const cyclesOf = (evs: DetectedEvent[]) => evs.map((e) => e.cycle);

/** Mutual deliveries every 5 cycles; tariff schedule per planet: cycle -> tariff bp for 'ore'. */
function warInputs(raises: { helion?: Record<number, number>; verdan?: Record<number, number> }, trade = true) {
  const tariff = (sched: Record<number, number> = {}, c: number): number => {
    let v = 0;
    for (const k of Object.keys(sched).map(Number).sort((a, b) => a - b)) if (k <= c) v = sched[k] ?? v;
    return v;
  };
  return (c: number): DetectorInput => input(c, {
    policies: { helion: pol({ ore: tariff(raises.helion, c) }), verdan: pol({ ore: tariff(raises.verdan, c) }) },
    arrivals: trade && c % 5 === 0 ? [arrival('helion', 'verdan', 'ore', 3, c), arrival('verdan', 'helion', 'grain', 3, c)] : [],
  });
}

describe('trade war', () => {
  it('fires when two trading planets raise tariffs within 10 cycles', () => {
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 20, warInputs({ helion: { 5: 500 }, verdan: { 9: 500 } })), 'trade_war');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ cycle: 9, detector: 'trade_war', text: 'Trade war: Helion and Verdan raised tariffs within 4 cycles' });
  });

  it('does not fire for raises 11 cycles apart, cuts, or without a mutual trade link', () => {
    const far = run(new Detectors({ warmupCycles: 0 }), 0, 30, warInputs({ helion: { 5: 500 }, verdan: { 16: 500 } }));
    expect(only(far, 'trade_war')).toEqual([]);
    // tariff cuts are not raises
    const cuts = run(new Detectors({ warmupCycles: 0 }), 0, 30, warInputs({ helion: { 2: 900, 5: 100 }, verdan: { 2: 900, 6: 100 } }));
    expect(only(cuts, 'trade_war').filter((e) => e.cycle > 6)).toEqual([]);
    // one-way trade only
    const oneWay = (c: number): DetectorInput => ({ ...warInputs({ helion: { 5: 500 }, verdan: { 9: 500 } })(c), arrivals: c % 5 === 0 ? [arrival('helion', 'verdan', 'ore', 3, c)] : [] });
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 20, oneWay), 'trade_war')).toEqual([]);
    // trade link gone stale (>30 cycles)
    const stale = (c: number): DetectorInput => ({ ...warInputs({ helion: { 45: 500 }, verdan: { 47: 500 } })(c), arrivals: c < 10 && c % 5 === 0 ? [arrival('helion', 'verdan', 'ore', 3, c), arrival('verdan', 'helion', 'ore', 3, c)] : [] });
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 50, stale), 'trade_war')).toEqual([]);
  });

  it('respects the 20-cycle cool-down per pair', () => {
    // fires at 9, again attempted at 12 (suppressed), fires again at 33
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 40, warInputs({ helion: { 5: 500, 12: 800, 31: 1100 }, verdan: { 9: 500, 33: 800 } })), 'trade_war');
    expect(cyclesOf(evs)).toEqual([9, 33]);
  });
});

describe('currency crisis', () => {
  const fxAt = (rate: (c: number) => number | null) => (c: number): DetectorInput =>
    input(c, { fx: [{ base: 'AAA', quote: 'BBB', cycle: c, ratePpm: rate(c), fills: [] }] });

  it('fires when a pair moves more than 20% over 5 cycles, then respects the cool-down', () => {
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 30, fxAt((c) => Math.round(1_000_000 * 1.05 ** c))), 'currency_crisis');
    expect(cyclesOf(evs)).toEqual([5, 15, 25]);
    expect(evs[0]?.text).toContain('AAA/BBB');
    expect(evs[0]?.text.length).toBeLessThanOrEqual(280);
  });

  it('does not fire on a 19% move, and carries the last known rate across null cycles', () => {
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 10, fxAt((c) => (c < 5 ? 1_000_000 : 1_190_000))), 'currency_crisis')).toEqual([]);
    const evs = run(new Detectors({ warmupCycles: 0 }), 0, 12, fxAt((c) => (c <= 4 ? 1_000_000 : c < 10 ? null : 1_300_000)));
    expect(cyclesOf(only(evs, 'currency_crisis'))).toEqual([10]);
    // a drop counts too
    const drop = run(new Detectors({ warmupCycles: 0 }), 0, 6, fxAt((c) => (c < 5 ? 1_000_000 : 700_000)));
    expect(cyclesOf(only(drop, 'currency_crisis'))).toEqual([5]);
  });
});

describe('recession', () => {
  /** GDP by 5-cycle bucket means, with intra-bucket noise that averages out. */
  const gdpInputs = (means: number[]) => (c: number): DetectorInput => {
    const noise = [10, -10, 4, -4, 0][c % 5] ?? 0;
    return input(c, { metrics: { helion: M((means[Math.floor(c / 5)] ?? 0) + noise), verdan: M(1000) } });
  };

  it('fires after two falling snapshots with >= 5% cumulative fall, once per recession, re-arming after a rise', () => {
    const means = [100, 98, 94, 90, 95, 92, 88].map((x) => x * 10);
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 34, gdpInputs(means)), 'recession');
    expect(cyclesOf(evs)).toEqual([14, 34]);
    expect(evs[0]).toMatchObject({ planet: 'helion' });
    expect(evs[0]?.text).toContain('Helion');
  });

  it('does not fire on a shallow fall (<5%) or on non-consecutive falls', () => {
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 14, gdpInputs([1000, 980, 970])), 'recession')).toEqual([]);
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 19, gdpInputs([1000, 950, 960, 900])), 'recession')).toEqual([]);
  });

  it('waits for a bucket to complete', () => {
    const evs = run(new Detectors({ warmupCycles: 0 }), 0, 13, gdpInputs([1000, 980, 940]));
    expect(only(evs, 'recession')).toEqual([]);
  });
});

describe('trade diversion', () => {
  /** Verdan raises its ore tariff at cycle 15; helion supplies 10 ore/cycle, with `afterMix` per cycle afterwards. */
  const divInputs = (beforeMix: Record<string, number>, afterMix: Record<string, number>, opts: { embargoAt?: number } = {}) => (c: number): DetectorInput => {
    const mix = c <= 15 ? beforeMix : afterMix;
    const arrivals = Object.entries(mix).filter(([, q]) => q > 0).map(([o, q]) => arrival(o, 'verdan', 'ore', q, c));
    const embargoes = opts.embargoAt !== undefined && c >= opts.embargoAt ? ['helion'] : [];
    return input(c, { policies: { helion: pol(), verdan: pol(opts.embargoAt === undefined ? { ore: c >= 15 ? 500 : 0 } : {}, embargoes) }, arrivals });
  };

  it('fires when the top origin changes after a tariff raise, once the after-window completes', () => {
    const d = new Detectors({ warmupCycles: 0 });
    const evs = run(d, 0, 29, divInputs({ helion: 5 }, { cinder: 5 }));
    expect(only(evs, 'trade_diversion')).toEqual([]);
    const last = only(run(d, 30, 40, divInputs({ helion: 5 }, { cinder: 5 })), 'trade_diversion');
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ cycle: 30, planet: 'verdan' });
    expect(last[0]?.text).toBe("Trade diversion: Verdan's ore imports shifted from Helion (100%) to Cinder (100%) after raising its tariff");
  });

  it('fires on a >= 30 point share shift without a change of top origin', () => {
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 35, divInputs({ helion: 9, cinder: 1 }, { helion: 5, cinder: 5 })), 'trade_diversion');
    expect(cyclesOf(evs)).toEqual([30]);
  });

  it('does not fire on a 20 point shift, or when a window has too little volume', () => {
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 35, divInputs({ helion: 9, cinder: 1 }, { helion: 7, cinder: 3 })), 'trade_diversion')).toEqual([]);
    // after-window has only 5 units (< 10): one arrival of 5 units
    const thin = (c: number): DetectorInput => {
      const base = divInputs({ helion: 5 }, { cinder: 0 })(c);
      return c === 20 ? { ...base, arrivals: [arrival('cinder', 'verdan', 'ore', 5, c)] } : base;
    };
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 35, thin), 'trade_diversion')).toEqual([]);
  });

  it('also triggers on an embargo added by the destination', () => {
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 35, divInputs({ helion: 5 }, { cinder: 5 }, { embargoAt: 15 })), 'trade_diversion');
    expect(evs).toHaveLength(1);
    expect(evs[0]?.text).toContain('after adding an embargo');
  });
});

describe('confidence collapse', () => {
  const conf = (f: (c: number) => number, which: 'consumer' | 'business' = 'consumer') => (c: number): DetectorInput =>
    input(c, { metrics: { helion: which === 'consumer' ? M(1000, f(c), 50) : M(1000, 50, f(c)), verdan: M() } });

  it('fires when an index falls more than 20 points within 10 cycles, then cools down for 10 cycles', () => {
    const evs = only(run(new Detectors({ warmupCycles: 0 }), 0, 30, conf((c) => 300 - 5 * c)), 'confidence_collapse');
    expect(cyclesOf(evs)).toEqual([5, 15, 25]); // drop is 20 at cycle 4 (not strictly more)
    expect(evs[0]).toMatchObject({ planet: 'helion' });
    expect(evs[0]?.text).toContain('consumer');
  });

  it('does not fire on a 20-point or slow decline, and tracks business confidence separately', () => {
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 20, conf((c) => (c < 5 ? 60 : 40))), 'confidence_collapse')).toEqual([]);
    expect(only(run(new Detectors({ warmupCycles: 0 }), 0, 60, conf((c) => 200 - 2 * c)), 'confidence_collapse')).toEqual([]);
    const biz = only(run(new Detectors({ warmupCycles: 0 }), 0, 10, conf((c) => (c < 5 ? 80 : 40), 'business')), 'confidence_collapse');
    expect(biz).toHaveLength(1);
    expect(biz[0]?.text).toContain('business');
  });
});

describe('state and determinism', () => {
  /** Exercises every detector. */
  const scenario = (c: number): DetectorInput => input(c, {
    metrics: { helion: M(1200 - 12 * Math.min(c, 40), 300 - 5 * Math.min(c, 30), 60), verdan: M(1000, 50, 50) },
    policies: { helion: pol({ ore: c >= 5 ? 500 : 0 }), verdan: pol({ ore: c >= 8 ? 500 : 0 }) },
    fx: [{ base: 'AAA', quote: 'BBB', cycle: c, ratePpm: Math.round(1_000_000 * 1.05 ** Math.min(c, 20)), fills: [] }],
    arrivals: c % 2 === 0
      ? [arrival('helion', 'verdan', 'ore', 4, c), arrival('verdan', 'helion', 'grain', 4, c)]
      : [arrival(c < 20 ? 'helion' : 'cinder', 'verdan', 'ore', 6, c)],
  });

  it('is deterministic', () => {
    const a = run(new Detectors({ warmupCycles: 0 }), 0, 60, scenario);
    const b = run(new Detectors({ warmupCycles: 0 }), 0, 60, scenario);
    expect(a).toEqual(b);
    const kinds = new Set(a.map((e) => e.detector));
    for (const k of ['trade_war', 'currency_crisis', 'recession', 'confidence_collapse'] as const) expect(kinds.has(k)).toBe(true);
    for (const e of a) expect(e.text.length).toBeLessThanOrEqual(280);
  });

  it('round-trips getState/setState mid-sequence with identical subsequent output', () => {
    for (const split of [4, 12, 22, 33]) {
      const a = new Detectors({ warmupCycles: 0 });
      run(a, 0, split, scenario);
      const state = JSON.parse(JSON.stringify(a.getState())) as ReturnType<Detectors['getState']>;
      const fork = new Detectors({ warmupCycles: 0 });
      fork.setState(state);
      const rest = run(a, split + 1, 70, scenario);
      expect(run(fork, split + 1, 70, scenario)).toEqual(rest);
      expect(fork.getState()).toEqual(a.getState());
    }
  });

  it('getState returns a copy, and repeated or older cycles are ignored', () => {
    const d = new Detectors({ warmupCycles: 0 });
    run(d, 0, 10, scenario);
    const snap = d.getState();
    snap.cooldowns['x'] = 1;
    expect(d.getState().cooldowns['x']).toBeUndefined();
    expect(d.observe(scenario(10))).toEqual([]);
    expect(d.observe(scenario(3))).toEqual([]);
  });

  it('keeps bounded memory', () => {
    const d = new Detectors({ warmupCycles: 0 });
    run(d, 0, 200, scenario);
    const size200 = JSON.stringify(d.getState()).length;
    run(d, 201, 1000, scenario);
    const s = d.getState();
    expect(JSON.stringify(s).length).toBeLessThan(size200 * 1.5);
    expect(Math.min(...s.deliveries.map((r) => r.c))).toBeGreaterThanOrEqual(1000 - DETECTOR_CONFIG.historyCycles);
  });
});
