import type { AgentTask, Ledger, Loan, PlanetId, PolicyState, Shipment, WorldConfig } from '@orbital/contracts';
import type { AgentInfo } from './agents.js';
import type { FxView } from './fx.js';
import type { MarketBook } from './market-book.js';
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
}

/** Builds one cycle's tasks. `agents[].planet` is where the agent acts (docked planet for traders). Policy is read once per planet. */
export async function buildTasks(ctx: TaskContext, agents: readonly AgentInfo[]): Promise<AgentTask[]> {
  const { world, ledger, book, memos, cycle, fx, flights, loans } = ctx;
  const policies = new Map<PlanetId, PolicyState>();
  const currency = new Map(world.planets.map((p) => [p.id, p.currency]));
  const tasks: AgentTask[] = [];
  for (const a of agents) {
    let policy = policies.get(a.planet);
    if (!policy) policies.set(a.planet, (policy = await ledger.getPolicy(a.planet)));

    const purse: Record<string, number> = {};
    for (const c of currency.values()) {
      const amt = await ledger.getPurse(a.id, c);
      if (amt > 0 || c === currency.get(a.planet)) purse[c] = amt;
    }
    const inventory: Record<string, number> = {};
    for (const g of world.goods) inventory[g.id] = await ledger.getInventory(a.id, a.planet, g.id);

    const memo = memos.get(a.id);
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
        ...(memo !== undefined ? { memo } : {}),
      },
      allowedActions: allowedActionsFor(a.role),
      deadlineMs: world.cycleDeadlineMs,
    });
  }
  return tasks;
}
