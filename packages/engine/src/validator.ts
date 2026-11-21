import { AgentDecisionSchema } from '@orbital/contracts';
import type { AgentTask, Cargo, FxOrder, LoanId, Order, OrderId, PlanetId, SurveyAnswer, WorldConfig } from '@orbital/contracts';
import type { MarketBook } from './market-book.js';

export const MAX_ACTIONS_PER_AGENT = 10;
export const MAX_OPEN_LOANS = 3;
/** A borrow may be at most this many times the role's starting purse. */
export const BORROW_CAP_MULTIPLE = 2;

/** Max borrow per `${planet}:${role}` (see `borrowCapsOf`). */
export const borrowCapsOf = (world: WorldConfig): Map<string, number> =>
  new Map(world.planets.flatMap((p) => [[`${p.id}:colonist`, BORROW_CAP_MULTIPLE * p.purses.colonist], [`${p.id}:trader`, BORROW_CAP_MULTIPLE * p.purses.trader]] as const));

export interface Rejection {
  agentId: string;
  action: string;
  reason: string;
}

export interface ValidatedDecision {
  agentId: string;
  orders: Order[];
  cancels: OrderId[];
  fxOrders: FxOrder[];
  /** At most one per decision; `from` is the planet the trader is docked at. */
  ship?: { from: PlanetId; to: PlanetId; cargo: Cargo[] };
  /** At most one per decision, from the reserve bank of the task planet. */
  borrow?: { planet: PlanetId; amount: number; termCycles: number };
  repays: { loanId: LoanId; amount: number }[];
  /** Planet the agent acted on (docked planet for traders). */
  planet: PlanetId;
  survey?: SurveyAnswer;
  memo?: string;
}

/** Ids the world defines; decisions referencing anything else are rejected. */
export interface KnownIds {
  goods: ReadonlySet<string>;
  planets: ReadonlySet<string>;
  currencies: ReadonlySet<string>;
  /** Max borrow per `${planet}:${role}`; a missing key means the role may not borrow. */
  borrowCaps?: ReadonlyMap<string, number>;
}

/**
 * Engine-side check of untrusted decisions. Output is ordered like `tasks` (the deterministic agent order), whatever
 * order the provider returned. Funds and inventory are checked later by the ledger (per-order rejects).
 */
export function validateDecisions(
  raw: readonly unknown[],
  tasks: readonly AgentTask[],
  book: MarketBook,
  known: KnownIds,
): { decisions: ValidatedDecision[]; rejections: Rejection[] } {
  const rejections: Rejection[] = [];
  const byAgent = new Map(tasks.map((t) => [t.agentId, t]));
  const seen = new Map<string, ValidatedDecision>();

  for (const r of raw) {
    const parsed = AgentDecisionSchema.safeParse(r);
    if (!parsed.success) {
      const id = (r as { agentId?: unknown } | null)?.agentId;
      rejections.push({ agentId: typeof id === 'string' ? id : '?', action: 'decision', reason: 'schema_invalid' });
      continue;
    }
    const d = parsed.data;
    const task = byAgent.get(d.agentId);
    if (!task) {
      rejections.push({ agentId: d.agentId, action: 'decision', reason: 'unscheduled_agent' });
      continue;
    }
    if (seen.has(d.agentId)) {
      rejections.push({ agentId: d.agentId, action: 'decision', reason: 'duplicate_decision' });
      continue;
    }
    const out: ValidatedDecision = {
      agentId: d.agentId, planet: task.planet, orders: [], cancels: [], fxOrders: [], repays: [],
      ...(d.survey ? { survey: d.survey } : {}), ...(d.memo !== undefined ? { memo: d.memo } : {}),
    };
    const cancelled = new Set<string>();
    const ownLoans = new Set(task.observation.loans.map((l) => l.id));
    const repaid = new Set<string>();
    d.actions.forEach((a, i) => {
      const reject = (reason: string) => rejections.push({ agentId: d.agentId, action: a.kind, reason });
      if (i >= MAX_ACTIONS_PER_AGENT) return reject('action_cap');
      if (!task.allowedActions.includes(a.kind)) return reject('not_allowed');
      if (a.kind === 'place_order') {
        if (!known.goods.has(a.good)) return reject('unknown_good');
        out.orders.push({ agentId: d.agentId, planet: task.planet, good: a.good, side: a.side, qty: a.qty, limitPrice: a.limitPrice });
      } else if (a.kind === 'cancel_order') {
        if (book.get(a.orderId)?.agentId !== d.agentId) return reject('not_own_order');
        if (cancelled.has(a.orderId)) return reject('duplicate_cancel');
        cancelled.add(a.orderId);
        out.cancels.push(a.orderId);
      } else if (a.kind === 'place_fx_order') {
        if (!known.currencies.has(a.give) || !known.currencies.has(a.want)) return reject('unknown_currency');
        if (a.give === a.want) return reject('same_currency');
        out.fxOrders.push({ agentId: d.agentId, give: a.give, giveAmount: a.giveAmount, want: a.want, minReceive: a.minReceive });
      } else if (a.kind === 'ship') {
        if (out.ship) return reject('duplicate_ship');
        if (!known.planets.has(a.to)) return reject('unknown_planet');
        if (a.to === task.planet) return reject('ship_to_self');
        if (a.cargo.some((c) => !known.goods.has(c.good))) return reject('unknown_good');
        out.ship = { from: task.planet, to: a.to, cargo: a.cargo };
      } else if (a.kind === 'borrow') {
        if (out.borrow) return reject('duplicate_borrow');
        if (ownLoans.size >= MAX_OPEN_LOANS) return reject('loan_cap');
        if (a.amount > (known.borrowCaps?.get(`${task.planet}:${task.role}`) ?? 0)) return reject('borrow_cap');
        out.borrow = { planet: task.planet, amount: a.amount, termCycles: a.termCycles };
      } else if (a.kind === 'repay') {
        if (!ownLoans.has(a.loanId)) return reject('not_own_loan');
        if (repaid.has(a.loanId)) return reject('duplicate_repay');
        repaid.add(a.loanId);
        out.repays.push({ loanId: a.loanId, amount: a.amount });
      }
    });
    seen.set(d.agentId, out);
  }
  return { decisions: tasks.flatMap((t) => seen.get(t.agentId) ?? []), rejections };
}
