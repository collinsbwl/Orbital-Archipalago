import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/prompt/builder.js';
import { FIXTURES } from './fixtures/tasks.js';

describe('PromptBuilder', () => {
  it('system prefix has no cycle number or timestamp', () => {
    const req = buildRequest({ task: FIXTURES[0]!, profile: 'cheap' });
    expect(req.prefix.system).not.toMatch(/cycle\s*\d+/i);
    expect(req.prefix.system).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('context includes the planet, cycle, and markets', () => {
    const task = FIXTURES[0]!;
    const req = buildRequest({ task, profile: 'cheap' });
    expect(req.context).toContain(task.planet);
    expect(req.context).toContain(`cycle ${task.cycle}`);
    expect(req.context).toContain('grain');
  });

  it('state is JSON with sorted keys', () => {
    const req = buildRequest({ task: FIXTURES[0]!, profile: 'cheap' });
    const state = JSON.parse(req.state);
    expect(Object.keys(state.purse)).toEqual([...Object.keys(state.purse)].sort());
  });

  it('two calls with the same task give identical prefixes (cache-friendly)', () => {
    const a = buildRequest({ task: FIXTURES[0]!, profile: 'cheap' });
    const b = buildRequest({ task: FIXTURES[0]!, profile: 'cheap' });
    expect(a.prefix.system).toBe(b.prefix.system);
    expect(a.context).toBe(b.context);
  });
});
