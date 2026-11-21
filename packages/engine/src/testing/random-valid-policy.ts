import type { Action, AgentDecision, AgentTask, WorldConfig } from '@orbital/contracts';
import type { DecisionProvider } from '../agents.js';
import { RATE_SCALE } from '@orbital/contracts';
import { Rng } from '../rng.js';

const MAX_QTY = 5;
const SHIP_PROB = 0.4;
const FX_PROB = 0.5;
const BORROW_PROB = 0.06;
const REPAY_PROB = 0.25;
const MAX_LOANS = 3; // keeps borrows within the validator's open-loan cap

/** Seeded fake agent (Track B owns the real policies): random but always schema-valid and affordable decisions. */
export class RandomValidPolicy implements DecisionProvider {
  private readonly rng: Rng;
  private readonly currency: Map<string, string>;
  private readonly basePrice: Map<string, number>;
  private readonly needs: string[];
  private readonly goods: string[];
  private readonly planets: string[];
  private readonly currencies: string[];
  private readonly startPurse: Map<string, { colonist: number; trader: number }>;
  private readonly needQty: Map<string, number>;

  constructor(world: WorldConfig, seed: number) {
    this.rng = new Rng(seed);
    this.currency = new Map(world.planets.map((p) => [p.id, p.currency]));
    this.basePrice = new Map(world.goods.map((g) => [g.id, g.basePrice]));
    this.needs = world.colonistNeeds.map((n) => n.good);
    this.goods = world.goods.map((g) => g.id);
    this.planets = world.planets.map((p) => p.id);
    this.currencies = world.planets.map((p) => p.currency);
    this.startPurse = new Map(world.planets.map((p) => [p.id, p.purses]));
    this.needQty = new Map(world.colonistNeeds.map((n) => [n.good, n.qty]));
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

    this.credit(task, purses, actions);

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
      survey: { type: task.role === 'trader' ? 'business' : 'consumer', confidence: this.confidence(task, local) },
      reason: 'Random valid stub decision.',
      memo: `acted c${task.cycle}`,
      source: 'stub',
    };
  }

  /** Maybe takes a small loan (never above the validator's caps) and maybe repays one own loan from the purse. */
  private credit(task: AgentTask, purses: Map<string, number>, actions: Action[]): void {
    const rng = this.rng;
    const loans = task.observation.loans;
    const loan = loans.length > 0 ? rng.pick(loans) : undefined;
    if (loan && rng.next() < REPAY_PROB) {
      const amount = Math.min(loan.outstanding, purses.get(loan.currency) ?? 0);
      if (amount >= 1) {
        actions.push({ kind: 'repay', loanId: loan.id, amount });
        purses.set(loan.currency, (purses.get(loan.currency) ?? 0) - amount);
      }
    }
    if (loans.length < MAX_LOANS && rng.next() < BORROW_PROB) {
      const amount = rng.int(10, 200) * (task.role === 'trader' ? 5 : 1);
      actions.push({ kind: 'borrow', amount, termCycles: rng.int(5, 40) });
    }
  }

  /** 0-100: leans on the purse relative to its start, stocked needs (colonists) or any stock (traders), and few loans, plus noise. */
  private confidence(task: AgentTask, local: string): number {
    const obs = task.observation;
    const start = this.startPurse.get(task.planet)?.[task.role === 'trader' ? 'trader' : 'colonist'] || 1;
    const purseHealth = Math.min(1, (obs.purse[local] ?? 0) / start);
    const stocked =
      task.role === 'trader'
        ? Object.values(obs.inventory).filter((q) => q > 0).length / Math.max(1, this.goods.length)
        : [...this.needQty].filter(([g, q]) => (obs.inventory[g] ?? 0) >= q).length / Math.max(1, this.needQty.size);
    const raw = 15 + 50 * purseHealth + 25 * stocked - 5 * obs.loans.length + this.rng.int(-10, 10);
    return Math.max(0, Math.min(100, Math.round(raw)));
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

  /**
   * Price within +-20% of a reference that leans 75/25 from the last clearing price toward the base price, at least 1.
   * The pull toward base keeps stub prices from random-walking away (a stub artifact, not economics).
   */
  private limit(good: string, last: number | null): number {
    const base = this.basePrice.get(good) ?? 1;
    const ref = last === null ? base : (3 * last + base) / 4;
    return Math.max(1, Math.round(ref * (0.8 + 0.4 * this.rng.next())));
  }
}
