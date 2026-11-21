import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { CONTRACTS_VERSION, ClientMessageSchema, ServerMessageSchema } from '@orbital/contracts';
import type { ServerMessage } from '@orbital/contracts';
import type { CommandContext, SimHub } from '../ports.js';
import type { AuthVerifier } from './auth.js';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  hub: SimHub;
  auth: AuthVerifier;
  contractsVersion?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Drop snapshots for clients that are this far behind (they get the next one). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

function tokenFrom(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('access_token');
  if (q) return q;
  const h = req.headers.authorization;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

function reject(socket: Duplex, status: number, text: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { hub, auth } = opts;
  const version = opts.contractsVersion ?? CONTRACTS_VERSION;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const ctxs = new WeakMap<IncomingMessage, CommandContext>();

  const http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, universes: hub.universeIds() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    auth(tokenFrom(req)).then(
      (ctx) => {
        if (socket.destroyed) return;
        ctxs.set(req, ctx);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      },
      () => reject(socket, 401, 'Unauthorized'),
    );
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ctx = ctxs.get(req);
    if (!ctx) {
      ws.close(1011, 'no auth context');
      return;
    }
    handleConnection(ws, ctx, hub, version);
  });

  // Ping every client; terminate the ones that never answered the previous ping.
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      try { ws.ping(); } catch { /* closing */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise<void>((resolve, reject_) => {
    http.once('error', reject_);
    http.listen(opts.port, opts.host, () => { http.off('error', reject_); resolve(); });
  });
  http.on('error', () => undefined);
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function handleConnection(ws: WebSocket, ctx: CommandContext, hub: SimHub, version: string): void {
  let unsubscribe: (() => void) | undefined;

  const send = (msg: ServerMessage): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const parsed = ServerMessageSchema.safeParse(msg);
    const out: ServerMessage = parsed.success ? parsed.data : { type: 'error', message: 'internal: invalid outgoing message' };
    try { ws.send(JSON.stringify(out)); } catch { /* socket went away */ }
  };
  const sendError = (message: string): void => send({ type: 'error', message });

  ws.on('error', () => undefined);
  ws.on('close', () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  const first = hub.universeIds()[0];
  if (first === undefined) sendError('no universes available');
  else send({ type: 'hello', contractsVersion: version, universeId: first, role: ctx.role });

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return sendError('binary messages are not supported');
    let json: unknown;
    try {
      json = JSON.parse(rawToString(data));
    } catch {
      return sendError('invalid JSON');
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendError(`invalid message: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unrecognised'}`);
    }
    const msg = parsed.data;

    if (msg.type === 'subscribe') {
      if (!hub.universeIds().includes(msg.universeId)) return sendError(`unknown universe: ${msg.universeId}`);
      unsubscribe?.();
      unsubscribe = undefined;
      try {
        unsubscribe = hub.subscribe(msg.universeId, (snapshot) => {
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
          send({ type: 'snapshot', snapshot });
        });
        const latest = hub.latest(msg.universeId);
        if (latest) send({ type: 'snapshot', snapshot: latest });
      } catch (e) {
        sendError(`subscribe failed: ${errMessage(e)}`);
      }
      return;
    }

    // command
    const ack = (ok: boolean, extra: { error?: string; forkedUniverseId?: string } = {}): void =>
      send({ type: 'command_ack', commandId: msg.commandId, ok, ...extra });
    if (ctx.role !== 'operator') return ack(false, { error: 'forbidden' });
    if (!hub.universeIds().includes(msg.universeId)) return ack(false, { error: `unknown universe: ${msg.universeId}` });
    Promise.resolve().then(() => hub.command(msg.universeId, msg.command, ctx)).then(
      (outcome) => ack(outcome.ok, {
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.forkedUniverseId !== undefined ? { forkedUniverseId: outcome.forkedUniverseId } : {}),
      }),
      (e) => ack(false, { error: errMessage(e) }),
    );
  });
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
