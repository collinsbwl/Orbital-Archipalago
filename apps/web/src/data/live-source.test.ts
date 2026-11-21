import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../test-fixtures';
import { LiveSource } from './live-source';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const hello = { type: 'hello', contractsVersion: '0', universeId: 'u0', role: 'operator' };

async function connected(opts: { getToken?: () => string } = {}) {
  FakeWebSocket.instances = [];
  const src = new LiveSource({ url: 'ws://x/ws', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, ...opts });
  src.start();
  await flush();
  const ws = FakeWebSocket.instances[0]!;
  ws.onopen?.();
  return { src, ws };
}

describe('LiveSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('appends the token, subscribes after hello and exposes role and snapshots', async () => {
    const { src, ws } = await connected({ getToken: () => 'tok en' });
    expect(ws.url).toBe('ws://x/ws?access_token=tok%20en');
    ws.receive(hello);
    expect(ws.sent).toEqual([{ type: 'subscribe', universeId: 'u0' }]);
    expect(src.getState()).toMatchObject({ role: 'operator', connected: true, universeId: 'u0' });
    ws.receive({ type: 'snapshot', snapshot: makeSnapshot(5) });
    expect(src.getState().snapshot?.cycle).toBe(5);
    src.stop();
  });

  it('resolves sendCommand on the matching ack', async () => {
    const { src, ws } = await connected();
    ws.receive(hello);
    const p1 = src.sendCommand('u0', { kind: 'pause' });
    const p2 = src.sendCommand('u0', { kind: 'fork' });
    expect(ws.sent.slice(1).map((m) => m.commandId)).toEqual(['1', '2']);
    ws.receive({ type: 'command_ack', commandId: '2', ok: true, forkedUniverseId: 'u1' });
    ws.receive({ type: 'command_ack', commandId: '1', ok: false, error: 'forbidden' });
    expect(await p2).toEqual({ ok: true, forkedUniverseId: 'u1' });
    expect(await p1).toEqual({ ok: false, error: 'forbidden' });
    expect(src.getState().universes).toContain('u1');
    src.stop();
  });

  it('flags and ignores schema-invalid messages', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { src, ws } = await connected();
    ws.receive(hello);
    ws.receive({ type: 'snapshot', snapshot: { universeId: 'u0' } });
    expect(src.getState().snapshot).toBeNull();
    expect(src.getState().error).toMatch(/invalid message/);
    ws.receive('not json');
    expect(src.getState().error).toMatch(/invalid JSON/);
    src.stop();
  });
});
