import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import type { WorldConfig } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import {
  DEMOGRAPHICS_CONFIG as CFG, PPM, advanceCohorts, advanceHouseholds, allocate, bootstrap, cohortFlows, initDemography, labourInput, labourMultiplierPpm,
  participationBp, runConsumption, runProduction, stepDemography, totalPpm, unmetSharePpm,
} from '../src/index.js';
import type { Cohorts } from '../src/index.js';
import { makeUniverse, scripted } from './helpers.js';

const start: Cohorts = { children: 900 * PPM, workingAge: 1_650 * PPM, retired: 450 * PPM };
const yearly = (c: Cohorts, share = 0, cycles = CFG.cyclesPerYear): Cohorts => {
  const d = { ...c };
  for (let i = 0; i < cycles; i++) advanceCohorts(d, share);
  return d;
};
const people = (c: Cohorts) => totalPpm(c) / PPM;

describe('cohort flows', () => {
  it('moves children to working age and workers to retirement at 1/years of the cohort per year', () => {
    const f = cohortFlows(start, 0);
    expect(f.toWorking).toBe(Math.round((900 * PPM) / (CFG.childYears * CFG.cyclesPerYear)));
    expect(f.toRetired).toBe(Math.round((1_650 * PPM) / (CFG.workingYears * CFG.cyclesPerYear)));
    const d = { ...start };
    const g = advanceCohorts(d, 0);
    expect(d.children).toBe(start.children + g.births - g.toWorking - g.deathsChildren);
    expect(d.workingAge).toBe(start.workingAge + g.toWorking - g.toRetired - g.deathsWorking);
    expect(d.retired).toBe(start.retired + g.toRetired - g.deathsRetired);
    expect(totalPpm(d) - totalPpm(start)).toBe(g.births - g.deathsChildren - g.deathsWorking - g.deathsRetired); // aging moves people, never creates them
  });

  it('births come from the working-age cohort and deaths from each cohort at its own rate', () => {
    const f = cohortFlows(start, 0);
    expect(f.births).toBe(Math.round((1_650 * PPM * CFG.birthRatePpm) / (PPM * CFG.cyclesPerYear)));
    expect(f.deathsRetired).toBeGreaterThan(f.deathsWorking);
    expect(f.deathsWorking).toBeGreaterThan(f.deathsChildren);
  });

  it('keeps sub-person flows by counting in ppm: a cohort of 3 still ages over a year', () => {
    const tiny: Cohorts = { children: 3 * PPM, workingAge: 0, retired: 0 };
    const one = cohortFlows(tiny, 0);
    expect(one.toWorking).toBeGreaterThan(0);
    expect(one.toWorking).toBeLessThan(PPM / 100); // well under one person a cycle
    const d = { ...tiny };
    for (let i = 0; i < 200; i++) advanceCohorts(d, 0);
    expect(d.workingAge).toBeGreaterThan(PPM / 2); // ... but half a person has accumulated after 200 cycles
    expect(Object.values(d).every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
  });

  it('grows the default population about 0.5-1.5% a year when needs are met', () => {
    const after = yearly(start, 0, CFG.cyclesPerYear * 4);
    const rate = Math.pow(people(after) / people(start), 1 / 4) - 1;
    expect(rate).toBeGreaterThan(0.005);
    expect(rate).toBeLessThan(0.015);
  });

  it('unmet needs lower births and raise deaths', () => {
    const ok = cohortFlows(start, 0);
    const half = cohortFlows(start, PPM / 2);
    const all = cohortFlows(start, PPM);
    expect(half.births).toBe(Math.round(ok.births / 2));
    expect(all.births).toBe(0);
    expect(half.deathsRetired).toBeGreaterThan(ok.deathsRetired);
    expect(all.deathsRetired).toBe(Math.round(ok.deathsRetired * (1 + CFG.unmetDeathMultiple)));
    expect(people(yearly(start, PPM))).toBeLessThan(people(start));
    expect(people(yearly(start, 0))).toBeGreaterThan(people(start));
  });

  it('never lets a cohort go negative, even when starved for a long time', () => {
    const d = { ...start };
    for (let i = 0; i < 2_000; i++) advanceCohorts(d, PPM);
    expect(Object.values(d).every((v) => v >= 0)).toBe(true);
  });
});

describe('household allocation', () => {
  it('sums exactly to the total and is deterministic', () => {
    const w = [100, 250, 3, 77, 1_000_003];
    for (const total of [0, 1, 7, 999, 1_234_567, 987_654_321_012]) {
      const a = allocate(total, w);
      expect(a.reduce((s, x) => s + x, 0)).toBe(total);
      expect(allocate(total, w)).toEqual(a);
    }
  });

  it('is proportional to the weights and gives remainders to the largest fractions, ties to the lower index', () => {
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(10, [3, 1, 0])).toEqual([8, 2, 0]);
    expect(allocate(5, [0, 0])).toEqual([0, 0]);
  });

  it('splits deaths by size and births by size x food security, keeping the total exact', () => {
    const hh = [100 * PPM, 100 * PPM, 200 * PPM];
    const before = hh.reduce((s, x) => s + x, 0);
    advanceHouseholds(hh, 40_000, 20_000, [{ needed: 10, unmet: 0 }, { needed: 10, unmet: 10 }, { needed: 10, unmet: 0 }]);
    expect(hh.reduce((s, x) => s + x, 0)).toBe(before + 20_000);
    // The household that went hungry (index 1) gets fewer births than its identical twin (index 0).
    expect(hh[0]! - 100 * PPM).toBeGreaterThan(hh[1]! - 100 * PPM);
    expect(hh[2]).toBeGreaterThan(hh[0]!);
  });

  it('keeps households summing to the cohorts through many cycles of stepDemography', () => {
    const planet = DEFAULT_WORLD.planets[0]!;
    const d = initDemography(planet);
    expect(d.households.reduce((s, x) => s + x, 0)).toBe(totalPpm(d));
    for (let i = 0; i < 300; i++) {
      const loads = d.households.map((_, k) => ({ needed: 2, unmet: (i + k) % 3 === 0 ? 1 : 0 }));
      stepDemography(d, loads);
      expect(d.households.reduce((s, x) => s + x, 0)).toBe(totalPpm(d));
      expect(d.households.every((x) => x >= 0)).toBe(true);
    }
    expect(d.households.some((x) => x !== d.households[0])).toBe(true); // sizes diverge
  });
});

describe('labour', () => {
  it('multiplier is exactly 1 when labour is at L0, and follows (L/L0)^(1-alpha)', () => {
    expect(labourMultiplierPpm(1_320, 1_320)).toBe(PPM);
    expect(labourMultiplierPpm(0, 0)).toBe(PPM);
    expect(labourMultiplierPpm(2_640, 1_320)).toBe(Math.round(Math.pow(2, 0.7) * PPM));
    expect(labourMultiplierPpm(660, 1_320)).toBeLessThan(PPM);
  });

  it('is working-age people x participation x hours, and participation falls with unmet needs and low confidence', () => {
    const base = CFG.baseParticipationBp;
    expect(participationBp(0, 50, true)).toBe(base);
    expect(participationBp(0, 80, true)).toBe(base);
    expect(participationBp(PPM / 2, 50, true)).toBeLessThan(base);
    expect(participationBp(0, 20, true)).toBeLessThan(base);
    expect(participationBp(PPM, 0, true)).toBeGreaterThanOrEqual(0);
    expect(participationBp(PPM, 0, false)).toBe(base); // static demographics: no feedback
    expect(labourInput(start, base)).toBe(1_320);
  });

  it('unmetSharePpm is unmet over needed units', () => {
    expect(unmetSharePpm([])).toBe(0);
    expect(unmetSharePpm([{ needed: 10, unmet: 5 }, { needed: 10, unmet: 0 }])).toBe(250_000);
  });
});

describe('start-neutral', () => {
  it('initDemography: DEFAULT_WORLD planets start at 900/1650/450 in 30 equal households; an unconfigured planet is all working-age', () => {
    const d = initDemography(DEFAULT_WORLD.planets[0]!);
    expect([d.children, d.workingAge, d.retired]).toEqual([900 * PPM, 1_650 * PPM, 450 * PPM]);
    expect(d.households).toHaveLength(30);
    expect(new Set(d.households)).toEqual(new Set([100 * PPM]));
    expect(d.l0).toBe(1_320);
    const bare = initDemography({ ...DEFAULT_WORLD.planets[0]!, population: undefined } as never);
    expect([bare.children, bare.workingAge, bare.retired]).toEqual([0, 30 * PPM, 0]);
    expect(bare.dynamic).toBe(false);
  });

  it('consumption: cycle-0 needs and unmet match the headcount model (and the loads sum to today\'s need)', async () => {
    const run = async (withHouseholds: boolean) => {
      const ledger = new InMemoryLedger(DEFAULT_WORLD);
      await bootstrap(DEFAULT_WORLD, ledger);
      const loads = new Map();
      const households = new Map(DEFAULT_WORLD.planets.map((p) => { const d = initDemography(p); return [p.id, { sizesPpm: d.households, avgPpm: d.avgHouseholdPpm }]; }));
      const unmet = await runConsumption(DEFAULT_WORLD, ledger, undefined, withHouseholds ? { households, loads } : undefined);
      return { unmet, loads };
    };
    const a = await run(true);
    const b = await run(false);
    expect(a.unmet).toEqual(b.unmet);
    for (const p of DEFAULT_WORLD.planets) {
      const l = a.loads.get(p.id) as { needed: number }[];
      expect(l.reduce((s, x) => s + x.needed, 0)).toBe(DEFAULT_WORLD.colonistNeeds.reduce((s, n) => s + n.qty, 0) * p.agents.colonist);
      expect(l.every((x) => x.needed === 2)).toBe(true);
    }
  });

  it('consumption: a household twice the size needs twice as much and the parts sum to the planet total, composed with needMult', async () => {
    const ledger = new InMemoryLedger(DEFAULT_WORLD);
    await bootstrap(DEFAULT_WORLD, ledger);
    const p = DEFAULT_WORLD.planets[0]!;
    const d = initDemography(p);
    const sizes = [...d.households];
    sizes[0] = 200 * PPM; sizes[1] = 0; // household 0 doubles, household 1 is empty: the planet total is unchanged
    const loads = new Map();
    await runConsumption(DEFAULT_WORLD, ledger, new Map([[`${p.id}|grain`, 1.5]]), { households: new Map([[p.id, { sizesPpm: sizes, avgPpm: d.avgHouseholdPpm }]]), loads });
    const l = loads.get(p.id) as { needed: number }[];
    expect(l[0]!.needed).toBeGreaterThanOrEqual(4); // 2x the 1 grain + 1 water base need, grain x1.5
    expect(l[1]!.needed).toBe(0);
    expect(l.reduce((s, x) => s + x.needed, 0)).toBe(Math.floor(1.5 * 30) + 30);
  });

  it('production: cycle-0 output with the default population equals a world without one (labour multiplier 1)', async () => {
    const bare: WorldConfig = { ...DEFAULT_WORLD, planets: DEFAULT_WORLD.planets.map((p) => ({ ...p, population: undefined })) as WorldConfig['planets'] };
    const a = makeUniverse({ world: DEFAULT_WORLD });
    const b = makeUniverse({ world: bare });
    await a.universe.init();
    await b.universe.init();
    const ra = await a.universe.step();
    const rb = await b.universe.step();
    expect(ra.produced).toEqual(rb.produced);
    expect(ra.unmet).toEqual(rb.unmet);
    for (const p of DEFAULT_WORLD.planets) {
      const m = ra.metrics[p.id]!;
      expect([m.children, m.workingAge, m.retired, m.population, m.labourInput, m.participationBp]).toEqual([900, 1_650, 450, 3_000, 1_320, 8_000]);
    }
    // Direct check against the phase too.
    const l = new InMemoryLedger(DEFAULT_WORLD);
    await bootstrap(DEFAULT_WORLD, l);
    expect((await runProduction(DEFAULT_WORLD, l, 0))['helion']?.['iron']).toBe(40);
  });

  it('static demographics: a world without population keeps its headcount for ever', async () => {
    const bare: WorldConfig = { ...DEFAULT_WORLD, planets: DEFAULT_WORLD.planets.map((p) => ({ ...p, population: undefined })) as WorldConfig['planets'] };
    const { universe } = makeUniverse({ world: bare });
    await universe.init();
    let last;
    for (let i = 0; i < 60; i++) last = await universe.step();
    for (const p of bare.planets) expect(last!.metrics[p.id]).toMatchObject({ population: 30, children: 0, workingAge: 30, retired: 0, participationBp: 8_000 });
  }, 30_000);
});

describe('observation', () => {
  it('gives each colonist its household size and working-age part, and nobody else', async () => {
    const seen: { role: string; household?: { size: number; workingAge?: number } }[] = [];
    const { universe } = makeUniverse({ agents: scripted((tasks) => { seen.push(...tasks.map((t) => ({ role: t.role, ...(t.observation.household ? { household: t.observation.household } : {}) }))); return []; }) });
    await universe.init();
    await universe.step();
    const colonists = seen.filter((t) => t.role === 'colonist');
    expect(colonists.length).toBeGreaterThan(0);
    for (const c of colonists) expect(c.household).toEqual({ size: 100, workingAge: 55 });
    expect(seen.filter((t) => t.role !== 'colonist').every((t) => t.household === undefined)).toBe(true);
  });
});

describe('fork', () => {
  it('copies demographics: the fork continues identically, and stepping one does not move the other', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    for (let i = 0; i < 40; i++) await universe.step();
    const fork = await universe.fork('u0-f1');
    const before = (await fork.snapshot({ series: [] })).planets.map((p) => p.metrics);
    expect(before).toEqual((await universe.snapshot({ series: [] })).planets.map((p) => p.metrics));
    expect(before[0]!.children + before[0]!.workingAge + before[0]!.retired).toBe(before[0]!.population);
    for (let i = 0; i < 30; i++) await universe.step();
    expect((await fork.snapshot({ series: [] })).planets.map((p) => p.metrics)).toEqual(before); // untouched by the original
    for (let i = 0; i < 30; i++) await fork.step();
    expect((await fork.snapshot({ series: [] })).planets.map((p) => p.metrics)).toEqual((await universe.snapshot({ series: [] })).planets.map((p) => p.metrics));
  }, 60_000);
});
