import { AgentDecisionSchema } from '@orbital/contracts';
import type { AgentTask, Order, OrderId } from '@orbital/contracts';
import type { MarketBook } from './market-book.js';

export const MAX_ACTIONS_PER_AGENT = 10;

export interface Rejection {
  agentId: string;
  action: string;
  reason: string;
}

export interface ValidatedDecision {
  agentId: string;
  orders: Order[];
  cancels: OrderId[];
  memo?: string;
}

/**
 * Engine-side check of untrusted decisions. Output is ordered like `tasks` (the deterministic agent order), whatever
 * order the provider returned. Funds and inventory are checked later by the ledger (per-order rejects).
 */
export function validateDecisions(
  raw: readonly unknown[],
  tasks: readonly AgentTask[],
  book: MarketBook,
  goods: ReadonlySet<string>,
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
    const out: ValidatedDecision = { agentId: d.agentId, orders: [], cancels: [], ...(d.memo !== undefined ? { memo: d.memo } : {}) };
    const cancelled = new Set<string>();
    d.actions.forEach((a, i) => {
      const reject = (reason: string) => rejections.push({ agentId: d.agentId, action: a.kind, reason });
      if (i >= MAX_ACTIONS_PER_AGENT) return reject('action_cap');
      if (!task.allowedActions.includes(a.kind)) return reject('not_allowed');
      if (a.kind === 'place_order') {
        if (!goods.has(a.good)) return reject('unknown_good');
        out.orders.push({ agentId: d.agentId, planet: task.planet, good: a.good, side: a.side, qty: a.qty, limitPrice: a.limitPrice });
      } else if (a.kind === 'cancel_order') {
        if (book.get(a.orderId)?.agentId !== d.agentId) return reject('not_own_order');
        if (cancelled.has(a.orderId)) return reject('duplicate_cancel');
        cancelled.add(a.orderId);
        out.cancels.push(a.orderId);
      }
    });
    seen.set(d.agentId, out);
  }
  return { decisions: tasks.flatMap((t) => seen.get(t.agentId) ?? []), rejections };
}
