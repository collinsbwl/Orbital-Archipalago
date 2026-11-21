// StandingOrdersPolicy — the fallback. Repeat the agent's previous decision's
// place_order actions, dropping anything no longer allowed or affordable.

import type { Action, AgentDecision, AgentTask } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';

export class StandingOrdersPolicy implements Policy {
  readonly name = 'standing_orders';

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    const prev = ctx.previous;
    if (!prev) {
      return { agentId: task.agentId, actions: [{ kind: 'pass' }], reason: 'no prior decision', source: 'standing_orders' };
    }
    const allowed = new Set(task.allowedActions);
    const actions: Action[] = [];
    for (const action of prev.actions) {
      if (!allowed.has(action.kind)) continue;
      if (action.kind === 'place_order') {
        const affordable = this.canAfford(task, action);
        if (!affordable) continue;
      }
      actions.push(action);
    }
    if (actions.length === 0) actions.push({ kind: 'pass' });
    return {
      agentId: task.agentId,
      actions,
      reason: 'standing orders',
      source: 'standing_orders',
      memo: prev.memo,
    };
  }

  private canAfford(task: AgentTask, action: Extract<Action, { kind: 'place_order' }>): boolean {
    const purse = Object.values(task.observation.purse).reduce((a, b) => a + b, 0);
    if (action.side === 'buy') return purse >= action.qty * action.limitPrice;
    const stock = task.observation.inventory[action.good] ?? 0;
    return stock >= action.qty;
  }
}
