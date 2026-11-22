import type { AgentDecision, AgentTask, GodModeCommand, Loan } from '@orbital/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESERVE_BANK_CONFIG, RandomValidPolicy, Universe } from '../src/index.js';
import type { CycleReport, DecisionProvider } from '../src/index.js';
import { makeUniverse } from './helpers.js';

// Build plan, Phase 4 exit test: "each god-mode event visibly changes the metrics it should". Every event is compared
// against a control fork taken at the same cycle (fork the warmed base twice, apply the command to only one).

/** RandomValidPolicy that also records every loan its agents see. */
class SpyPolicy implements DecisionProvider {
  readonly loans: Map<string, Loan>;
  constructor(readonly inner: RandomValidPolicy, loans = new Map<string, Loan>()) {
    this.loans = loans;
  }
  async decideAll(tasks: AgentTask[]): Promise<AgentDecision[]> {
    for (const t of tasks) for (const l of t.observation.loans) this.loans.set(l.id, l);
    return this.inner.decideAll(tasks);
  }
  fork(): SpyPolicy {
    return new SpyPolicy(this.inner.fork());
  }
}

const WARM = 30;
const N = 25;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

let base: Universe;
let spy: SpyPolicy;
let control: CycleReport[];
const log = (label: string, treated: unknown, ctl: unknown) => console.log(`[god-mode] ${label}: treated=${JSON.stringify(treated)} control=${JSON.stringify(ctl)}`);

async function run(u: Universe, n: number, onCycle?: (r: CycleReport) => Promise<void> | void): Promise<CycleReport[]> {
  const out: CycleReport[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await u.step());
    await onCycle?.(out[i]!);
  }
  return out;
}

/** Forks the warmed base, applies the commands, runs N cycles. */
async function treat(id: string, ...commands: GodModeCommand[]) {
  const u = await base.fork(id);
  for (const c of commands) u.enqueue(c, { sub: 'op' });
  const reports = await run(u, N);
  return { u, reports };
}

/** Shipments in flight at the fork point (departed before WARM) that arrive in the control run: identical in every fork. */
function inFlightAtFork(): { from: string; to: string; good: string; qty: number }[] {
  return control.flatMap((r) =>
    r.arrivals.filter((a) => a.shipment.departCycle < WARM).flatMap((a) => a.delivered.map((c) => ({ from: a.shipment.from, to: a.shipment.to, good: c.good, qty: c.qty }))));
}

beforeAll(async () => {
  const { world, ledger } = makeUniverse();
  spy = new SpyPolicy(new RandomValidPolicy(world, world.seed));
  // Shock effects are measured against a control fork; migration would move workers between them and blur the ratios.
  base = new Universe({ world, ledger, agents: spy, migration: false });
  await base.init();
  await run(base, WARM);
  control = await run(await base.fork('control'), N);
}, 30_000);

describe('god mode: each event visibly changes the metrics it should', () => {
  it('drought -50% on verdan grain halves production and raises CPI', async () => {
    const { u, reports } = await treat('drought', { kind: 'shock', planet: 'verdan', shock: 'drought', good: 'grain', magnitudeBp: -5_000, durationCycles: N });
    const p = sum(reports.map((r) => r.produced.verdan!.grain ?? 0)), c = sum(control.map((r) => r.produced.verdan!.grain ?? 0));
    const price = (rs: CycleReport[]) => sum(rs.slice(-10).map((r) => r.metrics.verdan!.cpi));
    const snap = await u.snapshot({ series: [] });
    log('drought', { grain: p, cpi10: price(reports), price: snap.planets[1]!.prices.grain }, { grain: c, cpi10: price(control) });
    expect(p / c).toBeGreaterThan(0.4);
    expect(p / c).toBeLessThan(0.6);
    expect(price(reports)).toBeGreaterThan(price(control));
    // Mean (not sum) clearing price: treated and control runs clear on different numbers of cycles.
    const meanPrice = (rs: CycleReport[]) => {
      const ps = rs.slice(-10).flatMap((r) => r.auctions.filter((a) => a.planet === 'verdan' && a.good === 'grain' && a.clearingPrice !== null).map((a) => a.clearingPrice!));
      return sum(ps) / ps.length;
    };
    const priceTreated = meanPrice(reports), priceControl = meanPrice(control);
    // Logged only: stub agents price around a random reference, not from supply, so the grain price barely moves
    // (TODO.md: re-check with Track B agents). CPI and production are the asserted metrics.
    log('drought grain mean clearing price, last 10 cycles', priceTreated, priceControl);
  }, 30_000);

  it('windfall +50% on verdan grain raises production', async () => {
    const { reports } = await treat('windfall', { kind: 'shock', planet: 'verdan', shock: 'windfall', good: 'grain', magnitudeBp: 5_000, durationCycles: N });
    const p = sum(reports.map((r) => r.produced.verdan!.grain ?? 0)), c = sum(control.map((r) => r.produced.verdan!.grain ?? 0));
    log('windfall', p, c);
    expect(p / c).toBeGreaterThan(1.3);
    expect(p / c).toBeLessThan(1.7);
  }, 30_000);

  it('demand_surge doubles verdan water need and raises unmet need', async () => {
    const { reports } = await treat('surge', { kind: 'shock', planet: 'verdan', shock: 'demand_surge', good: 'water', magnitudeBp: 10_000, durationCycles: N });
    const p = sum(reports.map((r) => r.unmet.verdan!.water ?? 0)), c = sum(control.map((r) => r.unmet.verdan!.water ?? 0));
    log('demand_surge unmet water', p, c);
    expect(p).toBeGreaterThan(c);
  }, 30_000);

  it('expired shocks are dropped: a 5-cycle drought leaves production normal afterwards', async () => {
    const { reports } = await treat('short', { kind: 'shock', planet: 'verdan', shock: 'strike', good: 'grain', magnitudeBp: -10_000, durationCycles: 5 });
    const g = (rs: CycleReport[], a: number, b: number) => sum(rs.slice(a, b).map((r) => r.produced.verdan!.grain ?? 0));
    expect(g(reports, 0, 5)).toBe(0);
    expect(g(reports, 10, N)).toBeGreaterThan(0);
  }, 30_000);

  it('tariff on a good imported into a planet collects duty in its treasury', async () => {
    const flows = inFlightAtFork();
    expect(flows.length).toBeGreaterThan(0);
    const top = flows.sort((a, b) => b.qty - a.qty)[0]!;
    const { reports } = await treat('tariff', { kind: 'tariff', planet: top.to, good: top.good, rateBp: 3_000 });
    const duty = (rs: CycleReport[]) => sum(rs.flatMap((r) => r.arrivals.filter((a) => a.shipment.to === top.to).map((a) => a.duty.amount)));
    log(`tariff 30% on ${top.good} into ${top.to}`, duty(reports), duty(control));
    expect(duty(control)).toBe(0);
    expect(duty(reports)).toBeGreaterThan(0);
  }, 30_000);

  it('embargo withholds arrivals from the target', async () => {
    const top = inFlightAtFork().sort((a, b) => b.qty - a.qty)[0]!;
    const { reports } = await treat('embargo', { kind: 'embargo', planet: top.to, target: top.from, active: true });
    const from = (rs: CycleReport[], key: 'delivered' | 'withheld') =>
      sum(rs.flatMap((r) => r.arrivals.filter((a) => a.shipment.to === top.to && a.shipment.from === top.from).map((a) => sum(a[key].map((c) => c.qty)))));
    log(`embargo ${top.to} vs ${top.from}`, { delivered: from(reports, 'delivered'), withheld: from(reports, 'withheld') }, { delivered: from(control, 'delivered'), withheld: from(control, 'withheld') });
    expect(from(control, 'delivered')).toBeGreaterThan(0);
    expect(from(reports, 'delivered')).toBe(0);
    expect(from(reports, 'withheld')).toBeGreaterThan(0);
  }, 30_000);

  it('policy_rate 400bp sticks for 20 cycles and new loans carry it', async () => {
    const u = await base.fork('rate');
    u.enqueue({ kind: 'policy_rate', planet: 'helion', rateBp: 400 }, { sub: 'op' });
    const rates: number[] = [];
    for (let i = 0; i < RESERVE_BANK_CONFIG.overrideCycles; i++) {
      await u.step();
      rates.push((await u.snapshot({ series: [] })).planets[0]!.policy.policyRateBp);
    }
    const loans = [...(u as unknown as { provider: SpyPolicy }).provider.loans.values()].filter((l) => l.planet === 'helion' && l.issuedCycle >= WARM);
    log('policy_rate', { rates: [...new Set(rates)], newLoans: loans.length, loanRates: [...new Set(loans.map((l) => l.rateBp))] }, 'n/a');
    expect(rates.every((r) => r === 400)).toBe(true);
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((l) => l.rateBp === 400)).toBe(true);
    // the rule resumes afterwards: by the next review it moves the rate off 400
    for (let i = 0; i < 2 * RESERVE_BANK_CONFIG.intervalCycles; i++) await u.step();
    expect((await u.snapshot({ series: [] })).planets[0]!.policy.policyRateBp).not.toBe(400);
  }, 30_000);

  it('every applied command produces a tagged SimEvent; invalid commands are rejected at enqueue', async () => {
    const u = await base.fork('events');
    u.enqueue({ kind: 'shock', planet: 'tethys', shock: 'blight', good: 'iron', magnitudeBp: -2_000, durationCycles: 3 }, { sub: 'op' });
    u.enqueue({ kind: 'tariff', planet: 'helion', good: 'grain', rateBp: 500 }, { sub: 'op' });
    u.enqueue({ kind: 'embargo', planet: 'tethys', target: 'verdan', active: true }, { sub: 'op' });
    u.enqueue({ kind: 'policy_rate', planet: 'verdan', rateBp: 123 }, { sub: 'op' });
    expect(() => u.enqueue({ kind: 'tariff', planet: 'nowhere', good: 'iron', rateBp: 1 }, { sub: 'op' })).toThrow(/planet/);
    expect(() => u.enqueue({ kind: 'tariff', planet: 'helion', good: 'gold', rateBp: 1 }, { sub: 'op' })).toThrow(/good/);
    expect(() => u.enqueue({ kind: 'embargo', planet: 'helion', target: 'helion', active: true }, { sub: 'op' })).toThrow(/itself/);
    expect(await u.snapshot({ series: [] }).then((s) => s.events.filter((e) => e.text.includes('[god mode]')))).toHaveLength(0); // nothing applies before the next step
    await u.step();
    const tagged = (await u.snapshot({ series: [] })).events.filter((e) => e.text.includes('[god mode]'));
    expect(tagged.map((e) => [e.kind, e.planet, e.cycle])).toEqual([['shock', 'tethys', WARM], ['policy', 'helion', WARM], ['policy', 'tethys', WARM], ['policy', 'verdan', WARM]]);
    const snap = await u.snapshot({ series: [] });
    expect(snap.planets.find((p) => p.planet === 'tethys')!.policy.embargoes).toEqual(['verdan']);
  }, 30_000);
});

describe('detectors wired into Universe', () => {
  it('flags a trade war when two trading planets raise tariffs, and carries detector state into forks', async () => {
    const { universe } = makeUniverse();
    await universe.init();
    for (let c = 0; c < 40; c++) await universe.step();
    // Make sure both planets have imported from each other recently enough for the "on each other" check.
    const pairs = new Set<string>();
    const fork = await universe.fork('u0-det');
    for (let c = 0; c < 40; c++) {
      const r = await fork.step();
      for (const a of r.arrivals) if (a.delivered.length) pairs.add(`${a.shipment.from}>${a.shipment.to}`);
    }
    const pair = [['helion', 'verdan'], ['verdan', 'tethys'], ['helion', 'tethys']].find(([a, b]) => pairs.has(`${a}>${b}`) && pairs.has(`${b}>${a}`));
    expect(pair, "seed 42 has two-way trade between some pair").toBeDefined();
    const [a, b] = pair as [string, string];
    fork.enqueue({ kind: 'tariff', planet: a, good: 'grain', rateBp: 2000 }, { sub: 'op' });
    await fork.step();
    fork.enqueue({ kind: 'tariff', planet: b, good: 'iron', rateBp: 2000 }, { sub: 'op' });
    const r = await fork.step();
    expect(r.detected.map((d) => d.detector)).toContain('trade_war');
    const snap = await fork.snapshot({ series: [] });
    expect(snap.events.some((e) => e.kind === 'crisis' && /trade war/i.test(e.text))).toBe(true);
  }, 60_000);
});
