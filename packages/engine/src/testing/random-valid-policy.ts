import type { Action, AgentDecision, AgentTask, WorldConfig } from '@orbital/contracts';
import type { DecisionProvider } from '../agents.js';
import { Rng } from '../rng.js';

const MAX_QTY = 5;

/** Seeded fake agent (Track B owns the real policies): random but always schema-valid and affordable decisions. */
export class RandomValidPolicy implements DecisionProvider {
  private readonly rng: Rng;
  private readonly currency: Map<string, string>;
  private readonly basePrice: Map<string, number>;
  private readonly needs: string[];
  private readonly goods: string[];

  constructor(world: WorldConfig, seed: number) {
    this.rng = new Rng(seed);
    this.currency = new Map(world.planets.map((p) => [p.id, p.currency]));
    this.basePrice = new Map(world.goods.map((g) => [g.id, g.basePrice]));
    this.needs = world.colonistNeeds.map((n) => n.good);
    this.goods = world.goods.map((g) => g.id);
  }

  async decideAll(tasks: AgentTask[]): Promise<AgentDecision[]> {
    return tasks.map((t) => this.decide(t));
  }

  private decide(task: AgentTask): AgentDecision {
    const rng = this.rng;
    const obs = task.observation;
    const actions: Action[] = [];

    const oldest = obs.openOrders[obs.openOrders.length - 1]; // openOrders is newest first
    if (oldest && rng.next() < 0.5) actions.push({ kind: 'cancel_order', orderId: oldest.orderId });

    let purse = obs.purse[this.currency.get(task.planet) as string] ?? 0;
    const held = new Map(Object.entries(obs.inventory));
    const marketOf = new Map(obs.markets.map((m) => [m.good, m]));

    for (let n = rng.int(0, 3); n > 0; n--) {
      const preferNeed = task.role === 'colonist' && this.needs.length > 0 && rng.next() < 0.6;
      const sellable = this.goods.filter((g) => (held.get(g) ?? 0) > 0);
      if (!preferNeed && sellable.length > 0 && rng.next() < 0.5) {
        const good = rng.pick(sellable);
        const qty = rng.int(1, Math.min(held.get(good) as number, MAX_QTY));
        actions.push({ kind: 'place_order', good, side: 'sell', qty, limitPrice: this.limit(good, marketOf.get(good)?.lastPrice ?? null) });
        held.set(good, (held.get(good) as number) - qty);
      } else {
        const good = rng.pick(preferNeed ? this.needs : this.goods);
        const limitPrice = this.limit(good, marketOf.get(good)?.lastPrice ?? null);
        const affordable = Math.floor(purse / limitPrice);
        if (affordable < 1) continue;
        const qty = rng.int(1, Math.min(affordable, MAX_QTY));
        actions.push({ kind: 'place_order', good, side: 'buy', qty, limitPrice });
        purse -= qty * limitPrice;
      }
    }
    if (actions.length === 0) actions.push({ kind: 'pass' });

    return {
      agentId: task.agentId,
      actions,
      survey: { type: task.role === 'trader' ? 'business' : 'consumer', confidence: rng.int(0, 100) },
      reason: 'Random valid stub decision.',
      memo: `acted c${task.cycle}`,
      source: 'stub',
    };
  }

  /** Price within +-20% of the last clearing price (or base price), at least 1. */
  private limit(good: string, last: number | null): number {
    const ref = last ?? this.basePrice.get(good) ?? 1;
    return Math.max(1, Math.round(ref * (0.8 + 0.4 * this.rng.next())));
  }
}
