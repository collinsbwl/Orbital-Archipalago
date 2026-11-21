import type { AgentTask, Ledger, PlanetId, PolicyState, WorldConfig } from '@orbital/contracts';
import type { AgentInfo } from './agents.js';
import type { MarketBook } from './market-book.js';
import { A1_ALLOWED_ACTIONS } from './scheduler.js';

export interface TaskContext {
  world: WorldConfig;
  ledger: Ledger;
  book: MarketBook;
  memos: ReadonlyMap<string, string>;
  cycle: number;
}

/** Builds one cycle's tasks. Policy is read once per planet. */
export async function buildTasks(ctx: TaskContext, agents: readonly AgentInfo[]): Promise<AgentTask[]> {
  const { world, ledger, book, memos, cycle } = ctx;
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
        loans: [],
        shipments: [],
        markets: world.goods.map((g) => book.view(a.planet, g.id)),
        fx: [],
        policy,
        headlines: [],
        ...(memo !== undefined ? { memo } : {}),
      },
      allowedActions: [...A1_ALLOWED_ACTIONS],
      deadlineMs: world.cycleDeadlineMs,
    });
  }
  return tasks;
}
