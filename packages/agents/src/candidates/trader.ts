// Candidate bundles for a docked trader. The rule code does all the arithmetic
// (prices, FX, tariffs, travel time, purse); Gemini Decision 1 only picks one.
//
// A ship departs with inventory held at departure time, and orders fill in the
// auction after departures, so "buy here, then ship" spans two turns: the buy
// candidate carries a memo, and next turn the ship candidate matching it is
// flagged in its description.

import type { Action, AgentTask, WorldConfig } from '@orbital/contracts';
import { RATE_SCALE } from '@orbital/contracts';
import { applyBand, baseOf, convert, currencyOf, fxRatePpm, producedGoods } from '../econ.js';
import { dedupe, HOLD, optionId, type Candidate } from './types.js';

/** Minimum expected margin after tariff and FX before a route is offered. DEFAULT: 5%. */
const MIN_MARGIN_BP = 500;
/** Buy limit above the local reference price, so the order is likely to fill. DEFAULT: +5%. */
const BUY_BP = 500;
/** Most units bought for one route per cycle. */
const MAX_BUY = 20;
/** Share of the home purse a single route may spend. DEFAULT: 80%. */
const SPEND_SHARE_BP = 8_000;
/** Accept up to 1% worse than the last FX rate. */
const FX_SLIPPAGE_BP = 100;
/** Accept up to 5% below parity when the pair has never cleared. */
const FX_COLD_SLIPPAGE_BP = 500;
/** Routes offered per menu. */
const MAX_ROUTES = 3;
/** Destinations offered for carrying existing stock. */
const MAX_SHIP_DESTINATIONS = 2;
/**
 * Cold start: a planet that has not traded a good yet is assumed to pay this much over base
 * when it does not produce the good itself. DEFAULT: +20%.
 */
const SCARCITY_BP = 2_000;

interface Quote {
  planet: string;
  travelCycles: number;
  /** Destination price net of tariff, in home currency. */
  netHome: number;
  tariffBp: number;
  /** True when the price or FX rate is a cold-start estimate rather than a clearing price. */
  estimated: boolean;
}

export function traderCandidates(task: AgentTask, world: WorldConfig): Candidate[] {
  const obs = task.observation;
  const home = currencyOf(world, task.planet);
  const purse = obs.purse[home] ?? 0;
  const allowed = new Set(task.allowedActions);
  const quotes = remoteQuotes(task, world, home);
  const plan = obs.memo ?? '';

  const out: Candidate[] = [];

  // 1. Carry stock already held here to the best destinations.
  if (allowed.has('ship')) {
    const held = Object.entries(obs.inventory).filter(([, q]) => q > 0);
    const byDest = new Map<string, { cargo: { good: string; qty: number }[]; gain: number; travel: number; lines: string[] }>();
    for (const [good, qty] of held) {
      const local = localBid(task, world, good);
      for (const q of quotes.get(good) ?? []) {
        const gainPer = q.netHome - local;
        if (local <= 0 || (gainPer * 10_000) / local < MIN_MARGIN_BP) continue;
        const d = byDest.get(q.planet) ?? { cargo: [], gain: 0, travel: q.travelCycles, lines: [] };
        if (d.cargo.length >= 8) continue;
        d.cargo.push({ good, qty });
        d.gain += gainPer * qty;
        d.lines.push(`${qty} ${good} (≈${q.netHome} ${home}/unit there${q.estimated ? ' (estimate)' : ''} after ${pct(q.tariffBp)} tariff vs ${local} here)`);
        byDest.set(q.planet, d);
      }
    }
    const dests = [...byDest.entries()].sort((a, b) => b[1].gain / b[1].travel - a[1].gain / a[1].travel).slice(0, MAX_SHIP_DESTINATIONS);
    for (const [planet, d] of dests) {
      const planned = plan.includes(`to ${planet}`) ? ' This matches your plan from last turn.' : '';
      out.push({
        id: optionId(`ship_to_${planet}`),
        description: `Ship held cargo to ${planet}, arriving in ${d.travel} cycles: ${d.lines.join('; ')}. Expected gain ≈${d.gain} ${home}.${planned}`,
        actions: [{ kind: 'ship', to: planet, cargo: d.cargo }],
      });
    }
  }

  // 2. Buy here for a profitable route; ship next turn.
  if (allowed.has('place_order') && purse > 0) {
    const routes: Array<{ good: string; q: Quote; limit: number; qty: number; marginBp: number; score: number }> = [];
    for (const g of world.goods) {
      const limit = applyBand(localAsk(task, world, g.id), BUY_BP);
      const qty = Math.min(MAX_BUY, Math.floor((purse * SPEND_SHARE_BP) / 10_000 / limit));
      if (qty < 1) continue;
      for (const q of quotes.get(g.id) ?? []) {
        const marginBp = Math.floor(((q.netHome - limit) * 10_000) / limit);
        if (marginBp < MIN_MARGIN_BP) continue;
        routes.push({ good: g.id, q, limit, qty, marginBp, score: marginBp / q.travelCycles });
      }
    }
    routes.sort((a, b) => b.score - a.score);
    for (const r of routes.slice(0, MAX_ROUTES)) {
      const spend = r.qty * r.limit;
      out.push({
        id: optionId(`buy_${r.good}_for_${r.q.planet}`),
        description:
          `Buy ${r.qty} ${r.good} here at up to ${r.limit} ${home} (spends up to ${spend} of ${purse} ${home}, ${share(spend, purse)}), ` +
          `then ship to ${r.q.planet} next turn (${r.q.travelCycles} cycles) where it sells for ≈${r.q.netHome} ${home}/unit after a ${pct(r.q.tariffBp)} tariff: ` +
          `≈${pct(r.marginBp)} margin.${r.q.estimated ? ' The destination price is an estimate: no trades or FX there yet.' : ''}`,
        actions: [{ kind: 'place_order', good: r.good, side: 'buy', qty: r.qty, limitPrice: r.limit }],
        memo: `plan: ship ${r.good} to ${r.q.planet}`,
      });
    }
  }

  // 3. Sell everything held here at the best bid.
  if (allowed.has('place_order')) {
    const sells: Action[] = [];
    let earn = 0;
    for (const [good, qty] of Object.entries(obs.inventory)) {
      if (qty <= 0) continue;
      const bid = localBid(task, world, good);
      if (bid <= 0) continue;
      sells.push({ kind: 'place_order', good, side: 'sell', qty, limitPrice: bid });
      earn += qty * bid;
    }
    if (sells.length > 0) {
      out.push({
        id: 'sell_cargo_here',
        description: `Sell all held goods here at the best bid: ${describeOrders(sells)}. Earns up to ${earn} ${home}.`,
        actions: sells.slice(0, 8),
      });
    }
  }

  // 4. Convert foreign cash back to the home currency.
  if (allowed.has('place_fx_order')) {
    const fxOrders: Action[] = [];
    const lines: string[] = [];
    for (const [cur, amount] of Object.entries(obs.purse)) {
      if (cur === home || amount <= 0) continue;
      // No clearing rate yet: offer at parity with wider slippage so the FX market can open at all.
      const known = convert(obs.fx, amount, cur, home);
      const expect = known ?? amount;
      const slip = known === null ? FX_COLD_SLIPPAGE_BP : FX_SLIPPAGE_BP;
      const minReceive = Math.floor((expect * (10_000 - slip)) / 10_000);
      if (minReceive < 1) continue;
      fxOrders.push({ kind: 'place_fx_order', give: cur, giveAmount: amount, want: home, minReceive });
      lines.push(`${amount} ${cur} → ≥${minReceive} ${home}`);
    }
    if (fxOrders.length > 0) {
      out.push({ id: 'convert_foreign_cash', description: `Convert foreign cash to ${home}: ${lines.join('; ')}.`, actions: fxOrders });
    }
  }

  // 5. Pay down loans.
  if (allowed.has('repay')) {
    const repays: Action[] = [];
    const left = { ...obs.purse };
    for (const l of obs.loans) {
      const cash = left[l.currency] ?? 0;
      const amount = Math.min(l.outstanding, cash);
      if (amount < 1) continue;
      left[l.currency] = cash - amount;
      repays.push({ kind: 'repay', loanId: l.id, amount });
    }
    if (repays.length > 0) {
      const total = repays.reduce((s, a) => s + (a.kind === 'repay' ? a.amount : 0), 0);
      out.push({ id: 'repay_loans', description: `Repay ${total} of outstanding loans from cash on hand.`, actions: repays });
    }
  }

  out.push({ ...HOLD, description: 'Do nothing this cycle: keep cargo and cash, wait for better prices.' });
  return dedupe(out);
}

/**
 * Per good: destinations with a price, converted to home currency and net of the import tariff.
 * Before a market or FX pair has cleared, every planet prices goods at the same base in its own
 * currency, so parity is the implied rate and a good the destination does not produce is assumed
 * scarce there (+SCARCITY_BP). Such quotes are flagged `estimated`.
 */
function remoteQuotes(task: AgentTask, world: WorldConfig, home: string): Map<string, Quote[]> {
  const out = new Map<string, Quote[]>();
  for (const r of task.observation.elsewhere ?? []) {
    if (r.planet === task.planet) continue;
    const cur = currencyOf(world, r.planet);
    const makes = new Set(producedGoods(world, r.planet));
    const known = fxRatePpm(task.observation.fx, cur, home);
    const rate = known ?? RATE_SCALE;
    for (const g of r.goods) {
      const base = baseOf(world, g.good);
      const price = g.lastPrice ?? (base ? applyBand(base, makes.has(g.good) ? 0 : SCARCITY_BP) : null);
      if (!price) continue;
      const inHome = Math.floor((price * rate) / RATE_SCALE);
      if (inHome <= 0) continue;
      const netHome = Math.floor((inHome * (10_000 - g.tariffBp)) / 10_000);
      const estimated = g.lastPrice === null || known === null;
      out.set(g.good, [...(out.get(g.good) ?? []), { planet: r.planet, travelCycles: r.travelCycles, netHome, tariffBp: g.tariffBp, estimated }]);
    }
  }
  return out;
}

function localAsk(task: AgentTask, world: WorldConfig, good: string): number {
  const m = task.observation.markets.find((x) => x.good === good);
  return m?.asks[0]?.price ?? m?.lastPrice ?? baseOf(world, good) ?? 1;
}

function localBid(task: AgentTask, world: WorldConfig, good: string): number {
  const m = task.observation.markets.find((x) => x.good === good);
  return m?.bids[0]?.price ?? m?.lastPrice ?? baseOf(world, good) ?? 0;
}

function describeOrders(actions: Action[]): string {
  return actions.map((a) => (a.kind === 'place_order' ? `${a.side} ${a.qty} ${a.good} @ ${a.limitPrice}` : a.kind)).join('; ');
}

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : '0%');
