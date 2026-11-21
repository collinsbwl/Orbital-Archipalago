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
