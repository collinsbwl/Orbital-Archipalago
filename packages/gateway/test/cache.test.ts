import { describe, expect, it, vi } from 'vitest';
import { CacheManager, lintPrefix, sortedTools } from '../src/cache.js';
import { estimateCacheTokens } from '../src/cache.js';

const bigSystem = 'a'.repeat(8_000);

describe('CacheManager', () => {
  it('single-flights 30 parallel callers to one caches.create', async () => {
    const create = vi.fn(async () => ({ name: 'cache-abc' }));
    const mgr = new CacheManager({ client: { create } });
    const args = {
      model: 'gemini-2.5-flash',
      role: 'colonist' as const,
      planet: 'helion',
      cycle: 5,
      prefix: { system: bigSystem, tools: [] },
      context: 'planet context',
    };
    const res = await Promise.all(Array.from({ length: 30 }, () => mgr.getOrCreatePlanetCycle(args)));
    expect(create).toHaveBeenCalledOnce();
    for (const r of res) expect(r?.name).toBe('cache-abc');
  });

  it('skips caching below the minimum size', async () => {
    const create = vi.fn(async () => ({ name: 'x' }));
    const events: Array<{ kind: string; detail?: string }> = [];
    const mgr = new CacheManager({
      client: { create },
      minTokens: 10_000,
      onEvent: (ev) => events.push({ kind: ev.kind, detail: ev.detail }),
    });
    const res = await mgr.getOrCreatePlanetCycle({
      model: 'gemini-2.5-flash',
      role: 'colonist',
      planet: 'helion',
      cycle: 1,
      prefix: { system: 'short', tools: [] },
      context: 'short',
    });
    expect(res).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'skipped')).toBe(true);
  });

  it('warns when a role has zero cache hits for a cycle', async () => {
    const events: Array<{ kind: string }> = [];
    const mgr = new CacheManager({
      client: { create: vi.fn() },
      onEvent: (ev) => events.push({ kind: ev.kind }),
    });
    mgr.reportCycle(7, ['trader']);
    expect(events.filter((e) => e.kind === 'warning')).toHaveLength(1);
  });

  it('sortedTools is deterministic', () => {
    const sorted = sortedTools([
      { name: 'quote_route', description: '', parameters: {} },
      { name: 'book_depth', description: '', parameters: {} },
      { name: 'fx_quote', description: '', parameters: {} },
    ]);
    expect(sorted.map((t) => t.name)).toEqual(['book_depth', 'fx_quote', 'quote_route']);
  });

  it('lintPrefix flags cycle numbers and ISO timestamps', () => {
    expect(lintPrefix('normal rules text')).toEqual([]);
    expect(lintPrefix('as of cycle 42')).not.toEqual([]);
    expect(lintPrefix('timestamp 2026-11-21T10:30 included')).not.toEqual([]);
  });
});

describe('CacheManager sizing, role keys and expiry', () => {
  const bigSchema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(30) }])) };
  const submit = { name: 'submit_turn', description: 'final', parameters: bigSchema };

  it('counts tool declarations toward the minimum, so a small system + big schema still caches', async () => {
    const create = vi.fn(async () => ({ name: 'c' }));
    const m = new CacheManager({ client: { create } });
    expect(estimateCacheTokens('s'.repeat(2_000), [submit], '')).toBeGreaterThan(1_024);
    const rec = await m.getOrCreateRole({ model: 'm', role: 'trader', prefix: { system: 's'.repeat(2_000), tools: [submit] } });
    expect(rec?.name).toBe('c');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keys role caches by prefix content (policy-cycle schema gets its own cache)', async () => {
    let n = 0;
    const m = new CacheManager({ client: { create: async () => ({ name: `c${++n}` }) } });
    const sys = 's'.repeat(5_000);
    const a = await m.getOrCreateRole({ model: 'm', role: 'government', prefix: { system: sys, tools: [submit] } });
    const a2 = await m.getOrCreateRole({ model: 'm', role: 'government', prefix: { system: sys, tools: [submit] } });
    const b = await m.getOrCreateRole({ model: 'm', role: 'government', prefix: { system: sys, tools: [{ ...submit, parameters: { type: 'object' } }] } });
    expect(a?.name).toBe('c1');
    expect(a2?.name).toBe('c1');
    expect(b?.name).toBe('c2');
  });

  it('recreates a cache before its server-side TTL runs out', async () => {
    let now = 0;
    let n = 0;
    const m = new CacheManager({ client: { create: async () => ({ name: `c${++n}` }) }, now: () => now, roleTtlSec: 3_600, expirySafetySec: 30 });
    const args = { model: 'm', role: 'trader' as const, prefix: { system: 's'.repeat(5_000), tools: [] } };
    expect((await m.getOrCreateRole(args))?.name).toBe('c1');
    now = 3_500_000; // 58 min: still inside TTL minus safety
    expect((await m.getOrCreateRole(args))?.name).toBe('c1');
    now = 3_571_000; // past 3600 s - 30 s
    expect((await m.getOrCreateRole(args))?.name).toBe('c2');
  });
});
