import { LedgerError } from '@orbital/contracts';
import type {
  AgentId, ArriveResult, AuctionResult, ChartSeries, FxAuctionResult, GodModeCommand, GoodId, Ledger, Loan, PlanetId, PolicyState, Shipment, SimEvent, Snapshot,
  SurveyAnswer, UniverseId, WorldConfig,
} from '@orbital/contracts';
import { listAgents } from './agents.js';
import type { AgentInfo, DecisionProvider } from './agents.js';
import { bootstrap } from './bootstrap.js';
import { fxKey, fxPairs, fxViews } from './fx.js';
import { Detectors } from './detectors/index.js';
import type { DetectedEvent } from './detectors/index.js';
import { isForkable } from './fork.js';
import { MarketBook } from './market-book.js';
import { GROWTH_CONFIG, GROWTH_TRAIL, accrueWear, accumulateInstalledPpm, capacityMultiplierPpm, investmentPpm, scaleBatches } from './growth.js';
import { INITIAL_CONFIDENCE, CPI_BASE, computeMetrics } from './metrics.js';
import type { PlanetMetrics } from './metrics.js';
import { buildTasks } from './observation.js';
import { orbitPhase, travelCycles } from './orbits.js';
import { runConsumption } from './phases/consumption.js';
import { batchKey, multKey, runProduction } from './phases/production.js';
import type { Counts, Multipliers } from './phases/production.js';
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
  /** Auto-detector hits this cycle (also added to the event feed as kind 'crisis'). */
  detected: DetectedEvent[];
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

/**
 * A resting local order is cancelled (and its escrow refunded) once it is this many cycles old. Without a lifetime,
 * orders that never cross pile up forever: books reach hundreds of orders and funds stay locked. 0 disables expiry.
 */
export const DEFAULT_ORDER_TTL_CYCLES = 5;
export const MAX_EVENTS = 50;

/** An applied `shock` command: active for cycles `[start, endCycle)`. Scales output (supply shocks) or need (`demand_surge`). */
interface ActiveShock {
  planet: PlanetId;
  good: GoodId;
  shock: Extract<GodModeCommand, { kind: 'shock' }>['shock'];
  magnitudeBp: number;
  endCycle: number;
}

/** Tag of events caused by an operator command (vs emergent ones). */
export const GOD_MODE_TAG = '[god mode]';

export interface UniverseOptions {
  world: WorldConfig;
  ledger: Ledger;
  agents: DecisionProvider;
  /** Cancel resting orders older than this many cycles (DEFAULT_ORDER_TTL_CYCLES); 0 = never expire. */
  orderTtlCycles?: number;
  /** Throw if `ledger.checkInvariants()` fails after a cycle. Default true. */
  checkInvariants?: boolean;
  /** If present, `step()` writes the cycle's snapshot (with empty `series`) to it. */
  sink?: MetricsSink;
}

export class Universe {
  /** Mutable only so `fork()` can install a copy. */
  book = new MarketBook();
  private readonly world: WorldConfig;
  private readonly ledger: Ledger;
  private readonly provider: DecisionProvider;
  private readonly check: boolean;
  private readonly orderTtl: number;
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
  private readonly detectors = new Detectors();
  private eventSeq = 0;
  private _cycle = 0;
  /** God-mode commands waiting for the next step's Events phase, in arrival order. */
  private queue: GodModeCommand[] = [];
  private shocks: ActiveShock[] = [];
  /** Reserve-bank rule suspended for a planet until this cycle (exclusive), after a god-mode `policy_rate`. */
  private readonly rateOverride = new Map<PlanetId, number>();
  /** Fractional capital-scaled batches (ppm) carried to the next cycle, per `planet|recipe`. */
  private readonly batchCarry = new Map<string, number>();
  /** Capital wear accrued but not yet a whole unit (ppm), per planet. */
  private readonly wearPpm = new Map<PlanetId, number>();
  /** Saved-and-invested capital per planet in ppm tool-equivalents (exists outside any inventory); K = floor(this / 1e6) + tools held. */
  private readonly installedCapitalPpm = new Map<PlanetId, number>();

  constructor(opts: UniverseOptions) {
    this.world = opts.world;
    this.ledger = opts.ledger;
    this.provider = opts.agents;
    this.check = opts.checkInvariants ?? true;
    this.orderTtl = opts.orderTtlCycles ?? DEFAULT_ORDER_TTL_CYCLES;
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

  get universeId(): UniverseId {
    return this.world.universeId;
  }

  /**
   * Queues an operator command for the Events phase at the start of the next `step()`. Throws on an unknown planet or
   * good, or an embargo of the planet itself. `pause`, `resume` and `fork` are not engine commands (see LiveRunner).
   */
  enqueue(command: GodModeCommand, meta: { sub: string }): void {
    void meta; // reserved for the audit trail; the runner audits every command
    if (command.kind === 'pause' || command.kind === 'resume' || command.kind === 'fork') throw new Error(`${command.kind} is not an engine command`);
    if (!this.known.planets.has(command.planet)) throw new Error(`unknown planet ${command.planet}`);
    if ('good' in command && !this.known.goods.has(command.good)) throw new Error(`unknown good ${command.good}`);
    if (command.kind === 'embargo') {
      if (!this.known.planets.has(command.target)) throw new Error(`unknown planet ${command.target}`);
      if (command.target === command.planet) throw new Error('a planet cannot embargo itself');
    }
    this.queue.push(structuredClone(command));
  }

  /**
   * Independent copy of the whole universe (ledger, book, flights, loans, memos, history, events, shocks, queue, overrides,
   * fx rates, cycle, provider RNG) under a new id, sharing only the metrics sink. Call between steps. Throws if the
   * ledger has no `clone()` or the provider no `fork()`.
   */
  async fork(universeId: UniverseId): Promise<Universe> {
    if (!isForkable(this.ledger)) throw new Error('ledger does not support clone(); cannot fork');
    if (!this.provider.fork) throw new Error('decision provider does not support fork(); cannot fork');
    const u = new Universe({
      world: { ...this.world, universeId }, ledger: await this.ledger.clone(), agents: this.provider.fork(), checkInvariants: this.check, orderTtlCycles: this.orderTtl,
      ...(this.sink ? { sink: this.sink } : {}),
    });
    const fill = <K, V>(to: Map<K, V>, from: ReadonlyMap<K, V>) => {
      to.clear();
      for (const [k, v] of from) to.set(k, structuredClone(v));
    };
    u.book = this.book.clone();
    fill(u.memos, this.memos); fill(u.location, this.location); fill(u.flights, this.flights); fill(u.fxRates, this.fxRates);
    fill(u.loans, this.loans); fill(u.rateOverride, this.rateOverride); fill(u.batchCarry, this.batchCarry); fill(u.wearPpm, this.wearPpm); fill(u.installedCapitalPpm, this.installedCapitalPpm);
    for (const id of this.defaulted) u.defaulted.add(id);
    u.history.push(...structuredClone(this.history));
    u.events.push(...structuredClone(this.events));
    u.eventSeq = this.eventSeq;
    u.detectors.setState(structuredClone(this.detectors.getState()));
    u._cycle = this._cycle;
    u.queue = structuredClone(this.queue);
    u.shocks = structuredClone(this.shocks);
    return u;
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

  /** Events phase: expires old shocks, then applies queued god-mode commands in order, each with a tagged event. */
  private async runEvents(cycle: number): Promise<void> {
    this.shocks = this.shocks.filter((s) => s.endCycle > cycle);
    const name = (id: PlanetId) => this.world.planets.find((p) => p.id === id)!.name;
    const pct = (bp: number) => `${bp >= 0 ? '+' : ''}${bp / 100}%`;
    for (const c of this.queue.splice(0)) {
      if (c.kind === 'shock') {
        this.shocks.push({ planet: c.planet, good: c.good, shock: c.shock, magnitudeBp: c.magnitudeBp, endCycle: cycle + c.durationCycles });
        const what = c.shock === 'demand_surge' ? 'demand' : 'output';
        this.addEvent(cycle, 'shock', `${GOD_MODE_TAG} ${c.shock} on ${name(c.planet)}: ${c.good} ${what} ${pct(c.magnitudeBp)} for ${c.durationCycles} cycles`, c.planet);
      } else if (c.kind === 'tariff') {
        await this.ledger.applyPolicy({ kind: 'set_tariff', planet: c.planet, good: c.good, rateBp: c.rateBp });
        this.addEvent(cycle, 'policy', `${GOD_MODE_TAG} ${name(c.planet)} sets a ${c.rateBp / 100}% tariff on ${c.good}`, c.planet);
      } else if (c.kind === 'embargo') {
        await this.ledger.applyPolicy({ kind: 'set_embargo', planet: c.planet, target: c.target, active: c.active });
        this.addEvent(cycle, 'policy', `${GOD_MODE_TAG} ${name(c.planet)} ${c.active ? 'embargoes' : 'lifts the embargo on'} ${name(c.target)}`, c.planet);
      } else if (c.kind === 'policy_rate') {
        await this.ledger.applyPolicy({ kind: 'set_policy_rate', planet: c.planet, rateBp: c.rateBp });
        this.rateOverride.set(c.planet, cycle + RESERVE_BANK_CONFIG.overrideCycles);
        this.addEvent(cycle, 'policy', `${GOD_MODE_TAG} ${name(c.planet)} policy rate set to ${c.rateBp} bp (reserve-bank rule suspended ${RESERVE_BANK_CONFIG.overrideCycles} cycles)`, c.planet);
      }
    }
  }

  /** Product of the active shocks per `planet|good`, for the supply shocks (`demand` false) or demand surges (`demand` true). */
  private multipliers(demand: boolean): Multipliers {
    const m = new Map<string, number>();
    for (const s of this.shocks) {
      if ((s.shock === 'demand_surge') !== demand) continue;
      const k = multKey(s.planet, s.good);
      m.set(k, (m.get(k) ?? 1) * (Math.max(0, 10_000 + s.magnitudeBp) / 10_000));
    }
    return m;
  }

  /** Every `intervalCycles`: each planet's reserve bank sets its policy rate from `history` (which includes `cycle`). */
  private async runReserveBanks(cycle: number): Promise<void> {
    const cfg = RESERVE_BANK_CONFIG;
    if (cycle < cfg.warmupCycles || cycle % cfg.intervalCycles !== 0 || this.history.length <= cfg.intervalCycles) return;
    const now = this.history[this.history.length - 1]!.metrics;
    const earlier = this.history[this.history.length - 1 - cfg.intervalCycles]!.metrics;
    for (const p of this.world.planets) {
      const inflation = inflationBp(now[p.id]!.cpi, earlier[p.id]!.cpi);
      const gap = outputGapBp(now[p.id]!.gdp, this.history.slice(-cfg.gdpWindow).map((h) => h.metrics[p.id]!.gdp));
      if ((this.rateOverride.get(p.id) ?? 0) > cycle) continue; // suspended by a god-mode policy_rate
      const rateBp = taylorRateBp(inflation, gap);
      const old = (await this.ledger.getPolicy(p.id)).policyRateBp;
      if (rateBp === old) continue;
      await this.ledger.applyPolicy({ kind: 'set_policy_rate', planet: p.id, rateBp });
      this.addEvent(cycle, 'policy', `${p.name} policy rate ${old} -> ${rateBp} bp (inflation ${inflation} bp, output gap ${gap} bp)`, p.id);
    }
  }

  /** Cancels every resting order that has reached its lifetime, oldest first. Refunds go back through the ledger. */
  private async expireStaleOrders(cycle: number): Promise<void> {
    if (this.orderTtl <= 0) return;
    for (const o of this.book.all()) {
      if (cycle - o.cycle < this.orderTtl) continue;
      try {
        await this.ledger.cancelOrder(o.orderId);
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
      }
      this.book.remove(o.orderId);
    }
  }

  async step(): Promise<CycleReport> {
    const { world, ledger, book } = this;
    const cycle = this._cycle;

    await this.runEvents(cycle);
    const { arrivals, flows } = await this.runArrivals(cycle);
    const due0 = await this.settleDueLoans(cycle);
    const used: Counts = {};
    const capital = await this.capitalStocks();
    const produced = await runProduction(world, ledger, cycle, used, this.multipliers(false), this.capacityBatches(capital));
    await this.wearCapital(capital);
    const unmet = await runConsumption(world, ledger, this.multipliers(true));

    await this.expireStaleOrders(cycle);

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
        capitalStock: await this.capitalStockOf(p.id) + this.installedUnits(p.id),
        trail: this.history.slice(-GROWTH_TRAIL).map((h) => h.metrics[p.id]!),
      });
    }
    this.history.push({ cycle, metrics });
    this.invest(metrics);
    if (this.history.length > HISTORY_CYCLES) this.history.shift();
    await this.runReserveBanks(cycle);

    // Auto-detectors run on final end-of-cycle policy (incl. god-mode and reserve-bank changes).
    const policies: Record<PlanetId, PolicyState> = {};
    for (const p of world.planets) policies[p.id] = await ledger.getPolicy(p.id);
    const detected = this.detectors.observe({ cycle, metrics, policies, fx, arrivals });
    for (const ev of detected) this.addEvent(cycle, 'crisis', ev.text, ev.planet);

    if (this.check) {
      const inv = await ledger.checkInvariants();
      if (!inv.ok) throw new Error(`invariants violated at cycle ${cycle}: ${JSON.stringify(inv.violations)}`);
    }

    this._cycle++;
    if (this.sink) await this.sink.writeCycle(await this.snapshot({ series: [] }));
    return {
      cycle, auctions, produced, unmet, rejections: rejections.length, placeOrdersRejected: placed.rejected.length,
      fxOrdersRejected: placedFx.rejected.length, ledgerRejections, departures, arrivals, fx, tradeFlows: flows, metrics,
      defaults: due0.defaults, detected,
    };
  }

  /** Holdings of the capital good on a planet, summed over the agents based there (accounts are owner + planet). */
  private async capitalStockOf(planet: PlanetId): Promise<number> {
    const good = GROWTH_CONFIG.capitalGood;
    if (!this.world.goods.some((g) => g.id === good)) return 0;
    let total = 0;
    for (const a of this.roster) if (a.planet === planet) total += await this.ledger.getInventory(a.id, planet, good);
    return total;
  }

  /** Whole tool-equivalents of installed (saved and invested) capital on a planet. */
  private installedUnits(planet: PlanetId): number {
    return Math.floor((this.installedCapitalPpm.get(planet) ?? 0) / 1_000_000);
  }

  /**
   * Solow saving: adds savingsRate * realGdp / basePrice(capital good) to each planet's installed stock, then depreciates it.
   * Not yet funded from consumption or the treasury (a simplification); nothing is logged per cycle.
   */
  private invest(metrics: Record<PlanetId, PlanetMetrics>): void {
    if (!GROWTH_CONFIG.capitalAffectsProduction) return;
    const price = this.world.goods.find((g) => g.id === GROWTH_CONFIG.capitalGood)?.basePrice ?? 0;
    for (const p of this.world.planets) {
      this.installedCapitalPpm.set(p.id, accumulateInstalledPpm(this.installedCapitalPpm.get(p.id) ?? 0, investmentPpm(metrics[p.id]!.realGdp, price)));
    }
  }

  /** Capital goods held per planet at the start of production (empty when capital does not affect production); these wear out. */
  private async capitalStocks(): Promise<Map<PlanetId, number>> {
    const out = new Map<PlanetId, number>();
    if (!GROWTH_CONFIG.capitalAffectsProduction) return out;
    for (const p of this.world.planets) out.set(p.id, await this.capitalStockOf(p.id));
    return out;
  }

  /** Effective batches per `planet|recipe` (K = held tools + installed capital): floor(batchesPerCycle * m + carry), the remainder kept in `batchCarry`. */
  private capacityBatches(capital: ReadonlyMap<PlanetId, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of this.world.planets) {
      const m = capacityMultiplierPpm((capital.get(p.id) ?? 0) + this.installedUnits(p.id));
      for (const pr of p.recipes) {
        const k = batchKey(p.id, pr.recipe);
        const r = scaleBatches(pr.batchesPerCycle, m, this.batchCarry.get(k) ?? 0);
        this.batchCarry.set(k, r.carryPpm);
        out.set(k, r.batches);
      }
    }
    return out;
  }

  /** Wears out capital: accrues K * depreciationPpm per planet and destroys whole units, largest holder first (ties: roster order). */
  private async wearCapital(capital: ReadonlyMap<PlanetId, number>): Promise<void> {
    const good = GROWTH_CONFIG.capitalGood;
    for (const p of this.world.planets) {
      const w = accrueWear(capital.get(p.id) ?? 0, this.wearPpm.get(p.id) ?? 0);
      this.wearPpm.set(p.id, w.accPpm);
      if (w.units <= 0) continue;
      const holders: { id: AgentId; qty: number }[] = [];
      for (const a of this.roster) if (a.planet === p.id) holders.push({ id: a.id, qty: await this.ledger.getInventory(a.id, p.id, good) });
      holders.sort((x, y) => y.qty - x.qty); // stable: ties stay in roster order
      let left = w.units;
      for (const h of holders) {
        if (left <= 0 || h.qty <= 0) break;
        const take = Math.min(left, h.qty);
        await this.ledger.consume({ owner: h.id, planet: p.id, cargo: [{ good, qty: take }] });
        left -= take;
      }
    }
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
    const fresh = (): PlanetMetrics => ({ gdp: 0, cpi: CPI_BASE, tradeBalance: 0, population: 0, consumerConfidence: INITIAL_CONFIDENCE, businessConfidence: INITIAL_CONFIDENCE, realGdp: 0, labourInput: 0, capitalStock: 0, realGdpGrowthBp: 0, labourContribBp: 0, capitalContribBp: 0, tfpContribBp: 0 });
    const planets = [];
    for (const p of world.planets) {
      planets.push({
        planet: p.id,
        currency: p.currency,
        prices: Object.fromEntries(world.goods.map((g) => [g.id, this.priceOf(p.id, g.id)])),
        policy: await this.ledger.getPolicy(p.id),
        metrics: latest?.[p.id] ?? { ...fresh(), population: p.agents.colonist, labourInput: p.agents.colonist },
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
