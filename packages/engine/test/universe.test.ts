import { describe, expect, it } from 'vitest';
import { AgentDecisionSchema, AgentTaskSchema } from '@orbital/contracts';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import type { CycleReport } from '../src/index.js';
import { initialSupply, makeUniverse, scripted } from './helpers.js';
import { RandomValidPolicy } from '../src/index.js';

const CYCLES = 200;

async function run(seed: number) {
  const { universe, ledger, world } = makeUniverse({ seed, checkInvariants: false });
  await universe.init();
  const supply = initialSupply(world);
  const reports: CycleReport[] = [];
  for (let c = 0; c < CYCLES; c++) {
    reports.push(await universe.step());
    const inv = await ledger.checkInvariants();
    expect(inv.ok, `cycle ${c}: ${JSON.stringify(inv.violations)}`).toBe(true);
    expect(inv.totals.currency).toEqual(supply);
  }
  return { reports, world };
}

describe('200-cycle run on DEFAULT_WORLD', () => {
  it('conserves goods and money, trades on every planet, and is deterministic', async () => {
    const a = await run(42);
    const volume: Record<string, number> = {};
    for (const r of a.reports) for (const au of r.auctions) volume[au.planet] = (volume[au.planet] ?? 0) + au.volume;
    for (const p of a.world.planets) expect(volume[p.id], p.id).toBeGreaterThan(0);
    // The random stub is schema-valid and clips itself: validator rejections should be zero.
    expect(a.reports.reduce((s, r) => s + r.rejections, 0)).toBe(0);

    const b = await run(42);
    expect(b.reports).toEqual(a.reports);
    const c = await run(43);
    expect(c.reports).not.toEqual(a.reports);
  }, 60_000);

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
    const agents = scripted(() => []);
    agents.decideAll = async (tasks: AgentTask[]): Promise<AgentDecision[]> => {
      for (const t of tasks) AgentTaskSchema.parse(t);
      const out = await inner.decideAll(tasks);
      for (const d of out) {
        AgentDecisionSchema.parse(d);
        expect(d.actions.length).toBeLessThanOrEqual(5);
      }
      return out;
    };
    const { universe } = makeUniverse({ agents });
    await universe.init();
    for (let i = 0; i < 20; i++) expect((await universe.step()).rejections).toBe(0);
  });
});
