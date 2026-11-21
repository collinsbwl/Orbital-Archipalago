import { LedgerError } from '@orbital/contracts';
import type {
  ArriveResult, AuctionResult, ChartSeries, FxAuctionResult, GoodId, Ledger, Loan, PlanetId, Shipment, SimEvent, Snapshot, SurveyAnswer,
  WorldConfig,
} from '@orbital/contracts';
import { listAgents } from './agents.js';
import type { AgentInfo, DecisionProvider } from './agents.js';
import { bootstrap } from './bootstrap.js';
import { fxKey, fxPairs, fxViews } from './fx.js';
import { MarketBook } from './market-book.js';
import { INITIAL_CONFIDENCE, CPI_BASE, computeMetrics } from './metrics.js';
import type { PlanetMetrics } from './metrics.js';
import { buildTasks } from './observation.js';
import { orbitPhase, travelCycles } from './orbits.js';
import { runConsumption } from './phases/consumption.js';
import { runProduction } from './phases/production.js';
import type { Counts } from './phases/production.js';
import type { MetricsSink } from './ports.js';
import { RESERVE_BANK_CONFIG, inflationBp, outputGapBp, taylorRateBp } from './reserve-bank.js';
import { schedule } from './scheduler.js';
import { borrowCapsOf, validateDecisions } from './validator.js';
import type { KnownIds } from './validator.js';

/** Value of delivered cargo per planet, in that planet's currency (see `Universe.runArrivals`). */
export interface TradeFlow {
  exports: number;
  imports: number;
}

/** Plain data, JSON-safe. */
export interface CycleReport {
  cycle: number;
  auctions: AuctionResult[];
  produced: Counts;
  unmet: Counts;
  /** Validator rejections. */
  rejections: number;
  placeOrdersRejected: number;
  fxOrdersRejected: number;
  /** Ledger errors on cancels and ship departures (never fatal). */
  ledgerRejections: number;
  departures: Shipment[];
  arrivals: ArriveResult[];
  fx: FxAuctionResult[];
  /** Per-planet trade flows of this cycle's arrivals, for A3 metrics. */
  tradeFlows: Record<PlanetId, TradeFlow>;
  /** Per-planet metrics of this cycle. */
  metrics: Record<PlanetId, PlanetMetrics>;
  /** Loans that went unpaid past their due cycle for the first time this cycle. */
  defaults: number;
}

/** Cycles of metrics kept in memory, and the number of events in `Snapshot.events`. */
export const HISTORY_CYCLES = 1_000;
export const MAX_EVENTS = 50;

export interface UniverseOptions {
  world: WorldConfig;
  ledger: Ledger;
  agents: DecisionProvider;
  /** Throw if `ledger.checkInvariants()` fails after a cycle. Default true. */
  checkInvariants?: boolean;
  /** If present, `step()` writes the cycle's snapshot (with empty `series`) to it. */
  sink?: MetricsSink;
}

export class Universe {
  readonly book = new MarketBook();
  private readonly world: WorldConfig;
  private readonly ledger: Ledger;
  private readonly provider: DecisionProvider;
  private readonly check: boolean;
  private readonly roster: AgentInfo[];
  private readonly known: KnownIds;
  private readonly memos = new Map<string, string>();
  /** Where each trader's freighter is: a planet id when docked, null while in flight. */
  private readonly location = new Map<string, PlanetId | null>();
  /** In-flight shipments in departure (= shipment id) order. */
  private readonly flights = new Map<string, Shipment>();
  /** Last non-null clearing rate (ppm quote per base) per canonical pair. */
  private readonly fxRates = new Map<string, number>();
  private readonly sink: MetricsSink | undefined;
  private readonly borrowCaps: Map<string, number>;
  /** Open loans (outstanding > 0) as last returned by the ledger, in issue order. */
  private readonly loans = new Map<string, Loan>();
  private readonly defaulted = new Set<string>();
  private readonly history: { cycle: number; metrics: Record<PlanetId, PlanetMetrics> }[] = [];
  private readonly events: SimEvent[] = [];
  private eventSeq = 0;
  private _cycle = 0;

  constructor(opts: UniverseOptions) {
    this.world = opts.world;
    this.ledger = opts.ledger;
    this.provider = opts.agents;
    this.check = opts.checkInvariants ?? true;
    this.sink = opts.sink;
    this.borrowCaps = borrowCapsOf(opts.world);
    this.roster = listAgents(opts.world);
    this.known = {
      goods: new Set(opts.world.goods.map((g) => g.id)),
      planets: new Set(opts.world.planets.map((p) => p.id)),
      currencies: new Set(opts.world.planets.map((p) => p.currency)),
      borrowCaps: this.borrowCaps,
    };
    for (const a of this.roster) if (a.role === 'trader') this.location.set(a.id, a.planet);
  }

  get cycle(): number {
    return this._cycle;
  }

  /** Docked planet of a trader, or null while in flight. */
  locationOf(traderId: string): PlanetId | null | undefined {
    return this.location.get(traderId);
  }

  /** Metrics of the last `HISTORY_CYCLES` completed cycles, oldest first. */
  metricsHistory(): readonly { cycle: number; metrics: Record<PlanetId, PlanetMetrics> }[] {
    return this.history;
  }

  private addEvent(cycle: number, kind: SimEvent['kind'], text: string, planet?: PlanetId): void {
    this.events.push({ id: `e${++this.eventSeq}`, cycle, kind, ...(planet !== undefined ? { planet } : {}), text });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private trackLoan(l: Loan): void {
    if (l.outstanding > 0) this.loans.set(l.id, l);
    else this.loans.delete(l.id);
  }

  async init(): Promise<void> {
    await bootstrap(this.world, this.ledger);
  }

  /**
   * Arrives every tracked shipment due by `cycle` (shipment id order). Flow valuation, kept simple: each delivered unit
   * is valued at the destination's last local clearing price (else basePrice) and counted as an import of the
   * destination in its currency; the same units are valued the same way at the origin and counted as its export.
   */
  private async runArrivals(cycle: number): Promise<{ arrivals: ArriveResult[]; flows: Record<PlanetId, TradeFlow> }> {
    const flows: Record<PlanetId, TradeFlow> = Object.fromEntries(this.world.planets.map((p) => [p.id, { exports: 0, imports: 0 }]));
    const price = (planet: PlanetId, good: GoodId) =>
      this.book.view(planet, good).lastPrice ?? this.world.goods.find((g) => g.id === good)!.basePrice;
    const arrivals: ArriveResult[] = [];
    for (const s of [...this.flights.values()]) {
      if (s.arriveCycle > cycle) continue;
      const r = await this.ledger.arrive(s.id, cycle);
      this.flights.delete(s.id);
      this.location.set(s.owner, s.to);
      arrivals.push(r);
      for (const c of r.delivered) {
        flows[s.to]!.imports += c.qty * price(s.to, c.good);
        flows[s.from]!.exports += c.qty * price(s.from, c.good);
      }
    }
    return { arrivals, flows };
  }

  /** Auto-repays due loans from the borrower's purse; a loan still open after that counts as defaulted (once). */
  private async settleDueLoans(cycle: number): Promise<{ defaults: number; ledgerRejections: number }> {
    let defaults = 0, ledgerRejections = 0;
    for (const l of [...this.loans.values()]) {
      if (cycle < l.dueCycle) continue;
      try {
        const balance = await this.ledger.getPurse(l.borrower, l.currency);
        if (balance > 0) this.trackLoan(await this.ledger.repay({ loanId: l.id, amount: balance, cycle }));
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        ledgerRejections++;
      }
      if (this.loans.has(l.id) && !this.defaulted.has(l.id)) {
        this.defaulted.add(l.id);
        defaults++;
        this.addEvent(cycle, 'system', `Loan ${l.id} of ${l.borrower} defaulted (${this.loans.get(l.id)!.outstanding} ${l.currency} unpaid)`, l.planet);
      }
    }
    return { defaults, ledgerRejections };
  }

  /** Every `intervalCycles`: each planet's reserve bank sets its policy rate from `history` (which includes `cycle`). */
  private async runReserveBanks(cycle: number): Promise<void> {
    const cfg = RESERVE_BANK_CONFIG;
    if (cycle === 0 || cycle % cfg.intervalCycles !== 0 || this.history.length <= cfg.intervalCycles) return;
    const now = this.history[this.history.length - 1]!.metrics;
    const earlier = this.history[this.history.length - 1 - cfg.intervalCycles]!.metrics;
    for (const p of this.world.planets) {
      const inflation = inflationBp(now[p.id]!.cpi, earlier[p.id]!.cpi);
      const gap = outputGapBp(now[p.id]!.gdp, this.history.slice(-cfg.gdpWindow).map((h) => h.metrics[p.id]!.gdp));
      const rateBp = taylorRateBp(inflation, gap);
      const old = (await this.ledger.getPolicy(p.id)).policyRateBp;
      if (rateBp === old) continue;
      await this.ledger.applyPolicy({ kind: 'set_policy_rate', planet: p.id, rateBp });
      this.addEvent(cycle, 'policy', `${p.name} policy rate ${old} -> ${rateBp} bp (inflation ${inflation} bp, output gap ${gap} bp)`, p.id);
    }
  }

  async step(): Promise<CycleReport> {
    const { world, ledger, book } = this;
    const cycle = this._cycle;

    const { arrivals, flows } = await this.runArrivals(cycle);
    const due0 = await this.settleDueLoans(cycle);
    const used: Counts = {};
    const produced = await runProduction(world, ledger, cycle, used);
    const unmet = await runConsumption(world, ledger);

    const due = schedule(this.roster, cycle, this.location);
    const tasks = await buildTasks(
      { world, ledger, book, memos: this.memos, cycle, fx: fxViews(world, this.fxRates), flights: [...this.flights.values()], loans: [...this.loans.values()] },
      due,
    );
    const raw = await this.provider.decideAll(tasks);
    const { decisions, rejections } = validateDecisions(raw, tasks, book, this.known);

    // Settle in deterministic agent order. Ledger-level failures are counted, never fatal.
    let ledgerRejections = due0.ledgerRejections;
    for (const d of decisions) {
      if (d.memo !== undefined) this.memos.set(d.agentId, d.memo);
      for (const id of d.cancels) {
        try {
          await ledger.cancelOrder(id);
          book.remove(id);
        } catch (e) {
          if (!(e instanceof LedgerError)) throw e;
          ledgerRejections++;
        }
      }
      try {
        if (d.borrow) this.trackLoan(await ledger.borrow({ borrower: d.agentId, ...d.borrow, cycle }));
        for (const r of d.repays) this.trackLoan(await ledger.repay({ ...r, cycle }));
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        ledgerRejections++;
      }
    }
    const orders = decisions.flatMap((d) => d.orders);
    const placed = await ledger.placeOrders(orders, cycle);
    for (const a of placed.accepted) {
      book.add({ ...(orders[a.index] as (typeof orders)[number]), orderId: a.orderId, cycle });
    }
    const placedFx = await ledger.placeFxOrders(decisions.flatMap((d) => d.fxOrders), cycle);

    const departures: Shipment[] = [];
    for (const d of decisions) {
      if (!d.ship) continue;
      const { from, to, cargo } = d.ship;
      try {
        const s = await ledger.depart({ owner: d.agentId, from, to, cargo, cycle, arriveCycle: cycle + travelCycles(world, from, to, cycle) });
        this.flights.set(s.id, s);
        this.location.set(d.agentId, null);
        departures.push(s);
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        ledgerRejections++;
      }
    }

    const auctions: AuctionResult[] = [];
    for (const p of world.planets) {
      for (const g of world.goods) {
        const r = await ledger.clearLocalAuction(p.id, g.id, cycle);
        book.applyAuction(r);
        auctions.push(r);
      }
    }
    const fx: FxAuctionResult[] = [];
    for (const pair of fxPairs(world)) {
      const r = await ledger.clearFxAuction(pair.base, pair.quote, cycle);
      if (r.ratePpm !== null) this.fxRates.set(fxKey(pair.base, pair.quote), r.ratePpm);
      fx.push(r);
    }

    const surveys = new Map<PlanetId, SurveyAnswer[]>();
    for (const d of decisions) if (d.survey) surveys.set(d.planet, [...(surveys.get(d.planet) ?? []), d.survey]);
    const prev = this.history[this.history.length - 1]?.metrics;
    const metrics: Record<PlanetId, PlanetMetrics> = {};
    for (const p of world.planets) {
      metrics[p.id] = computeMetrics(world, p, {
        produced: produced[p.id] ?? {}, used: used[p.id] ?? {}, price: (g) => this.priceOf(p.id, g), flow: flows[p.id]!,
        surveys: surveys.get(p.id) ?? [], ...(prev ? { prev: prev[p.id]! } : {}),
      });
    }
    this.history.push({ cycle, metrics });
    if (this.history.length > HISTORY_CYCLES) this.history.shift();
    await this.runReserveBanks(cycle);

    if (this.check) {
      const inv = await ledger.checkInvariants();
      if (!inv.ok) throw new Error(`invariants violated at cycle ${cycle}: ${JSON.stringify(inv.violations)}`);
    }

    this._cycle++;
    if (this.sink) await this.sink.writeCycle(await this.snapshot({ series: [] }));
    return {
      cycle, auctions, produced, unmet, rejections: rejections.length, placeOrdersRejected: placed.rejected.length,
      fxOrdersRejected: placedFx.rejected.length, ledgerRejections, departures, arrivals, fx, tradeFlows: flows, metrics,
      defaults: due0.defaults,
    };
  }

  /** Last clearing price of a good on a planet, else its base price. */
  private priceOf(planet: PlanetId, good: GoodId): number {
    return this.book.lastPrice(planet, good) ?? this.world.goods.find((g) => g.id === good)!.basePrice;
  }

  /** State as of the last completed cycle (cycle 0 before any step). `series` is passed through (read at broadcast time). */
  async snapshot(opts: { series: ChartSeries[]; paused?: boolean; gatewayCostUsd?: number }): Promise<Snapshot> {
    const { world } = this;
    const cycle = Math.max(0, this._cycle - 1);
    const latest = this.history[this.history.length - 1]?.metrics;
    const fresh = (): PlanetMetrics => ({ gdp: 0, cpi: CPI_BASE, tradeBalance: 0, population: 0, consumerConfidence: INITIAL_CONFIDENCE, businessConfidence: INITIAL_CONFIDENCE });
    const planets = [];
    for (const p of world.planets) {
      planets.push({
        planet: p.id,
        currency: p.currency,
        prices: Object.fromEntries(world.goods.map((g) => [g.id, this.priceOf(p.id, g.id)])),
        policy: await this.ledger.getPolicy(p.id),
        metrics: latest?.[p.id] ?? { ...fresh(), population: p.agents.colonist },
        orbitPhaseCycles: orbitPhase(p, cycle),
      });
    }
    const fx = fxPairs(world).flatMap((p) => {
      const ratePpm = this.fxRates.get(fxKey(p.base, p.quote));
      return ratePpm === undefined ? [] : [{ base: p.base, quote: p.quote, ratePpm }];
    });
    return {
      universeId: world.universeId, cycle, paused: opts.paused ?? false, planets, fx, shipments: [...this.flights.values()],
      events: [...this.events], series: opts.series, gatewayCostUsd: opts.gatewayCostUsd ?? 0,
    };
  }
}
