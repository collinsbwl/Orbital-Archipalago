import { describe, expect, it } from 'vitest';
import { AgentDecisionSchema, AgentTaskSchema } from '@orbital/contracts';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import type { CycleReport } from '../src/index.js';
import { makeUniverse, scripted } from './helpers.js';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { RandomValidPolicy, Universe } from '../src/index.js';
import type { DecisionProvider } from '../src/index.js';

const CYCLES = 200;

async function run(seed: number) {
  const { universe, ledger, world } = makeUniverse({ seed, checkInvariants: false });
  await universe.init();
  const reports: CycleReport[] = [];
  for (let c = 0; c < CYCLES; c++) {
    reports.push(await universe.step());
    const inv = await ledger.checkInvariants();
    expect(inv.ok, `cycle ${c}: ${JSON.stringify(inv.violations)}`).toBe(true);
  }
  return { reports, world };
}

// One shared 200-cycle run (seed 42) feeds all the assertions below; determinism re-runs it once.
const shared = { run: undefined as ReturnType<typeof run> | undefined };
const run42 = () => (shared.run ??= run(42));

describe('200-cycle run on DEFAULT_WORLD', () => {
  it('conserves goods and money, trades on every planet, and is deterministic', async () => {
    const a = await run42();
    const volume: Record<string, number> = {};
    for (const r of a.reports) for (const au of r.auctions) volume[au.planet] = (volume[au.planet] ?? 0) + au.volume;
    for (const p of a.world.planets) expect(volume[p.id], p.id).toBeGreaterThan(0);
    // The random stub is schema-valid and clips itself: validator rejections should be zero.
    expect(a.reports.reduce((s, r) => s + r.rejections, 0)).toBe(0);

    const b = await run(42);
    expect(b.reports).toEqual(a.reports);
  }, 60_000);

  it('moves freighters and clears every FX pair', async () => {
    const { reports, world } = await run42();
    const departures = reports.flatMap((r) => r.departures);
    const arrivals = reports.flatMap((r) => r.arrivals);
    expect(departures.length).toBeGreaterThan(0);
    expect(arrivals.length).toBeGreaterThan(0);
    // Every arrival happens exactly on its arriveCycle and was a departure; a shipment arrives at most once.
    const departed = new Map(departures.map((s) => [s.id, s]));
    for (const a of arrivals) expect(departed.get(a.shipment.id)?.arriveCycle).toBe(reports.find((r) => r.arrivals.includes(a))!.cycle);
    expect(new Set(arrivals.map((a) => a.shipment.id)).size).toBe(arrivals.length);

    const cleared = new Set(reports.flatMap((r) => r.fx).filter((f) => f.ratePpm !== null).map((f) => `${f.base}/${f.quote}`));
    expect([...cleared].sort()).toEqual(['HLX/TTH', 'HLX/VRD', 'VRD/TTH']);
    expect(reports.every((r) => r.fx.length === 3)).toBe(true);
    expect(reports.reduce((s, r) => s + r.ledgerRejections, 0)).toBe(0);
    expect(reports.reduce((s, r) => s + r.fxOrdersRejected, 0)).toBe(0);

    // Goods reach planets that do not produce them.
    const recipes = new Map(world.recipes.map((r) => [r.id, r.output.good]));
    const produces = new Map(world.planets.map((p) => [p.id, new Set(p.recipes.map((r) => recipes.get(r.recipe)))]));
    expect(arrivals.some((a) => a.delivered.some((c) => !produces.get(a.shipment.to)!.has(c.good)))).toBe(true);

    const exports = reports.reduce((s, r) => s + Object.values(r.tradeFlows).reduce((t, f) => t + f.exports, 0), 0);
    expect(exports).toBeGreaterThan(0);
    for (const p of world.planets) expect(reports.reduce((s, r) => s + r.tradeFlows[p.id]!.imports, 0), p.id).toBeGreaterThan(0);
  });

  it('throws when invariants fail (flag on)', async () => {
    const { universe, ledger } = makeUniverse({ agents: scripted(() => []) });
    await universe.init();
    const real = ledger.checkInvariants.bind(ledger);
    ledger.checkInvariants = async () => ({ ...(await real()), ok: false, violations: [{ code: 'x', message: 'boom' }] });
    await expect(universe.step()).rejects.toThrow(/invariants violated/);
  });
});

describe('RandomValidPolicy', () => {
  it('always emits schema-valid decisions and tasks across cycles', async () => {
    const inner = new RandomValidPolicy(makeUniverse().world, 5);
    const kinds = new Set<string>();
    const agents = scripted(() => []);
    agents.decideAll = async (tasks: AgentTask[]): Promise<AgentDecision[]> => {
      for (const t of tasks) AgentTaskSchema.parse(t);
      const out = await inner.decideAll(tasks);
      for (const d of out) {
        AgentDecisionSchema.parse(d);
        expect(d.actions.length).toBeLessThanOrEqual(7);
        for (const act of d.actions) kinds.add(act.kind);
      }
      return out;
    };
    const { universe } = makeUniverse({ agents });
    await universe.init();
    for (let i = 0; i < 30; i++) expect((await universe.step()).rejections).toBe(0);
    expect(kinds.has('ship') && kinds.has('place_fx_order')).toBe(true);
  });
});

describe('gateway cost', () => {
  it("reports the provider's running spend in snapshots and in the metrics sink", async () => {
    const world = makeUniverse().world;
    const inner = new RandomValidPolicy(world, 3);
    let spent = 0;
    const agents: DecisionProvider = {
      decideAll: async (tasks) => {
        spent += 0.25;
        return inner.decideAll(tasks);
      },
      costUsd: () => spent,
    };
    const written: number[] = [];
    const universe = new Universe({ world, ledger: new InMemoryLedger(world), agents, sink: { writeCycle: async (s) => void written.push(s.gatewayCostUsd) } });
    await universe.init();
    await universe.step();
    await universe.step();
    expect(written).toEqual([0.25, 0.5]);
    expect((await universe.snapshot({ series: [] })).gatewayCostUsd).toBe(0.5);
    // An explicit value still wins, and a provider without a meter reports 0.
    expect((await universe.snapshot({ series: [], gatewayCostUsd: 9 })).gatewayCostUsd).toBe(9);
    expect((await makeUniverse().universe.snapshot({ series: [] })).gatewayCostUsd).toBe(0);
  });
});
