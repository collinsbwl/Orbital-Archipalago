import type { GodModeCommand, Snapshot, UniverseId } from '@orbital/contracts';
import type { CommandContext, CommandOutcome, SeriesSource, SimHub } from './ports.js';
import type { Universe } from './universe.js';

export interface AuditEntry {
  universeId: UniverseId;
  cycle: number;
  sub: string;
  command: GodModeCommand;
  ok: boolean;
  error?: string;
}

export interface LiveRunnerOptions {
  universeId: UniverseId;
  universe: Universe;
  series: SeriesSource;
  /** Wall-clock pause between cycles. */
  intervalMs: number;
  /** Stop after this many cycles (default: run until stopped). */
  maxCycles?: number;
  /** Operator command audit (Tiger `god_mode_audit` in prod). */
  audit?: (entry: AuditEntry) => Promise<void>;
  onError?: (err: unknown) => void;
}

/** Drives one universe on a timer and serves it to the WebSocket server. A4 adds the remaining god-mode commands. */
export class LiveRunner implements SimHub {
  private readonly listeners = new Set<(s: Snapshot) => void>();
  private last: Snapshot | undefined;
  private paused = false;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: LiveRunnerOptions) {}

  universeIds(): UniverseId[] {
    return [this.opts.universeId];
  }

  latest(id: UniverseId): Snapshot | undefined {
    return id === this.opts.universeId ? this.last : undefined;
  }

  subscribe(id: UniverseId, fn: (s: Snapshot) => void): () => void {
    if (id !== this.opts.universeId) return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async command(id: UniverseId, command: GodModeCommand, ctx: CommandContext): Promise<CommandOutcome> {
    let outcome: CommandOutcome;
    if (id !== this.opts.universeId) outcome = { ok: false, error: 'unknown_universe' };
    else if (ctx.role !== 'operator') outcome = { ok: false, error: 'forbidden' };
    else if (command.kind === 'pause' || command.kind === 'resume') {
      this.paused = command.kind === 'pause';
      outcome = { ok: true };
      await this.publish();
    } else outcome = { ok: false, error: 'not_implemented' };
    if (this.opts.audit) {
      await this.opts.audit({ universeId: id, cycle: this.opts.universe.cycle, sub: ctx.sub, command, ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}) });
    }
    return outcome;
  }

  /** Run one cycle (unless paused) and broadcast the snapshot. */
  async tick(): Promise<void> {
    if (!this.paused) await this.opts.universe.step();
    await this.publish();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.opts.onError?.(err);
      }
      const done = this.opts.maxCycles !== undefined && this.opts.universe.cycle >= this.opts.maxCycles;
      if (done) this.paused = true;
      if (this.running) this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async publish(): Promise<void> {
    const series = await this.opts.series.readSeries(this.opts.universeId);
    this.last = await this.opts.universe.snapshot({ series, paused: this.paused });
    for (const fn of this.listeners) fn(this.last);
  }
}
