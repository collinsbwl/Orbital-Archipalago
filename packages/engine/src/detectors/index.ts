import type { ArriveResult, FxAuctionResult, PlanetId, PolicyState } from '@orbital/contracts';

/**
 * Auto-detectors (A4): pure, deterministic watchers over per-cycle data that turn patterns
 * (trade war, currency crisis, recession, trade diversion, confidence collapse) into events.
 * No clocks, no randomness, no I/O. State is plain JSON so forks can copy it.
 */

export type DetectorKind = 'trade_war' | 'currency_crisis' | 'recession' | 'trade_diversion' | 'confidence_collapse' | 'exodus';

export interface DetectedEvent {
  detector: DetectorKind;
  cycle: number;
  planet?: PlanetId;
  /** Human-readable, at most 280 characters. */
  text: string;
}

/** One cycle's data. Build it from CycleReport plus `ledger.getPolicy` for each planet. */
export interface DetectorInput {
  cycle: number;
  metrics: Record<PlanetId, { gdp: number; consumerConfidence: number; businessConfidence: number; population?: number; netMigration?: number }>;
  policies: Record<PlanetId, PolicyState>;
  fx: FxAuctionResult[];
  arrivals: ArriveResult[];
}

export const DETECTOR_CONFIG = {
  /** Cycles of history kept (bounds memory). */
  historyCycles: 60,
  /** No events before this cycle: start-up values (placeholder confidence 50, CPI at base prices) aren't signal. History is still recorded. */
  warmupCycles: 10,
  tradeWar: {
    /** Two planets' tariff raises must fall within this many cycles of each other. */
    raiseWindowCycles: 10,
    /** Each planet must have received a delivered arrival from the other within this many cycles. */
    tradeLinkCycles: 30,
    cooldownCycles: 20,
  },
  currencyCrisis: {
    lookbackCycles: 5,
    /** Fires when |rate / rate[lookback ago] - 1| is strictly greater than this. */
    moveFraction: 0.2,
    cooldownCycles: 10,
  },
  recession: {
    bucketCycles: 5,
    /** Fewest per-cycle samples for a bucket mean to count; a thinner bucket resets the run. */
    minBucketSamples: 3,
    /** Consecutive strictly lower bucket means required. */
    consecutiveFalls: 2,
    /** Cumulative fall from the run's starting mean, as a fraction (0.05 = 5%). */
    minCumulativeFall: 0.05,
  },
  tradeDiversion: {
    windowCycles: 15,
    /** Minimum delivered units in each window for the comparison to count. */
    minQty: 10,
    /** Fires when any origin's share moves by at least this many percentage points. */
    shareShiftPoints: 30,
  },
  confidenceCollapse: {
    windowCycles: 10,
    /** Fires when the index falls strictly more than this many points from its max in the window. */
    dropPoints: 20,
    cooldownCycles: 10,
  },
  exodus: {
    windowCycles: 50,
    /** Fires when net outflow over the window exceeds this share of the planet's population, bp (500 = 5%). */
    outflowBp: 500,
    cooldownCycles: 25,
  },
} as const;

interface BucketState {
  bucket: number;
  sum: number;
  count: number;
}

interface RecessionState {
  cur: BucketState | null;
  lastMean: number | null;
  runPeak: number;
  runFalls: number;
  inRecession: boolean;
}

interface DeliveryRow {
  c: number;
  /** Destination planet. */
  d: string;
  good: string;
  /** Origin planet. */
  o: string;
  q: number;
}

interface PendingDiversion {
  dest: PlanetId;
  /** Null aggregates every good delivered to `dest` (embargo trigger). */
  good: string | null;
  changeCycle: number;
  reason: 'tariff' | 'embargo';
}

export interface DetectorState {
  lastCycle: number | null;
  prevTariffs: Record<PlanetId, Record<string, number>>;
  prevEmbargoes: Record<PlanetId, string[]>;
  lastRaise: Record<PlanetId, number>;
  /** `from>to` -> last cycle with a delivered arrival. */
  lastDelivery: Record<string, number>;
  fxHist: Record<string, { cycle: number; ppm: number }[]>;
  recession: Record<PlanetId, RecessionState>;
  deliveries: DeliveryRow[];
  pending: PendingDiversion[];
  /** `planet|consumer` / `planet|business` -> [cycle, value][]. */
  conf: Record<string, [number, number][]>;
  /** planet -> [cycle, netMigration][] over the exodus window (non-zero cycles only). */
  mig: Record<PlanetId, [number, number][]>;
  /** `detector:key` -> cycle last fired. */
  cooldowns: Record<string, number>;
}

function emptyState(): DetectorState {
  return {
    lastCycle: null, prevTariffs: {}, prevEmbargoes: {}, lastRaise: {}, lastDelivery: {}, fxHist: {},
    recession: {}, deliveries: [], pending: [], conf: {}, mig: {}, cooldowns: {},
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort(cmp);

function label(planet: string): string {
  const s = planet.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ev(detector: DetectorKind, cycle: number, text: string, planet?: PlanetId): DetectedEvent {
  const e: DetectedEvent = { detector, cycle, text: text.length > 280 ? text.slice(0, 279) + '…' : text };
  if (planet !== undefined) e.planet = planet;
  return e;
}

export class Detectors {
  private s: DetectorState = emptyState();

  /** `warmupCycles` defaults to DETECTOR_CONFIG.warmupCycles (tests on hand-built sequences pass 0). */
  constructor(private readonly opts: { warmupCycles?: number } = {}) {}

  getState(): DetectorState {
    return JSON.parse(JSON.stringify(this.s)) as DetectorState;
  }

  setState(state: DetectorState): void {
    this.s = { ...emptyState(), ...(JSON.parse(JSON.stringify(state)) as DetectorState) };
  }

  /** Feed one cycle (cycles must increase; a repeated or older cycle is ignored). Returns newly detected events. */
  observe(input: DetectorInput): DetectedEvent[] {
    const s = this.s;
    const cycle = input.cycle;
    if (s.lastCycle !== null && cycle <= s.lastCycle) return [];
    s.lastCycle = cycle;

    this.recordArrivals(input);
    const { raises, embargoAdds } = this.diffPolicies(input);

    const out: DetectedEvent[] = [];
    out.push(...this.tradeWar(cycle, raises));
    out.push(...this.currencyCrisis(input));
    out.push(...this.recession(input));
    this.queueDiversions(cycle, raises, embargoAdds);
    out.push(...this.tradeDiversion(cycle));
    out.push(...this.confidenceCollapse(input));
    out.push(...this.exodus(input));

    this.prune(cycle);
    return cycle < (this.opts.warmupCycles ?? DETECTOR_CONFIG.warmupCycles) ? [] : out;
  }

  // ---- shared bookkeeping --------------------------------------------------

  private cooledDown(key: string, cycle: number, cooldown: number): boolean {
    const last = this.s.cooldowns[key];
    return last === undefined || cycle - last >= cooldown;
  }

  private recordArrivals(input: DetectorInput): void {
    const s = this.s;
    for (const a of input.arrivals) {
      const delivered = a.delivered.filter((c) => c.qty > 0);
      if (delivered.length === 0) continue;
      const { from, to } = a.shipment;
      s.lastDelivery[`${from}>${to}`] = input.cycle;
      for (const c of delivered) {
        const row = s.deliveries.find((r) => r.c === input.cycle && r.d === to && r.good === c.good && r.o === from);
        if (row) row.q += c.qty;
        else s.deliveries.push({ c: input.cycle, d: to, good: c.good, o: from, q: c.qty });
      }
    }
  }

  /** Tariff raises (planet -> goods raised) and embargo additions (planet -> targets) versus the previous cycle. */
  private diffPolicies(input: DetectorInput): { raises: Record<PlanetId, string[]>; embargoAdds: Record<PlanetId, string[]> } {
    const s = this.s;
    const raises: Record<PlanetId, string[]> = {};
    const embargoAdds: Record<PlanetId, string[]> = {};
    for (const planet of sortedKeys(input.policies)) {
      const pol = input.policies[planet];
      if (!pol) continue;
      const prevT = s.prevTariffs[planet];
      const prevE = s.prevEmbargoes[planet];
      if (prevT !== undefined) {
        for (const good of sortedKeys(pol.tariffsBp)) {
          const now = pol.tariffsBp[good] ?? 0;
          if (now > (prevT[good] ?? 0)) (raises[planet] ??= []).push(good);
        }
      }
      if (prevE !== undefined) {
        for (const target of [...pol.embargoes].sort(cmp)) {
          if (!prevE.includes(target)) (embargoAdds[planet] ??= []).push(target);
        }
      }
      s.prevTariffs[planet] = { ...pol.tariffsBp };
      s.prevEmbargoes[planet] = [...pol.embargoes];
    }
    for (const planet of Object.keys(raises)) s.lastRaise[planet] = input.cycle;
    return { raises, embargoAdds };
  }

  // ---- trade war ---------------------------------------------------------

  private tradeWar(cycle: number, raises: Record<PlanetId, string[]>): DetectedEvent[] {
    const s = this.s;
    const cfg = DETECTOR_CONFIG.tradeWar;
    const out: DetectedEvent[] = [];
    const linked = (from: string, to: string): boolean => {
      const last = s.lastDelivery[`${from}>${to}`];
      return last !== undefined && cycle - last <= cfg.tradeLinkCycles;
    };
    for (const p of sortedKeys(raises)) {
      for (const o of sortedKeys(s.lastRaise)) {
        if (o === p) continue;
        const gap = cycle - (s.lastRaise[o] ?? -Infinity);
        if (gap > cfg.raiseWindowCycles) continue;
        const [a, b] = p < o ? [p, o] : [o, p];
        const key = `trade_war:${a}|${b}`;
        if (!this.cooledDown(key, cycle, cfg.cooldownCycles)) continue;
        if (!linked(a, b) || !linked(b, a)) continue;
        s.cooldowns[key] = cycle;
        const span = Math.abs((s.lastRaise[a] ?? cycle) - (s.lastRaise[b] ?? cycle));
        out.push(ev('trade_war', cycle, `Trade war: ${label(a)} and ${label(b)} raised tariffs within ${span} cycles`));
      }
    }
    return out;
  }

  // ---- currency crisis ---------------------------------------------------

  private currencyCrisis(input: DetectorInput): DetectedEvent[] {
    const s = this.s;
    const cfg = DETECTOR_CONFIG.currencyCrisis;
    const observed: Record<string, number> = {};
    for (const r of input.fx) if (r.ratePpm !== null) observed[`${r.base}/${r.quote}`] = r.ratePpm;
    const keys = [...new Set([...Object.keys(s.fxHist), ...Object.keys(observed)])].sort(cmp);
    const out: DetectedEvent[] = [];
    for (const pair of keys) {
      const hist = (s.fxHist[pair] ??= []);
      const ppm = observed[pair] ?? hist[hist.length - 1]?.ppm; // carry the last known rate
      if (ppm === undefined) continue;
      hist.push({ cycle: input.cycle, ppm });
      const from = input.cycle - cfg.lookbackCycles;
      while (hist.length > 0 && (hist[0]?.cycle ?? 0) < from) hist.shift();
      const ref = hist.find((h) => h.cycle === from);
      if (!ref || ref.ppm <= 0) continue;
      const change = (ppm - ref.ppm) / ref.ppm;
      if (Math.abs(change) <= cfg.moveFraction) continue;
      const key = `currency_crisis:${pair}`;
      if (!this.cooledDown(key, input.cycle, cfg.cooldownCycles)) continue;
      s.cooldowns[key] = input.cycle;
      const [base, quote] = pair.split('/') as [string, string];
      const pct = Math.round(Math.abs(change) * 100);
      const weak = change > 0 ? quote : base;
      out.push(ev('currency_crisis', input.cycle, `Currency crisis: ${pair} moved ${change > 0 ? '+' : '-'}${pct}% in ${cfg.lookbackCycles} cycles (${weak} depreciated)`));
    }
    return out;
  }

  // ---- recession ---------------------------------------------------------

  private recession(input: DetectorInput): DetectedEvent[] {
    const s = this.s;
    const cfg = DETECTOR_CONFIG.recession;
    const out: DetectedEvent[] = [];
    const bucket = Math.floor(input.cycle / cfg.bucketCycles);
    for (const planet of sortedKeys(input.metrics)) {
      const m = input.metrics[planet];
      if (!m) continue;
      const st = (s.recession[planet] ??= { cur: null, lastMean: null, runPeak: 0, runFalls: 0, inRecession: false });
      if (st.cur && st.cur.bucket < bucket) out.push(...this.closeBucket(planet, st, input.cycle));
      if (!st.cur) st.cur = { bucket, sum: 0, count: 0 };
      st.cur.sum += m.gdp;
      st.cur.count++;
      if (input.cycle % cfg.bucketCycles === cfg.bucketCycles - 1) out.push(...this.closeBucket(planet, st, input.cycle));
    }
    return out;
  }

  private closeBucket(planet: PlanetId, st: RecessionState, cycle: number): DetectedEvent[] {
    const cfg = DETECTOR_CONFIG.recession;
    const cur = st.cur;
    st.cur = null;
    if (!cur) return [];
    if (cur.count < cfg.minBucketSamples) {
      st.lastMean = null;
      st.runFalls = 0;
      return [];
    }
    const mean = cur.sum / cur.count;
    const prev = st.lastMean;
    st.lastMean = mean;
    if (prev === null) return [];
    if (mean > prev) {
      st.runFalls = 0;
      st.inRecession = false;
      return [];
    }
    if (mean === prev) {
      st.runFalls = 0;
      return [];
    }
    if (st.runFalls === 0) st.runPeak = prev;
    st.runFalls++;
    if (st.inRecession || st.runFalls < cfg.consecutiveFalls || st.runPeak <= 0) return [];
    const fall = (st.runPeak - mean) / st.runPeak;
    if (fall < cfg.minCumulativeFall) return [];
    st.inRecession = true;
    const pct = (fall * 100).toFixed(1);
    return [ev('recession', cycle, `Recession: ${label(planet)} GDP fell ${pct}% over ${st.runFalls} consecutive ${cfg.bucketCycles}-cycle periods`, planet)];
  }

  // ---- trade diversion ---------------------------------------------------

  private queueDiversions(cycle: number, raises: Record<PlanetId, string[]>, embargoAdds: Record<PlanetId, string[]>): void {
    const s = this.s;
    const add = (dest: PlanetId, good: string | null, reason: 'tariff' | 'embargo'): void => {
      if (s.pending.some((p) => p.dest === dest && p.good === good)) return;
      s.pending.push({ dest, good, changeCycle: cycle, reason });
    };
    for (const dest of sortedKeys(raises)) for (const good of raises[dest] ?? []) add(dest, good, 'tariff');
    for (const dest of sortedKeys(embargoAdds)) add(dest, null, 'embargo');
  }

  /**
   * Windows (W = windowCycles): before = [c-W+1, c], after = [c+1, c+W] where c is the cycle the policy change
   * was observed (the change took effect after cycle c's arrivals). Evaluated once cycle c+W has been observed.
   */
  private tradeDiversion(cycle: number): DetectedEvent[] {
    const s = this.s;
    const cfg = DETECTOR_CONFIG.tradeDiversion;
    const W = cfg.windowCycles;
    const out: DetectedEvent[] = [];
    const remaining: PendingDiversion[] = [];
    for (const p of s.pending) {
      if (cycle < p.changeCycle + W) {
        remaining.push(p);
        continue;
      }
      const share = (lo: number, hi: number): { total: number; by: Record<string, number> } => {
        const by: Record<string, number> = {};
        let total = 0;
        for (const r of s.deliveries) {
          if (r.d !== p.dest || r.c < lo || r.c > hi) continue;
          if (p.good !== null && r.good !== p.good) continue;
          by[r.o] = (by[r.o] ?? 0) + r.q;
          total += r.q;
        }
        return { total, by };
      };
      const before = share(p.changeCycle - W + 1, p.changeCycle);
      const after = share(p.changeCycle + 1, p.changeCycle + W);
      if (before.total < cfg.minQty || after.total < cfg.minQty) continue;
      const top = (by: Record<string, number>): string => {
        let best = '';
        for (const o of sortedKeys(by)) if (best === '' || (by[o] ?? 0) > (by[best] ?? 0)) best = o;
        return best;
      };
      const topB = top(before.by), topA = top(after.by);
      let maxShift = 0;
      for (const o of new Set([...Object.keys(before.by), ...Object.keys(after.by)])) {
        const d = Math.abs((after.by[o] ?? 0) / after.total - (before.by[o] ?? 0) / before.total) * 100;
        if (d > maxShift) maxShift = d;
      }
      if (topB === topA && maxShift < cfg.shareShiftPoints) continue;
      const pctB = Math.round(((before.by[topB] ?? 0) / before.total) * 100);
      const pctA = Math.round(((after.by[topA] ?? 0) / after.total) * 100);
      const what = p.good === null ? 'imports' : `${p.good} imports`;
      const cause = p.reason === 'tariff' ? 'raising its tariff' : 'adding an embargo';
      const text = topB !== topA
        ? `Trade diversion: ${label(p.dest)}'s ${what} shifted from ${label(topB)} (${pctB}%) to ${label(topA)} (${pctA}%) after ${cause}`
        : `Trade diversion: ${label(p.dest)}'s ${what} mix moved ${Math.round(maxShift)} points away from ${label(topB)} after ${cause}`;
      out.push(ev('trade_diversion', cycle, text, p.dest));
    }
    s.pending = remaining;
    return out;
  }

  // ---- confidence collapse -----------------------------------------------

  private confidenceCollapse(input: DetectorInput): DetectedEvent[] {
    const s = this.s;
    const cfg = DETECTOR_CONFIG.confidenceCollapse;
    const out: DetectedEvent[] = [];
    for (const planet of sortedKeys(input.metrics)) {
      const m = input.metrics[planet];
      if (!m) continue;
      for (const [idx, value] of [['consumer', m.consumerConfidence], ['business', m.businessConfidence]] as const) {
        const hk = `${planet}|${idx}`;
        const hist = (s.conf[hk] ??= []);
        hist.push([input.cycle, value]);
        const from = input.cycle - cfg.windowCycles;
        while (hist.length > 0 && (hist[0]?.[0] ?? 0) < from) hist.shift();
        const peak = Math.max(...hist.map((h) => h[1]));
        const drop = peak - value;
        if (drop <= cfg.dropPoints) continue;
        const key = `confidence_collapse:${hk}`;
        if (!this.cooledDown(key, input.cycle, cfg.cooldownCycles)) continue;
        s.cooldowns[key] = input.cycle;
        out.push(ev('confidence_collapse', input.cycle, `Confidence collapse: ${label(planet)} ${idx} confidence fell ${Math.round(drop)} points in ${cfg.windowCycles} cycles`, planet));
      }
    }
    return out;
  }

  // ---- exodus ------------------------------------------------------------

  private exodus(input: DetectorInput): DetectedEvent[] {
    const s = this.s;
    const cfg = DETECTOR_CONFIG.exodus;
    const out: DetectedEvent[] = [];
    for (const planet of sortedKeys(input.metrics)) {
      const m = input.metrics[planet];
      if (!m || m.netMigration === undefined) continue;
      const hist = (s.mig[planet] ??= []);
      if (m.netMigration !== 0) hist.push([input.cycle, m.netMigration]);
      const from = input.cycle - cfg.windowCycles;
      while (hist.length > 0 && (hist[0]?.[0] ?? 0) <= from) hist.shift();
      const net = hist.reduce((sum, h) => sum + h[1], 0);
      const pop = m.population ?? 0;
      if (net >= 0 || pop <= 0 || -net * 10_000 <= cfg.outflowBp * pop) continue;
      const key = `exodus:${planet}`;
      if (!this.cooledDown(key, input.cycle, cfg.cooldownCycles)) continue;
      s.cooldowns[key] = input.cycle;
      const pct = ((-net * 100) / pop).toFixed(1);
      out.push(ev('exodus', input.cycle, `Exodus: ${label(planet)} lost ${(-net).toLocaleString('en-US')} people (${pct}% of its population) to migration in ${cfg.windowCycles} cycles`, planet));
    }
    return out;
  }

  // ---- memory bound ------------------------------------------------------

  private prune(cycle: number): void {
    const s = this.s;
    const keep = cycle - DETECTOR_CONFIG.historyCycles;
    s.deliveries = s.deliveries.filter((r) => r.c >= keep);
    for (const k of Object.keys(s.lastDelivery)) if ((s.lastDelivery[k] ?? 0) < keep) delete s.lastDelivery[k];
    for (const k of Object.keys(s.lastRaise)) if ((s.lastRaise[k] ?? 0) < keep) delete s.lastRaise[k];
    for (const k of Object.keys(s.cooldowns)) if ((s.cooldowns[k] ?? 0) < keep) delete s.cooldowns[k];
    s.pending = s.pending.filter((p) => p.changeCycle >= keep);
  }
}
