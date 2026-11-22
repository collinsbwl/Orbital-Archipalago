import { DEFAULT_WORLD } from '@orbital/contracts';
import type { AgentDecision, AgentTask, WorldConfig } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { RandomValidPolicy, Universe } from '../src/index.js';
import type { DecisionProvider } from '../src/index.js';

export function makeUniverse(opts: { world?: WorldConfig; agents?: DecisionProvider; seed?: number; checkInvariants?: boolean; migration?: boolean } = {}) {
  const world = opts.world ?? DEFAULT_WORLD;
  const ledger = new InMemoryLedger(world);
  const agents = opts.agents ?? new RandomValidPolicy(world, opts.seed ?? world.seed);
  const universe = new Universe({
    world, ledger, agents,
    ...(opts.checkInvariants !== undefined ? { checkInvariants: opts.checkInvariants } : {}),
    ...(opts.migration !== undefined ? { migration: opts.migration } : {}),
  });
  return { world, ledger, universe };
}

export const scripted = (fn: (tasks: AgentTask[]) => AgentDecision[]): DecisionProvider => ({ decideAll: async (t) => fn(t) });

export function initialSupply(world: WorldConfig): Record<string, number> {
  return Object.fromEntries(
    world.planets.map((p) => [p.currency, p.agents.colonist * p.purses.colonist + p.agents.trader * p.purses.trader + p.purses.treasury]),
  );
}
