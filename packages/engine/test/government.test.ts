import { describe, expect, it } from 'vitest';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import {
  GOVERNMENT_ACTIONS, GOVERNMENT_SCHEDULE, MAX_AGENT_TARIFF_BP, MarketBook, allowedActionsFor, listAgents, schedule, validateDecisions,
} from '../src/index.js';
import { makeUniverse, scripted } from './helpers.js';

const known = { goods: new Set(['iron', 'grain']), planets: new Set(['helion', 'verdan']), currencies: new Set(['HLX', 'VRD']) };
const task = (agentId: string, role: AgentTask['role']): AgentTask => ({
  universeId: 'u0', cycle: 10, agentId, role, planet: 'helion',
  observation: { purse: {}, inventory: {}, openOrders: [], loans: [], shipments: [], markets: [], fx: [], policy: { tariffsBp: {}, quotas: {}, embargoes: [], policyRateBp: 0 }, headlines: [] },
  allowedActions: allowedActionsFor(role), deadlineMs: 1000,
});
const dec = (agentId: string, actions: AgentDecision['actions']): AgentDecision => ({ agentId, actions, reason: 'x', source: 'stub' });

describe('government scheduling', () => {
  it('schedules governments only on review cycles, with trade-policy actions', () => {
    const { world } = makeUniverse();
    const roster = listAgents(world);
    const govs = (cycle: number) => schedule(roster, cycle, new Map()).filter((a) => a.role === 'government');
    expect(govs(0)).toHaveLength(0);
    expect(govs(GOVERNMENT_SCHEDULE.warmupCycles + 1)).toHaveLength(0);
    expect(govs(GOVERNMENT_SCHEDULE.intervalCycles * 2)).toHaveLength(world.planets.length);
    expect(allowedActionsFor('government')).toEqual(GOVERNMENT_ACTIONS);
    expect(GOVERNMENT_ACTIONS).not.toContain('set_policy_rate');
  });
});

describe('validateDecisions for policy actions', () => {
  const book = new MarketBook();

  it('turns government actions into planet-scoped policy instructions', () => {
    const r = validateDecisions([
      dec('g', [
        { kind: 'set_tariff', good: 'iron', rateBp: 500 },
        { kind: 'set_embargo', target: 'verdan', active: false },
        { kind: 'set_quota', good: 'grain', maxPerCycle: 10 },
      ]),
    ], [task('g', 'government')], book, known);
    expect(r.rejections).toEqual([]);
    expect(r.decisions[0]!.policies).toEqual([
      { kind: 'set_tariff', planet: 'helion', good: 'iron', rateBp: 500 },
      { kind: 'set_embargo', planet: 'helion', target: 'verdan', active: false },
      { kind: 'set_quota', planet: 'helion', good: 'grain', maxPerCycle: 10 },
    ]);
  });

  it('rejects tariffs over the cap, self-embargoes, unknown goods and the policy rate', () => {
    const r = validateDecisions([
      dec('g', [
        { kind: 'set_tariff', good: 'iron', rateBp: MAX_AGENT_TARIFF_BP + 1 },
        { kind: 'set_embargo', target: 'helion', active: true },
        { kind: 'set_tariff', good: 'gold', rateBp: 100 },
        { kind: 'set_policy_rate', rateBp: 300 },
      ]),
    ], [task('g', 'government')], book, known);
    expect(r.rejections.map((x) => x.reason)).toEqual(['tariff_cap', 'embargo_self', 'unknown_good', 'not_allowed']);
    expect(r.decisions[0]!.policies).toEqual([]);
  });

  it('colonists cannot set policy', () => {
    const t = { ...task('c', 'colonist'), allowedActions: [...allowedActionsFor('colonist'), 'set_tariff' as const] };
    const r = validateDecisions([dec('c', [{ kind: 'set_tariff', good: 'iron', rateBp: 100 }])], [t], book, known);
    expect(r.rejections.map((x) => x.reason)).toEqual(['not_government']);
  });
});

describe('Universe applies government decisions', () => {
  it('sets the tariff on the ledger, logs a policy event, and briefs governments', async () => {
    const seen: AgentTask[] = [];
    const agents = scripted((tasks) =>
      tasks.map((t) => {
        if (t.role === 'government') seen.push(t);
        return t.role === 'government' && t.planet === 'helion'
          ? dec(t.agentId, [{ kind: 'set_tariff', good: 'iron', rateBp: 700 }])
          : dec(t.agentId, [{ kind: 'pass' }]);
      }),
    );
    const { universe, ledger } = makeUniverse({ agents });
    await universe.init();
    for (let c = 0; c <= GOVERNMENT_SCHEDULE.intervalCycles * 2; c++) await universe.step();
    expect((await ledger.getPolicy('helion')).tariffsBp.iron).toBe(700);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t.allowedActions.includes('set_tariff'))).toBe(true);
    expect(seen.some((t) => (t.observation.briefing ?? '').includes('CPI'))).toBe(true);
    const snap = await universe.snapshot({ series: [] });
    expect(snap.events.some((e) => e.kind === 'policy' && e.text.includes('government sets a 7% tariff on iron'))).toBe(true);
  });

  it('gives docked traders the other planets\' markets with travel time', async () => {
    let trader: AgentTask | undefined;
    const agents = scripted((tasks) => {
      trader ??= tasks.find((t) => t.role === 'trader');
      return tasks.map((t) => dec(t.agentId, [{ kind: 'pass' }]));
    });
    const { universe, world } = makeUniverse({ agents });
    await universe.init();
    await universe.step();
    expect(trader).toBeDefined();
    const others = trader!.observation.elsewhere!;
    expect(others.map((r) => r.planet).sort()).toEqual(world.planets.map((p) => p.id).filter((p) => p !== trader!.planet).sort());
    for (const r of others) {
      expect(r.travelCycles).toBeGreaterThanOrEqual(world.travel.minCycles);
      expect(r.goods).toHaveLength(world.goods.length);
    }
  });
});
