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
  /** The primary universe; more arrive through `fork` commands. */
  universeId: UniverseId;
  universe: Universe;
  series: SeriesSource;
  /** Wall-clock pause between cycles. */
  intervalMs: number;
  /** Stop each universe after this many cycles (default: run until stopped). */
  maxCycles?: number;
  /** Operator command audit (Tiger `god_mode_audit` in prod). */
  audit?: (entry: AuditEntry) => Promise<void>;
  /** Called with every forked universe before it starts running (e.g. to register it with Tiger). A throw fails the fork. */
  onFork?: (id: UniverseId, universe: Universe) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

interface Entry {
  universe: Universe;
  paused: boolean;
  last: Snapshot | undefined;
}

const MAX_ID = 64;

/** Drives every universe (the primary one and its forks) from one timer, in registration order, and serves them to the WebSocket server. */
export class LiveRunner implements SimHub {
  private readonly listeners = new Map<UniverseId, Set<(s: Snapshot) => void>>();
  private readonly universes = new Map<UniverseId, Entry>();
  private forkSeq = 0;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** Serializes ticks and forks, so a fork never copies a universe mid-step. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LiveRunnerOptions) {
    this.universes.set(opts.universeId, { universe: opts.universe, paused: false, last: undefined });
  }

  universeIds(): UniverseId[] {
    return [...this.universes.keys()];
  }

  latest(id: UniverseId): Snapshot | undefined {
    return this.universes.get(id)?.last;
  }

  subscribe(id: UniverseId, fn: (s: Snapshot) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    const subs = set;
    subs.add(fn);
    return () => subs.delete(fn);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async command(id: UniverseId, command: GodModeCommand, ctx: CommandContext): Promise<CommandOutcome> {
    const entry = this.universes.get(id);
    let outcome: CommandOutcome;
    if (!entry) outcome = { ok: false, error: 'unknown_universe' };
    else if (ctx.role !== 'operator') outcome = { ok: false, error: 'forbidden' };
    else {
      try {
        outcome = await this.apply(id, entry, command, ctx);
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    if (this.opts.audit) {
      await this.opts.audit({ universeId: id, cycle: entry?.universe.cycle ?? 0, sub: ctx.sub, command, ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}) });
    }
    return outcome;
  }

  private async apply(id: UniverseId, entry: Entry, command: GodModeCommand, ctx: CommandContext): Promise<CommandOutcome> {
    if (command.kind === 'pause' || command.kind === 'resume') {
      entry.paused = command.kind === 'pause';
      await this.publish(id, entry);
      return { ok: true };
    }
    if (command.kind === 'fork') {
      return this.exclusive(async () => {
        const forkedId = this.nextForkId(id);
        const forked = await entry.universe.fork(forkedId);
        await this.opts.onFork?.(forkedId, forked);
        const fe: Entry = { universe: forked, paused: false, last: undefined };
        this.universes.set(forkedId, fe);
        await this.publish(forkedId, fe);
        return { ok: true, forkedUniverseId: forkedId };
      });
    }
    entry.universe.enqueue(command, { sub: ctx.sub });
    return { ok: true };
  }

  /** `${id}-f${n}` with n increasing per runner; the base id is trimmed so the whole id stays within 64 chars. */
  private nextForkId(id: UniverseId): UniverseId {
    for (;;) {
      const suffix = `-f${++this.forkSeq}`;
      const forkedId = `${id.slice(0, MAX_ID - suffix.length)}${suffix}`;
      if (!this.universes.has(forkedId)) return forkedId;
    }
  }

  /** Run one cycle of every universe that is not paused (in registration order) and broadcast the snapshots. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      for (const [id, e] of [...this.universes]) {
        if (!e.paused) await e.universe.step();
        await this.publish(id, e);
      }
    });
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
      const max = this.opts.maxCycles;
      if (max !== undefined) for (const e of this.universes.values()) if (e.universe.cycle >= max) e.paused = true;
      if (this.running) this.timer = setTimeout(loop, this.opts.intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async publish(id: UniverseId, e: Entry): Promise<void> {
    const series = await this.opts.series.readSeries(id);
    e.last = await e.universe.snapshot({ series, paused: e.paused });
    for (const fn of this.listeners.get(id) ?? []) fn(e.last);
  }
}
