import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import type { PolicyState } from '@orbital/contracts';
import {
  Detectors, MIGRATION_CONFIG as CFG, PPM, addMigrants, attractiveness, initDemography, migrationFlows, removeMigrants, stepDemography, totalPpm,
} from '../src/index.js';
import type { CycleReport, MigrationInput, Universe } from '../src/index.js';
import { makeUniverse } from './helpers.js';

const inp = (planet: string, wage: number, unmetPpm = 0, consumerConfidence = 50): MigrationInput => ({ planet, wage, unmetPpm, consumerConfidence });
const travel = () => 2;
const open = () => false;
const wa = (planet: string, people = 1_000) => ({ planet, workingAge: people * PPM });

describe('attractiveness', () => {
  it('rises with food security, relative wage and confidence', () => {
    const base = attractiveness([inp('a', 10), inp('b', 10)]);
    expect(base.get('a')).toBe(base.get('b'));
    expect(attractiveness([inp('a', 10, 200_000), inp('b', 10)]).get('a')!).toBeLessThan(base.get('b')!);
    expect(attractiveness([inp('a', 20), inp('b', 10)]).get('a')!).toBeGreaterThan(attractiveness([inp('a', 20), inp('b', 10)]).get('b')!);
    expect(attractiveness([inp('a', 10, 0, 80), inp('b', 10, 0, 30)]).get('a')!).toBeGreaterThan(attractiveness([inp('a', 10, 0, 80), inp('b', 10, 0, 30)]).get('b')!);
  });
  it('normalises the wage by the cross-planet mean, so only relative pay matters', () => {
    const a = attractiveness([inp('a', 10), inp('b', 20)]);
    const b = attractiveness([inp('a', 100), inp('b', 200)]);
    expect(a.get('a')).toBe(b.get('a'));
    expect(a.get('b')).toBe(b.get('b'));
  });
  it('is 1.0 for a lone planet with full food, the mean wage and full confidence', () => {
    const a = attractiveness([inp('a', 10, 0, 100)]);
    expect(a.get('a')).toBe(PPM);
  });
});

describe('migration flows', () => {
  const attract = new Map([['poor', 400_000], ['rich', 700_000]]);
  const planets = [wa('poor'), wa('rich')];

  it('go from the worse planet to the better one, never the reverse', () => {
    const f = migrationFlows(planets, attract, travel, open);
    expect(f.map((x) => `${x.from}>${x.to}`)).toEqual(['poor>rich']);
    expect(f[0]!.ppm).toBeGreaterThan(0);
  });
  it('are zero between equally attractive planets', () => {
    expect(migrationFlows(planets, new Map([['poor', 5], ['rich', 5]]), travel, open)).toEqual([]);
  });
  it('shrink with travel time', () => {
    const near = migrationFlows(planets, attract, () => 1, open)[0]!.ppm;
    const far = migrationFlows(planets, attract, () => 10, open)[0]!.ppm;
    expect(far).toBeLessThan(near);
  });
  it('cap each origin at maxOutflowBp of its working-age people, scaling destinations together', () => {
    const three = [wa('a'), wa('b'), wa('c')];
    const at = new Map([['a', 0], ['b', 1_000_000], ['c', 900_000]]);
    const f = migrationFlows(three, at, travel, open, { ...CFG, rateBp: 10_000 });
    const out = f.filter((x) => x.from === 'a');
    expect(out).toHaveLength(2);
    const total = out.reduce((s, x) => s + x.ppm, 0);
    expect(total).toBeLessThanOrEqual((1_000 * PPM * CFG.maxOutflowBp) / 10_000);
    expect(total).toBeGreaterThan((1_000 * PPM * CFG.maxOutflowBp) / 10_000 - 3);
    expect(out[0]!.ppm).toBeGreaterThan(out[1]!.ppm);
  });
  it('carry nothing over a blocked pair (the universe blocks a pair if either side embargoes the other)', () => {
    expect(migrationFlows(planets, attract, travel, (a, b) => a === 'poor' && b === 'rich')).toEqual([]);
  });
  it('are deterministic', () => {
    expect(migrationFlows(planets, attract, travel, open)).toEqual(migrationFlows(planets, attract, travel, open));
  });
});

describe('moving people between demographies', () => {
  const helion = DEFAULT_WORLD.planets[0]!;
  const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0);

  it('conserves people: what leaves the origin is what the destination gains', () => {
    const from = initDemography(helion);
    const to = initDemography(DEFAULT_WORLD.planets[1]!);
    const before = totalPpm(from) + totalPpm(to);
    const taken = removeMigrants(from, 33_333_333);
    expect(taken).toBe(33_333_333);
    expect(from.workingAge).toBe(1_650 * PPM - taken);
    expect(sum(from.households)).toBe(totalPpm(from));
    addMigrants(to, taken);
    expect(sum(to.households)).toBe(totalPpm(to));
    expect(totalPpm(from) + totalPpm(to)).toBe(before);
  });
  it('takes from households in proportion to size and never below zero', () => {
    const d = initDemography(helion);
    const shift = Math.floor(d.households[1]! / 2);
    d.households[0] = d.households[0]! + shift;
    d.households[1] = d.households[1]! - shift;
    const before = [...d.households];
    removeMigrants(d, 10 * PPM);
    expect(before[0]! - d.households[0]!).toBeGreaterThan(before[1]! - d.households[1]!);
    expect(d.households.every((h) => h >= 0)).toBe(true);
  });
  it('settles newcomers toward smaller and better-fed households', () => {
    const d = initDemography(helion);
    d.households[0] = d.households[0]! * 2;
    d.households[1] = d.households[1]! - (d.households[0]! / 2);
    d.securityBp[2] = 2_000;
    const before = [...d.households];
    addMigrants(d, 60 * PPM);
    const gain = d.households.map((h, i) => h - before[i]!);
    expect(gain[1]!).toBeGreaterThan(gain[0]!); // smaller beats larger
    expect(gain[3]!).toBeGreaterThan(gain[2]!); // well fed beats hungry (same size)
    expect(sum(gain)).toBe(60 * PPM);
  });
  it('records each household food security when the demography steps', () => {
    const d = initDemography(helion);
    stepDemography(d, d.households.map((_, i) => ({ needed: 10, unmet: i === 0 ? 5 : 0 })));
    expect(d.securityBp[0]).toBe(5_000);
    expect(d.securityBp[1]).toBe(10_000);
  });
});

async function run(u: Universe, n: number): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < n; i++) out.push(await u.step());
  return out;
}

describe('Universe migration', () => {
  it('moves people between planets, with groups in transit and a system event, and balances the books', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    const reports = await run(universe, 60);
    const moved = reports.flatMap((r) => Object.values(r.metrics)).reduce((s, m) => s + m.emigrants, 0);
    expect(moved).toBeGreaterThan(0);
    const snap = await universe.snapshot({ series: [] });
    const net = reports.flatMap((r) => Object.values(r.metrics)).reduce((s, m) => s + m.netMigration, 0);
    const inTransit = snap.migrants.reduce((s, g) => s + g.people, 0);
    expect(Math.abs(net + inTransit)).toBeLessThanOrEqual(8); // every departure and arrival is rounded to whole people
    for (const r of reports) for (const m of Object.values(r.metrics)) expect(m.netMigration).toBe(m.immigrants - m.emigrants);
    for (const g of snap.migrants) expect(g.arriveCycle).toBeGreaterThan(snap.cycle);
  }, 60_000);

  it('is deterministic', async () => {
    const a = makeUniverse(); const b = makeUniverse();
    await a.universe.init(); await b.universe.init();
    expect(await run(b.universe, 40)).toEqual(await run(a.universe, 40));
  }, 60_000);

  it('feeds migration into labour input (working-age people)', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    const reports = await run(universe, 60);
    const first = reports[0]!.metrics, last = reports[59]!.metrics;
    const verdan = (m: typeof first) => m['verdan']!.workingAge;
    const helion = (m: typeof first) => m['helion']!.workingAge;
    expect(verdan(last) - verdan(first)).toBeGreaterThan(helion(last) - helion(first));
  }, 60_000);

  it('does not move anyone between planets that embargo each other', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    universe.enqueue({ kind: 'embargo', planet: 'helion', target: 'verdan', active: true }, { sub: 't' });
    universe.enqueue({ kind: 'embargo', planet: 'helion', target: 'tethys', active: true }, { sub: 't' });
    universe.enqueue({ kind: 'embargo', planet: 'verdan', target: 'tethys', active: true }, { sub: 't' });
    const reports = await run(universe, 60);
    for (const r of reports) for (const m of Object.values(r.metrics)) expect(m.emigrants + m.immigrants).toBe(0);
    expect((await universe.snapshot({ series: [] })).migrants).toEqual([]);
  }, 60_000);

  it('forks the in-transit migrants', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    let guard = 0;
    while ((await universe.snapshot({ series: [] })).migrants.length === 0 && guard++ < 40) await universe.step();
    const before = await universe.snapshot({ series: [] });
    expect(before.migrants.length).toBeGreaterThan(0);
    const fork = await universe.fork('u0-f1');
    expect({ ...(await fork.snapshot({ series: [] })), universeId: before.universeId }).toEqual(before);
    expect(await run(fork, 15)).toEqual(await run(universe, 15));
    expect((await fork.snapshot({ series: [] })).migrants).toEqual((await universe.snapshot({ series: [] })).migrants);
  }, 60_000);
});

describe('exodus detector', () => {
  const pol = (): PolicyState => ({ tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 });
  const feed = (d: Detectors, cycle: number, netMigration: number, population = 1_000) =>
    d.observe({ cycle, metrics: { helion: { gdp: 1, consumerConfidence: 50, businessConfidence: 50, population, netMigration } }, policies: { helion: pol() }, fx: [], arrivals: [] });

  it('fires when net outflow over 50 cycles exceeds 5% of the population, then cools down', () => {
    const d = new Detectors({ warmupCycles: 0 });
    const fired: number[] = [];
    for (let c = 0; c < 120; c++) for (const e of feed(d, c, c % 5 === 0 ? -10 : 0)) { expect(e.detector).toBe('exodus'); fired.push(c); }
    // -10 every 5 cycles: 100 people (10%) per 50 cycles; crosses 5% (> 50) at the 6th departure (cycle 25)
    expect(fired[0]).toBe(25);
    expect(fired.length).toBeGreaterThan(1);
    for (let i = 1; i < fired.length; i++) expect(fired[i]! - fired[i - 1]!).toBeGreaterThanOrEqual(25);
  });
  it('stays quiet below the threshold, for inflows, and when departures fall out of the window', () => {
    const d = new Detectors({ warmupCycles: 0 });
    const out = [];
    for (let c = 0; c < 200; c++) out.push(...feed(d, c, c % 5 === 0 ? -4 : 0)); // 40 per 50 cycles = 4%
    for (let c = 200; c < 300; c++) out.push(...feed(d, c, c % 5 === 0 ? 30 : 0));
    expect(out).toEqual([]);
  });
  it('keeps its state in getState/setState', () => {
    const a = new Detectors({ warmupCycles: 0 });
    for (let c = 0; c < 24; c++) feed(a, c, c % 5 === 0 ? -10 : 0);
    const b = new Detectors({ warmupCycles: 0 });
    b.setState(a.getState());
    expect(b.getState()).toEqual(a.getState());
    expect(feed(b, 25, -10).length).toBe(1);
    expect(feed(a, 25, -10).length).toBe(1);
    new Detectors().setState({ ...a.getState(), mig: undefined } as never); // an older state without the field still loads
  });
});
