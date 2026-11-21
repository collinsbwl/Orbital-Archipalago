import { describe, expect, it, vi } from 'vitest';
import { CacheManager, lintPrefix, sortedTools } from '../src/cache.js';

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
