// Shared shape for rule-built candidate bundles. Each role's builder produces a
// small menu; DecisionPolicy lets Gemini Decision 1 pick one and StubPolicy
// (or the low-confidence fallback) can take a default.

import type { Action, AgentTask, WorldConfig } from '@orbital/contracts';

export interface Candidate {
  /** Stable option id sent to the decision model ([A-Za-z0-9_-], no spaces). */
  id: string;
  /** One line the model reads; includes what it costs against the purse. */
  description: string;
  actions: Action[];
  /** Optional note carried to the agent's next turn (e.g. "ship iron to tethys"). */
  memo?: string;
}

export type CandidateBuilder = (task: AgentTask, world: WorldConfig) => Candidate[];

export const HOLD: Candidate = { id: 'hold', description: 'Do nothing this cycle.', actions: [{ kind: 'pass' }] };

/** Option ids must match the Decisions API key pattern. */
export function optionId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Drop bundles whose actions repeat an earlier one, and cap the menu (hold is always kept last). */
export function dedupe(cands: Candidate[], max = 8): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const c of cands) {
    if (c.actions.length === 0) continue;
    const key = JSON.stringify([c.actions, c.memo ?? null]); // same orders for a different route plan are distinct
    if (seen.has(key) || ids.has(c.id)) continue;
    seen.add(key);
    ids.add(c.id);
    out.push(c);
  }
  const hold = out.find((c) => c.id === 'hold');
  const rest = out.filter((c) => c.id !== 'hold').slice(0, max - 1);
  return hold ? [...rest, hold] : rest;
}
