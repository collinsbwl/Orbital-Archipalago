import type { AuctionResult, Ledger, WorldConfig } from '@orbital/contracts';
import { listAgents } from './agents.js';
import type { AgentInfo, DecisionProvider } from './agents.js';
import { bootstrap } from './bootstrap.js';
import { MarketBook } from './market-book.js';
import { buildTasks } from './observation.js';
import { runConsumption } from './phases/consumption.js';
import { runProduction } from './phases/production.js';
import type { Counts } from './phases/production.js';
import { schedule } from './scheduler.js';
import { validateDecisions } from './validator.js';

/** Plain data, JSON-safe. */
export interface CycleReport {
  cycle: number;
  auctions: AuctionResult[];
  produced: Counts;
  unmet: Counts;
  rejections: number;
  placeOrdersRejected: number;
}

export interface UniverseOptions {
  world: WorldConfig;
  ledger: Ledger;
  agents: DecisionProvider;
  /** Throw if `ledger.checkInvariants()` fails after a cycle. Default true. */
  checkInvariants?: boolean;
}

export class Universe {
  readonly book = new MarketBook();
  private readonly world: WorldConfig;
  private readonly ledger: Ledger;
  private readonly provider: DecisionProvider;
  private readonly check: boolean;
  private readonly roster: AgentInfo[];
  private readonly goods: Set<string>;
  private readonly memos = new Map<string, string>();
  private _cycle = 0;

  constructor(opts: UniverseOptions) {
    this.world = opts.world;
    this.ledger = opts.ledger;
    this.provider = opts.agents;
    this.check = opts.checkInvariants ?? true;
    this.roster = listAgents(opts.world);
    this.goods = new Set(opts.world.goods.map((g) => g.id));
  }

  get cycle(): number {
    return this._cycle;
  }

  async init(): Promise<void> {
    await bootstrap(this.world, this.ledger);
  }

  async step(): Promise<CycleReport> {
    const { world, ledger, book } = this;
    const cycle = this._cycle;

    const produced = await runProduction(world, ledger, cycle);
    const unmet = await runConsumption(world, ledger);

    const due = schedule(this.roster, cycle);
    const tasks = await buildTasks({ world, ledger, book, memos: this.memos, cycle }, due);
    const raw = await this.provider.decideAll(tasks);
    const { decisions, rejections } = validateDecisions(raw, tasks, book, this.goods);

    // Settle: cancels first, then all orders in deterministic agent order.
    for (const d of decisions) {
      if (d.memo !== undefined) this.memos.set(d.agentId, d.memo);
      for (const id of d.cancels) {
        await ledger.cancelOrder(id);
        book.remove(id);
      }
    }
    const orders = decisions.flatMap((d) => d.orders);
    const placed = await ledger.placeOrders(orders, cycle);
    for (const a of placed.accepted) {
      book.add({ ...(orders[a.index] as (typeof orders)[number]), orderId: a.orderId, cycle });
    }

    const auctions: AuctionResult[] = [];
    for (const p of world.planets) {
      for (const g of world.goods) {
        const r = await ledger.clearLocalAuction(p.id, g.id, cycle);
        book.applyAuction(r);
        auctions.push(r);
      }
    }

    if (this.check) {
      const inv = await ledger.checkInvariants();
      if (!inv.ok) throw new Error(`invariants violated at cycle ${cycle}: ${JSON.stringify(inv.violations)}`);
    }

    this._cycle++;
    return { cycle, auctions, produced, unmet, rejections: rejections.length, placeOrdersRejected: placed.rejected.length };
  }
}
