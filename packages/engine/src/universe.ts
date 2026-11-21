import { LedgerError } from '@orbital/contracts';
import type { ArriveResult, AuctionResult, FxAuctionResult, GoodId, Ledger, PlanetId, Shipment, WorldConfig } from '@orbital/contracts';
import { listAgents } from './agents.js';
import type { AgentInfo, DecisionProvider } from './agents.js';
import { bootstrap } from './bootstrap.js';
import { fxKey, fxPairs, fxViews } from './fx.js';
import { MarketBook } from './market-book.js';
import { buildTasks } from './observation.js';
import { travelCycles } from './orbits.js';
import { runConsumption } from './phases/consumption.js';
import { runProduction } from './phases/production.js';
import type { Counts } from './phases/production.js';
import { schedule } from './scheduler.js';
import { validateDecisions } from './validator.js';

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
}

export interface UniverseOptions {
  world: WorldConfig;
  ledger: Ledger;
  agents: DecisionProvider;
  /** Throw if `ledger.checkInvariants()` fails after a cycle. Default true. */
  checkInvariants?: boolean;
}

export class Universe {
  readonly book = new MarketBook();
  private readonly world: WorldConfig;
  private readonly ledger: Ledger;
  private readonly provider: DecisionProvider;
  private readonly check: boolean;
  private readonly roster: AgentInfo[];
  private readonly known: { goods: Set<string>; planets: Set<string>; currencies: Set<string> };
  private readonly memos = new Map<string, string>();
  /** Where each trader's freighter is: a planet id when docked, null while in flight. */
  private readonly location = new Map<string, PlanetId | null>();
  /** In-flight shipments in departure (= shipment id) order. */
  private readonly flights = new Map<string, Shipment>();
  /** Last non-null clearing rate (ppm quote per base) per canonical pair. */
  private readonly fxRates = new Map<string, number>();
  private _cycle = 0;

  constructor(opts: UniverseOptions) {
    this.world = opts.world;
    this.ledger = opts.ledger;
    this.provider = opts.agents;
    this.check = opts.checkInvariants ?? true;
    this.roster = listAgents(opts.world);
    this.known = {
      goods: new Set(opts.world.goods.map((g) => g.id)),
      planets: new Set(opts.world.planets.map((p) => p.id)),
      currencies: new Set(opts.world.planets.map((p) => p.currency)),
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

  async step(): Promise<CycleReport> {
    const { world, ledger, book } = this;
    const cycle = this._cycle;

    const { arrivals, flows } = await this.runArrivals(cycle);
    const produced = await runProduction(world, ledger, cycle);
    const unmet = await runConsumption(world, ledger);

    const due = schedule(this.roster, cycle, this.location);
    const tasks = await buildTasks(
      { world, ledger, book, memos: this.memos, cycle, fx: fxViews(world, this.fxRates), flights: [...this.flights.values()] },
      due,
    );
    const raw = await this.provider.decideAll(tasks);
    const { decisions, rejections } = validateDecisions(raw, tasks, book, this.known);

    // Settle in deterministic agent order. Ledger-level failures are counted, never fatal.
    let ledgerRejections = 0;
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

    if (this.check) {
      const inv = await ledger.checkInvariants();
      if (!inv.ok) throw new Error(`invariants violated at cycle ${cycle}: ${JSON.stringify(inv.violations)}`);
    }

    this._cycle++;
    return {
      cycle, auctions, produced, unmet, rejections: rejections.length, placeOrdersRejected: placed.rejected.length,
      fxOrdersRejected: placedFx.rejected.length, ledgerRejections, departures, arrivals, fx, tradeFlows: flows,
    };
  }
}
