import type { ActionKind } from '@orbital/contracts';
import type { AgentInfo } from './agents.js';

/** A1: only local-market actions. Later milestones widen this per role and cycle. */
export const A1_ALLOWED_ACTIONS: ActionKind[] = ['place_order', 'cancel_order', 'pass'];

/** A1: every colonist and trader acts every cycle; governments and reserve banks are not scheduled yet. */
export function schedule(agents: readonly AgentInfo[], _cycle: number): AgentInfo[] {
  return agents.filter((a) => a.role === 'colonist' || a.role === 'trader');
}
