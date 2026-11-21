import type { AgentDecision, AgentId, AgentTask, PlanetId, Role, WorldConfig } from '@orbital/contracts';

/** Track B's AgentRuntime satisfies this; RandomValidPolicy and ScriptedEngine are local fakes. */
export interface DecisionProvider {
  decideAll(tasks: AgentTask[]): Promise<AgentDecision[]>;
  /** Independent copy with the same internal state (RNG, memory), for universe forks. Absent = not forkable. */
  fork?(): DecisionProvider;
}

export interface AgentInfo {
  id: AgentId;
  role: Role;
  planet: PlanetId;
}

export const agentId = (planet: PlanetId, role: Role, i: number): AgentId => `${planet}:${role}:${i}`;

const PLANET_ROLES = ['colonist', 'trader', 'government', 'reserve_bank'] as const;

/** Every planet-bound agent in the world, in deterministic order (planet, role, index). */
export function listAgents(world: WorldConfig): AgentInfo[] {
  const out: AgentInfo[] = [];
  for (const p of world.planets) {
    for (const role of PLANET_ROLES) {
      for (let i = 0; i < p.agents[role]; i++) out.push({ id: agentId(p.id, role, i), role, planet: p.id });
    }
  }
  return out;
}
