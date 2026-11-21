import { SnapshotSchema } from '@orbital/contracts';
import type { Snapshot } from '@orbital/contracts';
import { StateStore } from './types';
import type { CommandAck, SnapshotSource, SourceState } from './types';

export interface FixtureSourceOptions {
  url?: string;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

/** Plays recorded snapshots, one per interval, looping. Read-only: commands are refused. */
export class FixtureSource implements SnapshotSource {
  private readonly store = new StateStore();
  private snapshots: Snapshot[] = [];
  private index = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FixtureSourceOptions = {}) {
    this.url = opts.url ?? '/fixtures/snapshots.json';
    this.intervalMs = opts.intervalMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** Use a pre-loaded list instead of fetching (tests). */
  load(snapshots: Snapshot[]): void {
    this.snapshots = snapshots;
    this.index = 0;
    this.show();
  }

  getState = (): SourceState => this.store.get();
  subscribe = (l: () => void): (() => void) => this.store.subscribe(l);

  start(): void {
    this.stopped = false;
    this.store.set({ role: 'spectator' });
    void this.fetchImpl(this.url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`fixtures: HTTP ${r.status}`))))
      .then((json) => {
        if (this.stopped) return;
        this.load(SnapshotSchema.array().min(1).parse(json));
        this.resume();
      })
      .catch((e: unknown) => this.store.set({ error: e instanceof Error ? e.message : String(e) }));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  setPlaybackPaused(paused: boolean): void {
    this.store.set({ playbackPaused: paused });
    if (paused) this.pause();
    else if (this.snapshots.length > 0 && !this.stopped) this.resume();
  }

  sendCommand(): Promise<CommandAck> {
    return Promise.resolve({ ok: false, error: 'fixture mode is read-only' });
  }

  selectUniverse(): void {
    /* single recorded universe */
  }

  /** Advance one snapshot (also driven by the timer). */
  tick(): void {
    this.index = (this.index + 1) % this.snapshots.length;
    this.show();
  }

  private pause(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private resume(): void {
    this.pause();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  private show(): void {
    const snapshot = this.snapshots[this.index];
    if (!snapshot) return;
    this.store.set({ snapshot, connected: true, universeId: snapshot.universeId, universes: [snapshot.universeId], error: null });
  }
}
