// Read-only tools the Flash fallback can call in `tools` mode (architecture.md §3.4).
//
// An agent's observation only shows its own planet. The board is assembled from
// every task in the current cycle's batch (each task carries its planet's books,
// policy and FX), so tool answers are a pure function of this cycle's inputs: no
// engine state is touched and replays stay deterministic.

import type { AgentTask, MarketView, PlanetId, PolicyState, ToolDeclaration, WorldConfig } from '@orbital/contracts';
import { RATE_SCALE } from '@orbital/contracts';
import { travelCycles } from '@orbital/engine';

interface PlanetBoard {
  markets: Map<string, MarketView>;
  policy: PolicyState | null;
}

export class MarketBoard {
  private planets = new Map<PlanetId, PlanetBoard>();
  /** `${base}/${quote}` → last rate ppm. */
  private fx = new Map<string, number>();

  constructor(private readonly world: WorldConfig) {}

  /** Rebuild from one cycle's tasks. Call before the batch is decided. */
  update(tasks: AgentTask[]): void {
    this.planets = new Map();
    this.fx = new Map();
    for (const t of tasks) {
      let board = this.planets.get(t.planet);
      if (!board) {
        board = { markets: new Map(), policy: null };
        this.planets.set(t.planet, board);
      }
      // Agents on a planet see the same books; union in case views are trimmed per agent.
      for (const m of t.observation.markets) if (!board.markets.has(m.good)) board.markets.set(m.good, m);
      board.policy ??= t.observation.policy;
      for (const f of t.observation.fx) if (f.lastRatePpm) this.fx.set(`${f.base}/${f.quote}`, f.lastRatePpm);
    }
  }

  planet(id: PlanetId): PlanetBoard | undefined {
    return this.planets.get(id);
  }

  /** Quote-currency units per base unit × RATE_SCALE, direct or inverted. */
  rate(base: string, quote: string): number | null {
    if (base === quote) return RATE_SCALE;
    const direct = this.fx.get(`${base}/${quote}`);
    if (direct) return direct;
    const inverse = this.fx.get(`${quote}/${base}`);
    return inverse ? Math.floor((RATE_SCALE * RATE_SCALE) / inverse) : null;
  }

  currencyOf(planet: PlanetId): string | undefined {
    return this.world.planets.find((p) => p.id === planet)?.currency;
  }
}

const PLANET_PRICES: ToolDeclaration = {
  name: 'planet_prices',
  description: "Another planet's market this cycle: last price, best bid/ask and recent trend per good (in that planet's currency), plus its tariffs and embargoes.",
  parameters: {
    type: 'object',
    properties: { planet: { type: 'string', description: 'Planet id, e.g. verdan' } },
    required: ['planet'],
  },
};

const QUOTE_ROUTE: ToolDeclaration = {
  name: 'quote_route',
  description:
    'Estimate shipping a good from your planet to another: travel time, your buy price, the destination price converted to your currency, its import tariff, and the margin. An estimate from this cycle\'s books, not a guarantee.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Destination planet id' },
      good: { type: 'string', description: 'Good id' },
      qty: { type: 'integer', minimum: 1, description: 'Units to ship' },
    },
    required: ['to', 'good', 'qty'],
  },
};

/** Which read tools each role gets. Colonists use structured mode (no tools). */
export function readToolsFor(task: AgentTask): ToolDeclaration[] {
  if (task.role === 'trader') return [PLANET_PRICES, QUOTE_ROUTE];
  if (task.role === 'government') return [PLANET_PRICES];
  return [];
}

/**
 * One board per universe. Forks share the runtime config (and so this store) but have
 * their own universe id, so concurrent forks never read each other's books.
 */
export class MarketBoards {
  private readonly boards = new Map<string, MarketBoard>();

  constructor(private readonly world: WorldConfig) {}

  /** Rebuild the boards for every universe present in this batch. */
  update(tasks: AgentTask[]): void {
    const byUniverse = new Map<string, AgentTask[]>();
    for (const t of tasks) byUniverse.set(t.universeId, [...(byUniverse.get(t.universeId) ?? []), t]);
    for (const [id, group] of byUniverse) {
      const board = this.boards.get(id) ?? new MarketBoard(this.world);
      board.update(group);
      this.boards.set(id, board);
    }
  }

  for(universeId: string): MarketBoard {
    let board = this.boards.get(universeId);
    if (!board) {
      board = new MarketBoard(this.world);
      this.boards.set(universeId, board);
    }
    return board;
  }
}

/** Runs a read tool against the task's universe board. Errors come back as `{ error }` so the model can recover. */
export function runReadTool(boards: MarketBoards, world: WorldConfig) {
  return async (name: string, args: unknown, task: AgentTask): Promise<unknown> => {
    const board = boards.for(task.universeId);
    const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
    if (!readToolsFor(task).some((t) => t.name === name)) return { error: `tool ${name} is not available to a ${task.role}` };
    const planetId = String(a.planet ?? a.to ?? '');
    if (!world.planets.some((p) => p.id === planetId)) {
      return { error: `unknown planet ${planetId}; planets: ${world.planets.map((p) => p.id).join(', ')}` };
    }
    const dest = board.planet(planetId);

    if (name === 'planet_prices') {
      if (!dest) return { planet: planetId, error: 'no market data for this planet this cycle' };
      return {
        planet: planetId,
        currency: board.currencyOf(planetId),
        markets: [...dest.markets.values()].map((m) => ({
          good: m.good, last: m.lastPrice, bestBid: m.bids[0]?.price ?? null, bestAsk: m.asks[0]?.price ?? null, trend: m.trend,
        })),
        tariffsBp: dest.policy?.tariffsBp ?? {},
        embargoes: dest.policy?.embargoes ?? [],
      };
    }

    // quote_route
    const good = String(a.good ?? '');
    const qty = Math.max(1, Math.floor(Number(a.qty) || 1));
    if (planetId === task.planet) return { error: 'destination is your own planet' };
    const homeCcy = board.currencyOf(task.planet)!;
    const destCcy = board.currencyOf(planetId)!;
    const local = task.observation.markets.find((m) => m.good === good);
    const remote = dest?.markets.get(good);
    // Book first, then last trade, then the good's base price (early cycles have empty books).
    const base = world.goods.find((g) => g.id === good)?.basePrice ?? null;
    const [buyPrice, buySource] = pick([local?.asks[0]?.price, 'ask'], [local?.lastPrice, 'last'], [base, 'base']);
    const [sellPrice, sellSource] = pick([remote?.bids[0]?.price, 'bid'], [remote?.lastPrice, 'last'], [base, 'base']);
    // No FX trade yet: base prices are world-wide, so parity is the base-price-consistent guess.
    const liveRate = board.rate(homeCcy, destCcy);
    const rate = liveRate ?? RATE_SCALE;
    const tariffBp = dest?.policy?.tariffsBp[good] ?? 0;
    const embargoed = (dest?.policy?.embargoes ?? []).includes(task.planet) || task.observation.policy.embargoes.includes(planetId);
    const travel = travelCycles(world, task.planet, planetId, task.cycle);
    const out: Record<string, unknown> = {
      from: task.planet, to: planetId, good, qty, travelCycles: travel, arrivesCycle: task.cycle + travel,
      buyPrice, buyCurrency: homeCcy, buyPriceSource: buySource, destPrice: sellPrice, destCurrency: destCcy, destPriceSource: sellSource,
      destTariffBp: tariffBp, embargoed, fxRatePpm: rate, fxSource: liveRate === null ? 'parity' : 'market',
    };
    if (base === null) return { ...out, error: `unknown good ${good}` };
    // rate = dest units per home unit × RATE_SCALE.
    const destPriceInHome = Math.floor((sellPrice! * RATE_SCALE) / rate);
    const netInHome = Math.floor((destPriceInHome * (10_000 - tariffBp)) / 10_000);
    const cost = buyPrice! * qty;
    const revenue = netInHome * qty;
    return {
      ...out,
      destPriceInHomeCurrency: destPriceInHome,
      costInHome: cost,
      revenueAfterTariffInHome: revenue,
      marginInHome: revenue - cost,
      marginBp: Math.floor(((revenue - cost) * 10_000) / Math.max(1, cost)),
      ...(buySource === 'base' || sellSource === 'base' || liveRate === null
        ? { note: 'no live book or FX trade for part of this route; base prices / FX parity used, treat as a rough estimate' }
        : {}),
    };
  };
}

/** First present price with its source label. */
function pick(...options: Array<[number | null | undefined, string]>): [number | null, string | null] {
  for (const [price, source] of options) if (typeof price === 'number' && price > 0) return [price, source];
  return [null, null];
}
