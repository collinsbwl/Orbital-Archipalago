import type { ActionKind, AgentId, PlanetId, Role } from '@orbital/contracts';
import type { AgentInfo } from './agents.js';

export const COLONIST_ACTIONS: ActionKind[] = ['place_order', 'cancel_order', 'borrow', 'repay', 'pass'];
export const TRADER_ACTIONS: ActionKind[] = ['place_order', 'cancel_order', 'place_fx_order', 'ship', 'borrow', 'repay', 'pass'];
/** Governments set trade policy only; the policy rate stays with the reserve bank's rule. */
export const GOVERNMENT_ACTIONS: ActionKind[] = ['set_tariff', 'set_quota', 'set_embargo', 'pass'];

/** Governments review trade policy every `intervalCycles`, starting after `warmupCycles`. */
export const GOVERNMENT_SCHEDULE = { warmupCycles: 5, intervalCycles: 5 } as const;

export const allowedActionsFor = (role: Role): ActionKind[] =>
  role === 'trader' ? [...TRADER_ACTIONS] : role === 'government' ? [...GOVERNMENT_ACTIONS] : [...COLONIST_ACTIONS];

export const isGovernmentReview = (cycle: number): boolean =>
  cycle >= GOVERNMENT_SCHEDULE.warmupCycles && cycle % GOVERNMENT_SCHEDULE.intervalCycles === 0;

/**
 * Colonists act every cycle, on the planet they live on; traders only while docked; governments on review cycles (see
 * GOVERNMENT_SCHEDULE). `located` maps traders to their docked planet (null = in flight) and colonists to where they
 * live (missing = home). A scheduled agent's `planet` is where it acts. Reserve banks run as an engine rule and are
 * never scheduled.
 */
export function schedule(agents: readonly AgentInfo[], cycle: number, located: ReadonlyMap<AgentId, PlanetId | null>): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const a of agents) {
    if (a.role === 'colonist') {
      const at = located.get(a.id);
      out.push(at && at !== a.planet ? { ...a, planet: at } : a);
    } else if (a.role === 'trader') {
      const at = located.get(a.id);
      if (at) out.push({ ...a, planet: at });
    } else if (a.role === 'government' && isGovernmentReview(cycle)) out.push(a);
  }
  return out;
}
