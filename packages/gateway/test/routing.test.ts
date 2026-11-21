import { describe, expect, it } from 'vitest';
import { MODEL_IDS, ROUTES, TIERS, resolve } from '../src/routing.js';

describe('routing', () => {
  it('maps each role to a route', () => {
    for (const role of ['colonist', 'trader', 'government', 'reserve_bank', 'news', 'economist'] as const) {
      expect(ROUTES[role]).toBeDefined();
    }
    expect(ROUTES.reserve_bank.tier).toBe('rule');
  });

  it('resolves colonist on full profile to Pro-family flash', () => {
    const r = resolve('colonist', 'full');
    expect(r.model).toBe(MODEL_IDS['gemini-flash']);
    expect(r.route.tier).toBe('small');
  });

  it('resolves government on full profile to gemini-pro', () => {
    const r = resolve('government', 'full');
    expect(r.model).toBe(MODEL_IDS['gemini-pro']);
  });

  it('respects per-agent overrides', () => {
    const r = resolve('government', 'full', [{ agentId: 'helion:government:1', tier: 'small' }], {
      agentId: 'helion:government:1',
      planet: 'helion',
    });
    expect(r.model).toBe(MODEL_IDS['gemini-flash']);
  });

  it('cheap profile keeps every tier on flash', () => {
    expect(TIERS.cheap.frontier).toBe('gemini-flash');
  });

  it('throws when routing a rule tier', () => {
    expect(() => resolve('reserve_bank', 'full')).toThrow();
  });
});
