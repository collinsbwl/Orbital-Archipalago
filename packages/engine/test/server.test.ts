import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { CONTRACTS_VERSION, ServerMessageSchema, SnapshotSchema } from '@orbital/contracts';
import type { GodModeCommand, ServerMessage, Snapshot } from '@orbital/contracts';
import type { CommandContext, SimHub } from '../src/ports.js';
import { createAuthVerifier } from '../src/server/auth.js';
import { startServer } from '../src/server/ws-server.js';
import type { RunningServer } from '../src/server/ws-server.js';

function snap(universeId: string, cycle: number): Snapshot {
  return SnapshotSchema.parse({ universeId, cycle, paused: false, planets: [], fx: [], shipments: [], migrants: [], events: [], series: [], gatewayCostUsd: 0 });
}

class FakeHub implements SimHub {
  snapshots = new Map<string, Snapshot>();
  listeners = new Map<string, Set<(s: Snapshot) => void>>();
  commands: Array<{ universeId: string; command: GodModeCommand; ctx: CommandContext }> = [];
  constructor(ids: string[]) {
    for (const id of ids) this.listeners.set(id, new Set());
  }
  universeIds() { return [...this.listeners.keys()]; }
  latest(id: string) { return this.snapshots.get(id); }
  subscribe(id: string, fn: (s: Snapshot) => void) {
    this.listeners.get(id)!.add(fn);
    return () => { this.listeners.get(id)!.delete(fn); };
  }
  async command(universeId: string, command: GodModeCommand, ctx: CommandContext) {
    this.commands.push({ universeId, command, ctx });
    return command.kind === 'fork' ? { ok: true, forkedUniverseId: 'u1' } : { ok: true };
  }
  publish(s: Snapshot) {
    this.snapshots.set(s.universeId, s);
    for (const fn of this.listeners.get(s.universeId) ?? []) fn(s);
  }
}

/** Collects every server message and lets tests await the next matching one. */
class Client {
  messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const msg = ServerMessageSchema.parse(JSON.parse(d.toString()));
      this.messages.push(msg);
      this.waiters.splice(0).forEach((w) => w());
    });
  }
  static async connect(url: string, headers?: Record<string, string>): Promise<Client> {
    const ws = new WebSocket(url, { headers });
    const c = new Client(ws);
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    return c;
  }
  send(m: unknown) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  async next<T extends ServerMessage['type']>(type: T, from = 0): Promise<Extract<ServerMessage, { type: T }>> {
    for (let i = 0; i < 200; i++) {
      const hit = this.messages.slice(from).find((m) => m.type === type);
      if (hit) return hit as Extract<ServerMessage, { type: T }>;
      await new Promise<void>((res) => { this.waiters.push(res); setTimeout(res, 50); });
    }
    throw new Error(`timeout waiting for ${type}`);
  }
  close() { this.ws.close(); }
}

let server: RunningServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.ws.terminate());
  await server?.close();
  server = undefined;
});
const connect = async (url: string, headers?: Record<string, string>) => {
  const c = await Client.connect(url, headers);
  clients.push(c);
  return c;
};

describe('ws server (auth disabled)', () => {
  const start = async (role: 'spectator' | 'operator', hub = new FakeHub(['u0', 'u1'])) => {
    server = await startServer({ port: 0, hub, auth: createAuthVerifier({ mode: 'disabled', role }) });
    return { hub, url: `ws://127.0.0.1:${server.port}` };
  };

  it('serves /healthz', async () => {
    const { hub } = await start('spectator');
    const res = await fetch(`http://127.0.0.1:${server!.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, universes: hub.universeIds() });
  });

  it('sends hello, then latest + streamed snapshots after subscribe', async () => {
    const { hub, url } = await start('spectator');
    hub.publish(snap('u0', 3));
    const c = await connect(url);
    expect(await c.next('hello')).toEqual({ type: 'hello', contractsVersion: CONTRACTS_VERSION, universeId: 'u0', role: 'spectator' });

    c.send({ type: 'subscribe', universeId: 'u0' });
    expect((await c.next('snapshot')).snapshot.cycle).toBe(3);
    const before = c.messages.length;
    hub.publish(snap('u0', 4));
    expect((await c.next('snapshot', before)).snapshot.cycle).toBe(4);

    // re-subscribe replaces the subscription: u0 updates stop, u1 updates arrive
    c.send({ type: 'subscribe', universeId: 'u1' });
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.listeners.get('u0')!.size).toBe(0);
    expect(hub.listeners.get('u1')!.size).toBe(1);
    const mark = c.messages.length;
    hub.publish(snap('u0', 5));
    hub.publish(snap('u1', 1));
    const next = await c.next('snapshot', mark);
    expect(next.snapshot.universeId).toBe('u1');
  });

  it('cleans up the subscription on close', async () => {
    const { hub, url } = await start('spectator');
    const c = await connect(url);
    c.send({ type: 'subscribe', universeId: 'u0' });
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.listeners.get('u0')!.size).toBe(1);
    c.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(hub.listeners.get('u0')!.size).toBe(0);
  });

  it('answers invalid messages with an error and keeps the socket', async () => {
    const { url } = await start('spectator');
    const c = await connect(url);
    c.send('not json');
    expect((await c.next('error')).message).toMatch(/JSON/);
    const mark = c.messages.length;
    c.send({ type: 'subscribe' });
    expect((await c.next('error', mark)).message).toMatch(/invalid message/);
    const mark2 = c.messages.length;
    c.send({ type: 'subscribe', universeId: 'nope' });
    expect((await c.next('error', mark2)).message).toMatch(/unknown universe/);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('forbids spectator commands', async () => {
    const { hub, url } = await start('spectator');
    const c = await connect(url);
    c.send({ type: 'command', commandId: 'c1', universeId: 'u0', command: { kind: 'pause' } });
    expect(await c.next('command_ack')).toEqual({ type: 'command_ack', commandId: 'c1', ok: false, error: 'forbidden' });
    expect(hub.commands).toHaveLength(0);
  });

  it('lets operators command and returns the outcome', async () => {
    const { hub, url } = await start('operator');
    const c = await connect(url);
    c.send({ type: 'command', commandId: 'c2', universeId: 'u0', command: { kind: 'fork' } });
    expect(await c.next('command_ack')).toEqual({ type: 'command_ack', commandId: 'c2', ok: true, forkedUniverseId: 'u1' });
    expect(hub.commands[0]).toMatchObject({ universeId: 'u0', command: { kind: 'fork' }, ctx: { sub: 'dev', role: 'operator' } });
  });
});

describe('ws server (auth0 mode)', () => {
  const issuer = 'https://orbital.test.auth0.com/';
  const audience = 'https://api.orbital.test';

  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const hub = new FakeHub(['u0']);
    server = await startServer({ port: 0, hub, auth: createAuthVerifier({ mode: 'auth0', issuer, audience, jwks }) });
    const sign = (claims: Record<string, unknown>, opts: { exp?: string | number; key?: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; aud?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('auth0|operator1')
        .setIssuer(issuer)
        .setAudience(opts.aud ?? audience)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(opts.key ?? privateKey);
    return { hub, sign, url: `ws://127.0.0.1:${server.port}` };
  }

  const upgradeStatus = (url: string, headers?: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
      ws.once('open', () => { ws.terminate(); resolve(101); });
      ws.once('error', reject);
    });

  it('accepts an operator token (query param) and routes commands to the hub', async () => {
    const { hub, sign, url } = await setup();
    const token = await sign({ 'https://orbital/roles': ['operator'] });
    const c = await connect(`${url}/?access_token=${token}`);
    expect((await c.next('hello')).role).toBe('operator');
    c.send({ type: 'command', commandId: 'c3', universeId: 'u0', command: { kind: 'policy_rate', planet: 'helion', rateBp: 300 } });
    expect((await c.next('command_ack')).ok).toBe(true);
    expect(hub.commands[0]?.ctx).toEqual({ sub: 'auth0|operator1', role: 'operator' });
  });

  it('accepts a Bearer header; tokens without the operator role are spectators', async () => {
    const { hub, sign, url } = await setup();
    const token = await sign({});
    const c = await connect(url, { authorization: `Bearer ${token}` });
    expect((await c.next('hello')).role).toBe('spectator');
    c.send({ type: 'command', commandId: 'c4', universeId: 'u0', command: { kind: 'pause' } });
    expect((await c.next('command_ack')).error).toBe('forbidden');
    expect(hub.commands).toHaveLength(0);
  });

  it('rejects missing, garbage, expired, wrong-audience and wrongly-signed tokens with 401', async () => {
    const { sign, url } = await setup();
    const other = await generateKeyPair('RS256');
    expect(await upgradeStatus(url)).toBe(401);
    expect(await upgradeStatus(`${url}/?access_token=garbage`)).toBe(401);
    expect(await upgradeStatus(`${url}/?access_token=${await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })}`)).toBe(401);
    expect(await upgradeStatus(`${url}/?access_token=${await sign({}, { aud: 'https://other' })}`)).toBe(401);
    expect(await upgradeStatus(`${url}/?access_token=${await sign({}, { key: other.privateKey })}`)).toBe(401);
    expect(await upgradeStatus(`${url}/?access_token=${await sign({})}`)).toBe(101);
  });
});
