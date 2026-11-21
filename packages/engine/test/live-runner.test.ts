import { DEFAULT_WORLD, ServerMessageSchema, SnapshotSchema } from '@orbital/contracts';
import { InMemoryLedger } from '@orbital/ledger-memory';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAuthVerifier, InMemorySeries, LiveRunner, RandomValidPolicy, startServer, Universe } from '../src/index.js';
import type { AuditEntry } from '../src/index.js';

async function setup() {
  const world = DEFAULT_WORLD;
  const series = new InMemorySeries();
  const universe = new Universe({ world, ledger: new InMemoryLedger(world), agents: new RandomValidPolicy(world, 1), sink: series });
  await universe.init();
  const audit: AuditEntry[] = [];
  const runner = new LiveRunner({ universeId: world.universeId, universe, series, intervalMs: 0, audit: async (e) => { audit.push(e); } });
  return { world, universe, runner, audit };
}

describe('LiveRunner', () => {
  it('publishes schema-valid snapshots with series, pauses and audits', async () => {
    const { world, universe, runner, audit } = await setup();
    const seen: number[] = [];
    runner.subscribe(world.universeId, (s) => seen.push(s.cycle));
    for (let i = 0; i < 12; i++) await runner.tick();
    const snap = SnapshotSchema.parse(runner.latest(world.universeId));
    expect(snap.series.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(12);

    const op = { sub: 'auth0|op', role: 'operator' as const };
    expect(await runner.command(world.universeId, { kind: 'pause' }, op)).toEqual({ ok: true });
    const before = universe.cycle;
    await runner.tick();
    expect(universe.cycle).toBe(before);
    expect(runner.latest(world.universeId)?.paused).toBe(true);
    expect((await runner.command(world.universeId, { kind: 'pause' }, { sub: 'x', role: 'spectator' })).ok).toBe(false);
    expect(audit.map((a) => [a.sub, a.ok])).toEqual([['auth0|op', true], ['x', false]]);
  });

  it('fork command adds a second streamed universe; onFork sees it', async () => {
    const { world, universe } = await setup();
    const hooked: string[] = [];
    const runner2 = new LiveRunner({ universeId: world.universeId, universe, series: new InMemorySeries(), intervalMs: 0, onFork: (id) => { hooked.push(id); } });
    for (let i = 0; i < 5; i++) await runner2.tick();
    const op = { sub: 'auth0|op', role: 'operator' as const };
    const out = await runner2.command(world.universeId, { kind: 'fork' }, op);
    expect(out).toEqual({ ok: true, forkedUniverseId: `${world.universeId}-f1` });
    expect(hooked).toEqual([`${world.universeId}-f1`]);
    expect(runner2.universeIds()).toEqual([world.universeId, `${world.universeId}-f1`]);
    const seen: number[] = [];
    runner2.subscribe(`${world.universeId}-f1`, (s) => seen.push(s.cycle));
    await runner2.tick();
    await runner2.tick();
    const a = SnapshotSchema.parse(runner2.latest(world.universeId));
    const b = SnapshotSchema.parse(runner2.latest(`${world.universeId}-f1`));
    expect([a.universeId, b.universeId]).toEqual([world.universeId, `${world.universeId}-f1`]);
    expect(b.cycle).toBe(a.cycle);
    expect(seen).toEqual([5, 6]);
    // pause is per universe
    await runner2.command(`${world.universeId}-f1`, { kind: 'pause' }, op);
    await runner2.tick();
    expect(runner2.latest(world.universeId)!.cycle).toBe(a.cycle + 1);
    expect(runner2.latest(`${world.universeId}-f1`)).toMatchObject({ cycle: b.cycle, paused: true });
    expect((await runner2.command(world.universeId, { kind: 'fork' }, op)).forkedUniverseId).toBe(`${world.universeId}-f2`);
  });

  it('a tariff command lands at the next cycle and shows in the snapshot policy and events; bad commands ack ok:false', async () => {
    const { world, runner, audit } = await setup();
    const op = { sub: 'auth0|op', role: 'operator' as const };
    await runner.tick();
    expect(await runner.command(world.universeId, { kind: 'tariff', planet: 'helion', good: 'iron', rateBp: 750 }, op)).toEqual({ ok: true });
    expect(runner.latest(world.universeId)!.planets[0]!.policy.tariffsBp.iron).toBeUndefined(); // queued, not applied yet
    await runner.tick();
    const snap = runner.latest(world.universeId)!;
    expect(snap.planets.find((p) => p.planet === 'helion')!.policy.tariffsBp.iron).toBe(750);
    expect(snap.events.some((e) => e.kind === 'policy' && e.text.startsWith('[god mode]'))).toBe(true);
    const bad = await runner.command(world.universeId, { kind: 'tariff', planet: 'mars', good: 'iron', rateBp: 1 }, op);
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('unknown planet') });
    expect((await runner.command('nope', { kind: 'pause' }, op)).error).toBe('unknown_universe');
    expect(audit.map((a) => a.ok)).toEqual([true, false, false]);
  });

  it('spectators cannot send any command', async () => {
    const { world, runner } = await setup();
    const spec = { sub: 'anon', role: 'spectator' as const };
    for (const c of [{ kind: 'fork' }, { kind: 'resume' }, { kind: 'tariff', planet: 'helion', good: 'iron', rateBp: 1 }] as const) {
      expect(await runner.command(world.universeId, c, spec)).toEqual({ ok: false, error: 'forbidden' });
    }
    expect(runner.universeIds()).toEqual([world.universeId]);
  });

  it('streams live snapshots over the WebSocket server', async () => {
    const { world, runner } = await setup();
    const server = await startServer({ port: 0, hub: runner, auth: createAuthVerifier({ mode: 'disabled', role: 'spectator' }) });
    try {
      await runner.tick();
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      const msgs: unknown[] = [];
      ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'subscribe', universeId: world.universeId }));
      await new Promise((r) => setTimeout(r, 50));
      await runner.tick();
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
      const parsed = msgs.map((m) => ServerMessageSchema.parse(m));
      expect(parsed[0]?.type).toBe('hello');
      const cycles = parsed.flatMap((m) => (m.type === 'snapshot' ? [m.snapshot.cycle] : []));
      expect(cycles.length).toBeGreaterThanOrEqual(2);
      expect(cycles.at(-1)).toBeGreaterThan(cycles[0]!);
    } finally {
      await server.close();
    }
  });
});
