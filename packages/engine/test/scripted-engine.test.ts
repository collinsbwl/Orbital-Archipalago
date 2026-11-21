import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '@orbital/contracts';
import { RandomValidPolicy, ScriptedEngine } from '../src/index.js';

describe('ScriptedEngine', () => {
  it('loads the recorded fixture and feeds a DecisionProvider', async () => {
    const engine = ScriptedEngine.load();
    expect(engine.cycles).toHaveLength(5);
    expect(engine.cycles.every((c) => c.length === 10)).toBe(true);
    expect(new Set(engine.cycles[0]!.map((t) => t.planet)).size).toBe(3);
    const out = await engine.run(new RandomValidPolicy(DEFAULT_WORLD, 1));
    expect(out).toHaveLength(5);
    expect(out[0]!.map((d) => d.agentId)).toEqual(engine.cycles[0]!.map((t) => t.agentId));
  });
});
