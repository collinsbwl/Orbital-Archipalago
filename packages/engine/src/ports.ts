import type { ChartSeries, GodModeCommand, Snapshot, UniverseId } from '@orbital/contracts';

/** Where per-cycle metrics go (Tiger Data in prod, memory in tests). */
export interface MetricsSink {
  writeCycle(snapshot: Snapshot): Promise<void>;
}

/** Where `Snapshot.series` comes from (Tiger continuous aggregates in prod, memory in tests). */
export interface SeriesSource {
  readSeries(universeId: UniverseId): Promise<ChartSeries[]>;
}

export type ViewerRole = 'spectator' | 'operator';

export interface CommandContext {
  /** Auth0 `sub` of the caller (or a dev placeholder when auth is disabled). */
  sub: string;
  role: ViewerRole;
}

export interface CommandOutcome {
  ok: boolean;
  error?: string;
  forkedUniverseId?: UniverseId;
}

/** What the WebSocket server needs from the running sim. */
export interface SimHub {
  universeIds(): UniverseId[];
  latest(universeId: UniverseId): Snapshot | undefined;
  /** Called with every new snapshot of that universe. Returns an unsubscribe function. */
  subscribe(universeId: UniverseId, fn: (snapshot: Snapshot) => void): () => void;
  command(universeId: UniverseId, command: GodModeCommand, ctx: CommandContext): Promise<CommandOutcome>;
}
