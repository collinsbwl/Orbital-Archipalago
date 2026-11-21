import { readFileSync } from 'node:fs';
import { AgentTaskSchema } from '@orbital/contracts';
import type { AgentDecision, AgentTask } from '@orbital/contracts';
import type { DecisionProvider } from '../agents.js';

/** packages/engine/fixtures/agent-tasks.json, recorded by `scripts/record-fixtures.ts`. */
export const DEFAULT_FIXTURE_PATH = new URL('../../fixtures/agent-tasks.json', import.meta.url);

/**
 * Day-1 fake engine for Track B: replays recorded AgentTask[] per cycle into any DecisionProvider
 * (e.g. the real AgentRuntime) without needing a Universe or ledger.
 */
export class ScriptedEngine {
  constructor(readonly cycles: AgentTask[][]) {}

  /** Loads and schema-validates a fixture file. */
  static load(path: string | URL = DEFAULT_FIXTURE_PATH): ScriptedEngine {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('fixture must be an array of AgentTask[] per cycle');
    return new ScriptedEngine(raw.map((tasks) => (tasks as unknown[]).map((t) => AgentTaskSchema.parse(t))));
  }

  /** Feeds each recorded cycle to the provider; returns its decisions per cycle. */
  async run(provider: DecisionProvider): Promise<AgentDecision[][]> {
    const out: AgentDecision[][] = [];
    for (const tasks of this.cycles) out.push(await provider.decideAll(tasks));
    return out;
  }
}
