import type { ActionKind, AgentId, PlanetId, Role } from '@orbital/contracts';
import type { AgentInfo } from './agents.js';

export const COLONIST_ACTIONS: ActionKind[] = ['place_order', 'cancel_order', 'borrow', 'repay', 'pass'];
export const TRADER_ACTIONS: ActionKind[] = ['place_order', 'cancel_order', 'place_fx_order', 'ship', 'borrow', 'repay', 'pass'];

export const allowedActionsFor = (role: Role): ActionKind[] => (role === 'trader' ? [...TRADER_ACTIONS] : [...COLONIST_ACTIONS]);

/**
 * Colonists act every cycle; traders only while docked (`docked` maps trader -> planet, null = in flight). A scheduled
 * agent's `planet` is where it acts: the docked planet for traders. Governments and reserve banks are not scheduled yet.
 */
export function schedule(agents: readonly AgentInfo[], _cycle: number, docked: ReadonlyMap<AgentId, PlanetId | null>): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const a of agents) {
    if (a.role === 'colonist') out.push(a);
    else if (a.role === 'trader') {
      const at = docked.get(a.id);
      if (at) out.push({ ...a, planet: at });
    }
  }
  return out;
}
