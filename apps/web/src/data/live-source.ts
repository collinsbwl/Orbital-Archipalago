import { ServerMessageSchema } from '@orbital/contracts';
import type { ClientMessage, GodModeCommand, UniverseId } from '@orbital/contracts';
import { StateStore } from './types';
import type { CommandAck, SnapshotSource, SourceState } from './types';

export interface LiveSourceOptions {
  url: string;
  /** Called before every (re)connect; the token goes on the handshake as `?access_token=`. */
  getToken?: () => Promise<string | undefined> | string | undefined;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  commandTimeoutMs?: number;
}

interface Pending {
  resolve: (ack: CommandAck) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LiveSource implements SnapshotSource {
  private readonly store = new StateStore();
  private ws: WebSocket | undefined;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private nextCommandId = 1;
  private readonly pending = new Map<string, Pending>();
  /** Universe the user picked; survives reconnects. */
  private chosen: UniverseId | undefined;

  constructor(private readonly opts: LiveSourceOptions) {}

  getState = (): SourceState => this.store.get();
  subscribe = (l: () => void): (() => void) => this.store.subscribe(l);

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.failPending('stopped');
  }

  setPlaybackSpeed(): void {
    /* the server sets the pace */
  }

  setPlaybackPaused(): void {
    /* server-side pause is a god-mode command */
  }

  selectUniverse(universeId: UniverseId): void {
    this.chosen = universeId;
    this.store.set({ universeId, snapshot: null });
    this.send({ type: 'subscribe', universeId });
  }

  sendCommand(universeId: UniverseId, command: GodModeCommand): Promise<CommandAck> {
    const commandId = String(this.nextCommandId++);
    return new Promise<CommandAck>((resolve) => {
      const timer = setTimeout(() => this.settle(commandId, { ok: false, error: 'timed out waiting for the engine' }), this.opts.commandTimeoutMs ?? 10_000);
      this.pending.set(commandId, { resolve, timer });
      if (!this.send({ type: 'command', commandId, universeId, command })) this.settle(commandId, { ok: false, error: 'not connected' });
    });
  }

  private settle(commandId: string, ack: CommandAck): void {
    const p = this.pending.get(commandId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(commandId);
    p.resolve(ack);
  }

  private failPending(error: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error });
  }

  private send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private async connect(): Promise<void> {
    let url = this.opts.url;
    try {
      const token = await this.opts.getToken?.();
      if (token) url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    } catch {
      /* connect anonymously */
    }
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.store.set({ connected: true, error: null });
    };
    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.store.set({ connected: false });
      this.failPending('disconnected');
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => undefined; // `close` follows
  }

  private scheduleReconnect(): void {
    const base = this.opts.backoffBaseMs ?? 500;
    const delay = Math.min(base * 2 ** this.attempt++, this.opts.backoffMaxMs ?? 15_000);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private onMessage(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return this.flag('invalid JSON from engine');
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return this.flag(`invalid message from engine: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    const msg = parsed.data;
    switch (msg.type) {
      case 'hello': {
        const universeId = this.chosen ?? msg.universeId;
        const universes = new Set([...this.store.get().universes, msg.universeId, universeId]);
        this.store.set({ role: msg.role, universeId, universes: [...universes] });
        this.send({ type: 'subscribe', universeId });
        return;
      }
      case 'snapshot':
        if (msg.snapshot.universeId === this.store.get().universeId) this.store.set({ snapshot: msg.snapshot, error: null });
        return;
      case 'command_ack': {
        const { forkedUniverseId } = msg;
        if (forkedUniverseId && !this.store.get().universes.includes(forkedUniverseId)) {
          this.store.set({ universes: [...this.store.get().universes, forkedUniverseId] });
        }
        this.settle(msg.commandId, { ok: msg.ok, ...(msg.error !== undefined ? { error: msg.error } : {}), ...(forkedUniverseId !== undefined ? { forkedUniverseId } : {}) });
        return;
      }
      case 'error':
        this.store.set({ error: msg.message });
    }
  }

  private flag(error: string): void {
    console.warn(error);
    this.store.set({ error });
  }
}
