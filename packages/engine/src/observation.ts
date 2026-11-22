import type { AgentId, AgentTask, GoodId, Ledger, Loan, PlanetId, PolicyState, Shipment, WorldConfig } from '@orbital/contracts';
import type { AgentInfo } from './agents.js';
import type { FxView } from './fx.js';
import type { MarketBook } from './market-book.js';
import { travelCycles } from './orbits.js';
import { allowedActionsFor } from './scheduler.js';

export interface TaskContext {
  world: WorldConfig;
  ledger: Ledger;
  book: MarketBook;
  memos: ReadonlyMap<string, string>;
  cycle: number;
  /** All currency pairs with their last non-null clearing rate. */
  fx: readonly FxView[];
  /** Engine-tracked in-flight shipments. */
  flights: readonly Shipment[];
  /** Engine-tracked open loans (outstanding > 0), in issue order. */
  loans: readonly Loan[];
  /** Governments: short per-planet briefing text built from recent metrics. */
  briefings?: ReadonlyMap<PlanetId, string>;
  /** Colonists: per need good, cycles in a row it went unmet (see `Observation.hunger`). */
  hunger?: ReadonlyMap<AgentId, Readonly<Record<GoodId, number>>>;
}

/** Builds one cycle's tasks. `agents[].planet` is where the agent acts (docked planet for traders). Policy is read once per planet. */
export async function buildTasks(ctx: TaskContext, agents: readonly AgentInfo[]): Promise<AgentTask[]> {
  const { world, ledger, book, memos, cycle, fx, flights, loans } = ctx;
  const policies = new Map<PlanetId, PolicyState>();
  const policyOf = async (p: PlanetId) => {
    let pol = policies.get(p);
    if (!pol) policies.set(p, (pol = await ledger.getPolicy(p)));
    return pol;
  };
  const currency = new Map(world.planets.map((p) => [p.id, p.currency]));
  const tasks: AgentTask[] = [];
  for (const a of agents) {
    const policy = await policyOf(a.planet);

    const purse: Record<string, number> = {};
    for (const c of currency.values()) {
      const amt = await ledger.getPurse(a.id, c);
      if (amt > 0 || c === currency.get(a.planet)) purse[c] = amt;
    }
    const inventory: Record<string, number> = {};
    for (const g of world.goods) inventory[g.id] = await ledger.getInventory(a.id, a.planet, g.id);

    const memo = memos.get(a.id);
    const elsewhere = [];
    if (a.role === 'trader') {
      for (const p of world.planets) {
        if (p.id === a.planet) continue;
        const pol = await policyOf(p.id);
        elsewhere.push({
          planet: p.id,
          travelCycles: travelCycles(world, a.planet, p.id, cycle),
          goods: world.goods.map((g) => ({ good: g.id, lastPrice: book.view(p.id, g.id).lastPrice, tariffBp: pol.tariffsBp[g.id] ?? 0 })),
        });
      }
    }
    const briefing = a.role === 'government' ? ctx.briefings?.get(a.planet) : undefined;
    const hunger = a.role === 'colonist' ? ctx.hunger?.get(a.id) : undefined;
    tasks.push({
      universeId: world.universeId,
      cycle,
      agentId: a.id,
      role: a.role,
      planet: a.planet,
      observation: {
        purse,
        inventory,
        openOrders: book.ordersOf(a.id).slice(-20).reverse(),
        loans: loans.filter((l) => l.borrower === a.id).slice(0, 10),
        shipments: flights.filter((s) => s.owner === a.id).slice(0, 10),
        markets: world.goods.map((g) => book.view(a.planet, g.id)),
        fx: fx.map((f) => ({ ...f })),
        policy,
        headlines: [],
        ...(elsewhere.length > 0 ? { elsewhere: elsewhere.slice(0, 8) } : {}),
        ...(briefing ? { briefing: briefing.slice(0, 4_000) } : {}),
        ...(memo !== undefined ? { memo } : {}),
        ...(hunger && Object.keys(hunger).length > 0 ? { hunger: { ...hunger } } : {}),
      },
      allowedActions: allowedActionsFor(a.role),
      deadlineMs: world.cycleDeadlineMs,
    });
  }
  return tasks;
}
