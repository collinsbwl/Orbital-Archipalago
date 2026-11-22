import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import type { AgentTask, CurrencyId } from '@orbital/contracts';
import { batchesFor, longestHunger, MIGRATION_CONFIG, planMigrations } from '../src/index.js';
import type { CycleReport, Hunger, Residents } from '../src/index.js';
import { initialSupply, makeUniverse, scripted } from './helpers.js';

const world = DEFAULT_WORLD;
const ids = (planet: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `${planet}:colonist:${from + i}`);
const hungry = (list: string[], cycles: number, good = 'grain'): Map<string, Record<string, number>> => new Map(list.map((id) => [id, { [good]: cycles }]));

describe('planMigrations', () => {
  const residents: Residents = new Map([['helion', ids('helion', 30)], ['verdan', ids('verdan', 30)], ['tethys', ids('tethys', 30)]]);

  it('sends colonists hungry for long enough to the best-fed planet, a few per cycle, longest-hungry first', () => {
    // Tethys fed only half its people this cycle, so Verdan (everyone fed) is the clear pick.
    const hunger: Hunger = new Map([...hungry(ids('helion', 30), 2), ...hungry(ids('helion', 6, 10), 5)]);
    const unmet = new Map([...hungry(ids('helion', 30), 1), ...hungry(ids('tethys', 15), 1)]);
    const moves = planMigrations(world, residents, hunger, unmet);
    expect(moves.map((m) => m.agentId)).toEqual(ids('helion', MIGRATION_CONFIG.maxLeavingPerCycle, 10));
    expect(new Set(moves.map((m) => `${m.from}>${m.to}`))).toEqual(new Set(['helion>verdan']));
    expect(moves[0]).toMatchObject({ hungerCycles: 5, hungryFor: ['grain'] });
  });

  it('splits migrants between equally well-fed planets, emptier first', () => {
    const starving = hungry(ids('helion', 30), 9);
    const moves = planMigrations(world, residents, starving, starving);
    expect(moves.map((m) => m.to)).toEqual(['verdan', 'tethys', 'verdan', 'tethys']);
  });

  it('stays put when nowhere is clearly better fed, and never empties a planet below the floor', () => {
    const everyoneHungry = hungry([...ids('helion', 30), ...ids('verdan', 30), ...ids('tethys', 30)], 9);
    expect(planMigrations(world, residents, everyoneHungry, everyoneHungry)).toEqual([]);

    const small: Residents = new Map([['helion', ids('helion', MIGRATION_CONFIG.minPopulation + 1)], ['verdan', ids('verdan', 30)], ['tethys', ids('tethys', 30)]]);
    const starving = hungry(ids('helion', 6), 9);
    expect(planMigrations(world, small, starving, starving)).toHaveLength(1);
  });

  it('respects the destination cap', () => {
    const full: Residents = new Map([['helion', ids('helion', 30)], ['verdan', ids('verdan', 90)], ['tethys', ids('tethys', 30)]]);
    const starving = hungry([...ids('helion', 30), ...ids('tethys', 30)], 9);
    // Verdan is at 3 x 30; Tethys is as hungry as Helion, so neither has anywhere to go.
    expect(planMigrations(world, full, starving, starving)).toEqual([]);
  });
});

describe('batchesFor', () => {
  it('scales output with the workforce, with diminishing returns, and is unchanged at the configured size', () => {
    const verdan = world.planets.find((p) => p.id === 'verdan')!;
    expect(batchesFor(verdan, 12, 30)).toBe(12);
    expect(batchesFor(verdan, 12, 60)).toBe(19); // 12 x 2^0.7
    expect(batchesFor(verdan, 12, 5)).toBe(3);
  });
});

describe('migration in a running universe', () => {
  /** Everyone passes: Helion grows no food and Tethys no grain, so their colonists starve once the starting pantry is gone. */
  async function starve(cycles: number) {
    const seen: AgentTask[][] = [];
    const agents = scripted((tasks) => { seen.push(tasks); return tasks.map((t) => ({ agentId: t.agentId, actions: [{ kind: 'pass' }], reason: 'pass', source: 'stub' as const })); });
    const { universe, ledger } = makeUniverse({ agents: { ...agents, fork: () => agents } });
    await universe.init();
    const reports: CycleReport[] = [];
    for (let i = 0; i < cycles; i++) reports.push(await universe.step()); // invariants are checked every step
    return { universe, ledger, reports, seen };
  }

  it('moves hungry colonists to the planet that feeds its people, with an exodus event and the new population', async () => {
    const { universe, reports } = await starve(12);
    const moves = reports.flatMap((r) => r.migrations);
    expect(moves.length).toBeGreaterThan(0);
    expect(new Set(moves.map((m) => m.to))).toEqual(new Set(['verdan']));
    expect(new Set(moves.map((m) => m.from))).toEqual(new Set(['helion', 'tethys']));

    const last = reports.at(-1)!.metrics;
    expect(last.verdan!.population).toBe(30 + moves.length);
    expect(last.helion!.population + last.tethys!.population).toBe(60 - moves.length);
    for (const m of moves) expect(universe.locationOf(m.agentId)).toBe('verdan');

    const snap = await universe.snapshot({ series: [] });
    expect(snap.planets.find((p) => p.planet === 'verdan')!.metrics.population).toBe(30 + moves.length);
    const exodus = snap.events.filter((e) => e.text.startsWith('Exodus: '));
    expect(exodus.length).toBeGreaterThan(0);
    expect(exodus[0]!.text).toMatch(/^Exodus: \d+ colonists? leaves? (Helion|Tethys) for Verdan \(hungry for [a-z ]+\); \w+ population \d+, Verdan \d+$/);
    expect(exodus[0]!.kind).toBe('crisis');
  });

  it('swaps savings through the treasuries without creating or destroying money', async () => {
    const { ledger, reports } = await starve(12);
    const m = reports.flatMap((r) => r.migrations)[0]!;
    // Savings at home went to the home treasury; the Verdan treasury paid the same value (parity) less the moving cost.
    expect(await ledger.getPurse(m.agentId, m.from === 'helion' ? 'HLX' : 'TTH')).toBe(0);
    expect(m.grant).toBe(Math.floor((1_000 * (10_000 - MIGRATION_CONFIG.movingCostBp)) / 10_000));
    expect(await ledger.getPurse(m.agentId, 'VRD')).toBe(m.grant);
    const supply = initialSupply(world);
    for (const p of world.planets) {
      const c = p.currency as CurrencyId;
      let total = 0;
      for (const owner of [p.id, ...world.planets.flatMap((q) => Array.from({ length: q.agents.colonist }, (_, i) => `${q.id}:colonist:${i}`)),
        ...world.planets.flatMap((q) => Array.from({ length: q.agents.trader }, (_, i) => `${q.id}:trader:${i}`)), ...world.planets.filter((q) => q.id !== p.id).map((q) => q.id)]) {
        total += await ledger.getPurse(owner, c);
      }
      expect(total).toBe(supply[c]);
    }
  });

  it('tells colonists how long they have gone hungry, and schedules migrants on their new planet', async () => {
    const { reports, seen } = await starve(12);
    const m = reports.flatMap((r) => r.migrations)[0]!;
    // A colonist moves at the earliest in the step its hunger reaches the threshold (later if nowhere was clearly better
    // fed yet), so the last task it saw at home showed at least one less.
    const before = seen.flat().filter((t) => t.agentId === m.agentId && t.planet === m.from);
    expect(Math.max(...before.map((t) => longestHunger(t.observation.hunger)))).toBeGreaterThanOrEqual(MIGRATION_CONFIG.hungerToLeave - 1);
    const after = seen.at(-1)!.find((t) => t.agentId === m.agentId)!;
    expect(after.planet).toBe('verdan');
    expect(after.observation.purse.VRD).toBe(m.grant);
  });

  it('forks copy where colonists live and how hungry they are', async () => {
    const { universe, reports } = await starve(12);
    const moved = reports.flatMap((r) => r.migrations)[0]!.agentId;
    const stayed = universe.residents().get('helion')![0]!;
    const fork = await universe.fork('u0-f1');
    expect(fork.locationOf(moved)).toBe('verdan');
    expect(fork.residents()).toEqual(universe.residents());
    expect(fork.hungerOf(stayed)).toEqual(universe.hungerOf(stayed));
  });

  it('can be switched off', async () => {
    const { universe } = makeUniverse({ migration: false, agents: scripted((tasks) => tasks.map((t) => ({ agentId: t.agentId, actions: [{ kind: 'pass' }], reason: 'pass', source: 'stub' as const }))) });
    await universe.init();
    for (let i = 0; i < 12; i++) expect((await universe.step()).migrations).toEqual([]);
    expect(universe.residents().get('helion')).toHaveLength(30);
  });
});
