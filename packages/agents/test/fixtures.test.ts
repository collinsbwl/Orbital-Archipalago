import { describe, expect, it } from 'vitest';
import { AgentTaskSchema } from '@orbital/contracts';
import { FIXTURES } from './fixtures/tasks.js';

describe('fixtures', () => {
  it('every fixture parses with AgentTaskSchema', () => {
    for (const task of FIXTURES) {
      const parsed = AgentTaskSchema.safeParse(task);
      if (!parsed.success) {
        throw new Error(`${task.agentId}: ${parsed.error.message}`);
      }
      expect(parsed.data.agentId).toBe(task.agentId);
    }
  });

  it('covers every role', () => {
    const roles = new Set(FIXTURES.map((f) => f.role));
    for (const r of ['colonist', 'trader', 'government', 'reserve_bank', 'news', 'economist'] as const) {
      expect(roles.has(r)).toBe(true);
    }
  });
});
