import type { Action, AgentDecision, AgentTask, WorldConfig } from '@orbital/contracts';
import type { DecisionProvider } from '../agents.js';
import { RATE_SCALE } from '@orbital/contracts';
import { Rng } from '../rng.js';

const MAX_QTY = 5;
const SHIP_PROB = 0.4;
const FX_PROB = 0.5;

/** Seeded fake agent (Track B owns the real policies): random but always schema-valid and affordable decisions. */
export class RandomValidPolicy implements DecisionProvider {
  private readonly rng: Rng;
  private readonly currency: Map<string, string>;
  private readonly basePrice: Map<string, number>;
  private readonly needs: string[];
  private readonly goods: string[];
  private readonly planets: string[];
  private readonly currencies: string[];

  constructor(world: WorldConfig, seed: number) {
    this.rng = new Rng(seed);
    this.currency = new Map(world.planets.map((p) => [p.id, p.currency]));
    this.basePrice = new Map(world.goods.map((g) => [g.id, g.basePrice]));
    this.needs = world.colonistNeeds.map((n) => n.good);
    this.goods = world.goods.map((g) => g.id);
    this.planets = world.planets.map((p) => p.id);
    this.currencies = world.planets.map((p) => p.currency);
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

    const local = this.currency.get(task.planet) as string;
    const purses = new Map(Object.entries(obs.purse));
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
        const affordable = Math.floor((purses.get(local) ?? 0) / limitPrice);
        if (affordable < 1) continue;
        const qty = rng.int(1, Math.min(affordable, MAX_QTY));
        actions.push({ kind: 'place_order', good, side: 'buy', qty, limitPrice });
        purses.set(local, (purses.get(local) ?? 0) - qty * limitPrice);
      }
    }
    if (task.role === 'trader') {
      this.ship(task, held, actions);
      this.fx(task, purses, actions);
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

  /** Maybe ships some held goods (net of this decision's sell orders) to another planet. */
  private ship(task: AgentTask, held: Map<string, number>, actions: Action[]): void {
    const rng = this.rng;
    const goods = this.goods.filter((g) => (held.get(g) ?? 0) > 0);
    const others = this.planets.filter((p) => p !== task.planet);
    if (goods.length === 0 || others.length === 0 || rng.next() >= SHIP_PROB) return;
    const cargo = rng.shuffle(goods).slice(0, rng.int(1, 3)).map((good) => ({ good, qty: rng.int(1, held.get(good) as number) }));
    actions.push({ kind: 'ship', to: rng.pick(others), cargo });
  }

  /** Maybe converts part of a held currency (net of local buys) into one the trader lacks, near the last rate. */
  private fx(task: AgentTask, purses: Map<string, number>, actions: Action[]): void {
    const rng = this.rng;
    const held = this.currencies.filter((c) => (purses.get(c) ?? 0) > 1);
    if (held.length === 0 || rng.next() >= FX_PROB) return;
    const give = rng.pick(held);
    const lacking = this.currencies.filter((c) => c !== give && (purses.get(c) ?? 0) === 0);
    const want = rng.pick(lacking.length > 0 ? lacking : this.currencies.filter((c) => c !== give));
    const have = purses.get(give) as number;
    const giveAmount = rng.int(Math.max(1, Math.ceil(have * 0.2)), Math.max(1, Math.floor(have * 0.6)));
    // Rate is quote per base; the fx view lists each pair once in canonical order. Parity when never cleared.
    const pair = task.observation.fx.find((f) => (f.base === give && f.quote === want) || (f.base === want && f.quote === give));
    const rate = pair?.lastRatePpm ?? RATE_SCALE;
    const expected = pair?.base === give ? (giveAmount * rate) / RATE_SCALE : (giveAmount * RATE_SCALE) / rate;
    const minReceive = Math.floor(expected * (0.8 + 0.2 * rng.next()));
    actions.push({ kind: 'place_fx_order', give, giveAmount, want, minReceive });
    purses.set(give, have - giveAmount);
  }

  /** Price within +-20% of the last clearing price (or base price), at least 1. */
  private limit(good: string, last: number | null): number {
    const ref = last ?? this.basePrice.get(good) ?? 1;
    return Math.max(1, Math.round(ref * (0.8 + 0.4 * this.rng.next())));
  }
}
