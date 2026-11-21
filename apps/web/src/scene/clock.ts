const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_000;

/**
 * Turns "a snapshot arrived for cycle N" into a smooth fractional cycle, so planets and ships glide instead of jumping.
 * It learns how long a cycle takes from the gaps between snapshots, and never runs ahead of the next one (the fraction
 * stops just short of N + 1 until the next snapshot arrives). Time is passed in, so it is easy to test.
 */
export class CycleClock {
  private cycle = -1;
  private arrivedAt = 0;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private measured = false;
  /** The fractional cycle at the moment time froze; null while running. */
  private held: number | null = null;

  /** Call when a snapshot for `cycle` arrives. Repeats of the same cycle are ignored. */
  observe(cycle: number, nowMs: number): void {
    if (cycle === this.cycle) return;
    if (this.cycle >= 0 && cycle > this.cycle) {
      const perCycle = (nowMs - this.arrivedAt) / (cycle - this.cycle);
      if (perCycle >= MIN_INTERVAL_MS && perCycle <= MAX_INTERVAL_MS) {
        this.intervalMs = this.measured ? this.intervalMs * 0.5 + perCycle * 0.5 : perCycle;
        this.measured = true;
      }
    }
    this.cycle = cycle;
    this.arrivedAt = nowMs;
    this.held = null;
  }

  /** The cycle to draw right now, as a fraction. While `frozen` it stays where it was. */
  now(nowMs: number, frozen: boolean): number {
    if (this.cycle < 0) return 0;
    const running = () => this.cycle + Math.min(0.999, Math.max(0, (nowMs - this.arrivedAt) / this.intervalMs));
    if (frozen) {
      this.held ??= running();
      return this.held;
    }
    if (this.held !== null) {
      // Resume from where it froze, as if no time had passed.
      this.arrivedAt = nowMs - (this.held - this.cycle) * this.intervalMs;
      this.held = null;
    }
    return running();
  }

  /** Milliseconds per cycle as currently estimated. */
  get cycleMs(): number {
    return this.intervalMs;
  }
}
