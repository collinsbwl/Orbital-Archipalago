// Route tables and model ids for architecture.md §3.3. One place for the pinned
// Gemini SKUs; everywhere else routes by role + profile.

import type { Profile, Route } from '@orbital/contracts';
import type { Role } from '@orbital/contracts';

/** Tier names used in the ROUTES table. The real SKU per tier is in MODEL_IDS. */
export type TierName = 'gemini-flash' | 'gemini-decision-1' | 'stub';

/** Pinned Gemini model ids. Update here and nowhere else. */
export const MODEL_IDS: Record<TierName, string> = {
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-decision-1': 'gemini-decision-1',
  stub: 'stub',
};

/**
 * Pinned Gemini Decision model (closed-set, non-generative). Used by the
 * DecisionGateway for colonist choices and trader/government escalation checks.
 */
export const DECISION_MODEL_ID = 'gemini-decision-1';

/** Role → route (§3.3). */
export const ROUTES: Record<Role, Route> = {
  colonist: { tier: 'small', maxTurns: 1, effort: 'low', maxTokens: 1_000, mode: 'structured' },
  trader: { tier: 'small', maxTurns: 3, effort: 'medium', maxTokens: 2_000, mode: 'tools' },
  government: { tier: 'frontier', maxTurns: 4, effort: 'medium', maxTokens: 8_000, mode: 'tools' },
  reserve_bank: { tier: 'rule' },
  news: { tier: 'small', maxTurns: 1, effort: 'low', maxTokens: 800, mode: 'structured' },
  economist: { tier: 'frontier', maxTurns: 1, effort: 'high', maxTokens: 16_000, mode: 'text' },
};

type ModelOrStub = TierName;
/** Profile × tier → model id (§3.3). Flash is the only generative model; there is no Pro tier. */
export const TIERS: Record<Profile, Record<'small' | 'mid' | 'frontier', ModelOrStub>> = {
  stub: { small: 'stub', mid: 'stub', frontier: 'stub' },
  cheap: { small: 'gemini-flash', mid: 'gemini-flash', frontier: 'gemini-flash' },
  full: { small: 'gemini-flash', mid: 'gemini-flash', frontier: 'gemini-flash' },
};

/**
 * Per-run overrides, applied in order: by `agentId`, then `role`, then `planet`.
 * Each override replaces the route's tier (e.g. put one government on `mid`).
 */
export interface RouteOverride {
  agentId?: string;
  role?: Role;
  planet?: string;
  tier: 'small' | 'mid' | 'frontier';
}

export interface Resolved {
  route: Route;
  tierName: TierName;
  model: string;
}

/**
 * Resolve the route, tier name, and pinned model id for a task.
 * Throws on `tier: 'rule'` — the runtime routes rule tasks to RulePolicy without a gateway.
 */
export function resolve(
  role: Role,
  profile: Profile,
  overrides: RouteOverride[] = [],
  ctx?: { agentId?: string; planet?: string },
): Resolved {
  const base = ROUTES[role];
  if (base.tier === 'rule') throw new Error(`role ${role} uses the rule tier; do not send to a gateway`);
  // Overrides match by agentId first, then role, then planet. First match wins.
  const override =
    overrides.find((o) => o.agentId && ctx?.agentId && o.agentId === ctx.agentId) ??
    overrides.find((o) => o.role === role) ??
    overrides.find((o) => o.planet && ctx?.planet && o.planet === ctx.planet);
  const tier = override?.tier ?? base.tier;
  const tierName = TIERS[profile][tier];
  const route: Route = { ...base, tier };
  return { route, tierName, model: MODEL_IDS[tierName] };
}
