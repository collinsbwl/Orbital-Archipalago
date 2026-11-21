// The one-function shape every policy obeys. ctx carries the world, the RNG, and
// (for standing orders) the agent's previous decision.

import type { AgentDecision, AgentTask, WorldConfig } from '@orbital/contracts';
import type { Rng } from './rng.js';

export interface PolicyCtx {
  world: WorldConfig;
  rng: Rng;
  /** Set by the runtime from its per-(universe, agent) map. */
  previous?: AgentDecision;
  /** Optional abort signal; policies that fan out should honor it. */
  signal?: AbortSignal;
}

export interface Policy {
  readonly name: string;
  decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision>;
}
