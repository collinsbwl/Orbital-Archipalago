import type { GodModeCommand, Snapshot, UniverseId } from '@orbital/contracts';

export type Role = 'spectator' | 'operator';
export type Mode = 'live' | 'fixture';

export interface CommandAck {
  ok: boolean;
  error?: string;
  forkedUniverseId?: UniverseId;
}

export interface SourceState {
  snapshot: Snapshot | null;
  /** Server-decided role (from `hello`); null until known. Fixtures are always spectators. */
  role: Role | null;
  connected: boolean;
  /** Universe currently shown. */
  universeId: UniverseId | null;
  /** Universes known to this client (hello + forks it created). */
  universes: UniverseId[];
  /** Last protocol/server error, e.g. a schema-invalid message or an `error` envelope. */
  error: string | null;
  /** Fixture playback paused locally (fixture mode only). */
  playbackPaused: boolean;
  /** Fixture playback speed multiplier: 1 is normal (fixture mode only). */
  playbackSpeed: number;
}

export const INITIAL_STATE: SourceState = {
  snapshot: null, role: null, connected: false, universeId: null, universes: [], error: null, playbackPaused: false, playbackSpeed: 1,
};

export interface SnapshotSource {
  getState(): SourceState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  sendCommand(universeId: UniverseId, command: GodModeCommand): Promise<CommandAck>;
  selectUniverse(universeId: UniverseId): void;
  /** Local playback control; a no-op for live sources (the server owns pause there). */
  setPlaybackPaused(paused: boolean): void;
  /** Local playback speed (1 = normal); a no-op for live sources, where the server sets the pace. */
  setPlaybackSpeed(speed: number): void;
}

/** Tiny observable state holder shared by both sources. */
export class StateStore {
  private state: SourceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  get = (): SourceState => this.state;
  set(patch: Partial<SourceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}
