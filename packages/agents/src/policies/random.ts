// RandomValidPolicy — the day-1 fake. Random actions drawn only from
// allowedActions, sized within purse and inventory. Deterministic per seed.

import type { Action, AgentDecision, AgentTask } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';

export class RandomValidPolicy implements Policy {
  readonly name = 'random';

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    const allowed = task.allowedActions;
    if (allowed.length === 0 || ctx.rng.bool(0.4)) {
      return { agentId: task.agentId, actions: [{ kind: 'pass' }], reason: 'random pass', source: 'stub' };
    }
    const kind = ctx.rng.pick(allowed);
    const action = this.sample(kind, task, ctx);
    const actions: Action[] = action ? [action] : [{ kind: 'pass' }];
    return { agentId: task.agentId, actions, reason: `random ${kind}`, source: 'stub' };
  }

  private sample(kind: Action['kind'], task: AgentTask, ctx: PolicyCtx): Action | null {
    const obs = task.observation;
    switch (kind) {
      case 'place_order': {
        if (obs.markets.length === 0) return null;
        const m = ctx.rng.pick(obs.markets);
        const side = ctx.rng.bool() ? 'buy' : 'sell';
        const qty = 1 + ctx.rng.int(3);
        const base = m.lastPrice ?? 100;
        const limitPrice = Math.max(1, base + ctx.rng.int(5) - 2);
        return { kind: 'place_order', good: m.good, side, qty, limitPrice };
      }
      case 'pass':
      default:
        return { kind: 'pass' };
    }
  }
}
