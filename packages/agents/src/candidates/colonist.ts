// Candidate action bundles for a colonist. The rule logic that used to live
// only in StubPolicy now produces a small menu; StubPolicy takes the default
// bundle and DecisionPolicy lets Gemini Decision 1 pick one.

import type { Action, AgentTask, MarketView, WorldConfig } from '@orbital/contracts';
import { applyBand, baseOf, producedGoods } from '../econ.js';
import type { Candidate } from './types.js';

export type { Candidate } from './types.js';

/** The bundle StubPolicy uses (and the pre-refactor stub behaviour). */
export const DEFAULT_COLONIST_CANDIDATE = 'buy_and_sell_surplus';

/** Band around reference price for "buy now" orders. DEFAULT: +5%. */
const BUY_NOW_BP = 500;
/** Band for patient buys. DEFAULT: -2%, may not fill this cycle. */
const BUY_PATIENT_BP = -200;
/** Extra bid per cycle a need has gone unmet. DEFAULT: +10% a cycle. */
export const HUNGER_STEP_BP = 1_000;
/** Cap on the hunger premium. DEFAULT: +100% (on top of the bundle's own band). */
export const MAX_HUNGER_BP = 10_000;
/** Sell 1% above the best bid when the book is balanced. */
const SELL_BP = 100;
/** Ask this far over the last price when bids outnumber the units on offer. DEFAULT: +5%. */
export const SELL_RAISE_BP = 500;
/** ...and this far when bids are at least twice the units on offer. DEFAULT: +10%. */
export const SELL_SQUEEZE_BP = 1_000;
/** Undercut the cheapest ask by this much when offers outnumber bids. DEFAULT: -3%. */
export const SELL_UNDERCUT_BP = -300;
/** Never ask below this share of the base price. DEFAULT: 30%. */
export const MIN_ASK_SHARE_BP = 3_000;
/** Keep this many units of a produced good back from sale. */
const KEEP_STOCK = 2;
/** Most units sold per good per cycle. */
const MAX_SELL = 5;

export function colonistCandidates(task: AgentTask, world: WorldConfig): Candidate[] {
  const hold: Candidate = { id: 'hold', description: 'Do nothing this cycle and keep the whole purse.', actions: [{ kind: 'pass' }] };
  if (!task.allowedActions.includes('place_order')) return [hold];

  const planet = world.planets.find((p) => p.id === task.planet);
  const currency = planet?.currency ?? '';
  const purse = task.observation.purse[currency] ?? 0;

  const buyNow = buyNeeds(task, world, purse, BUY_NOW_BP, false);
  const buyPatient = buyNeeds(task, world, purse, BUY_PATIENT_BP, false);
  const buyEssential = buyNeeds(task, world, purse, BUY_NOW_BP, true);
  const sells = sellSurplus(task, world);
  const hungry = hungerNote(task);

  const raw: Array<[string, string, Action[]]> = [
    [DEFAULT_COLONIST_CANDIDATE, `${hungry}Buy every missing need near market price (+5%) and sell surplus of goods this planet produces`, [...buyNow, ...sells]],
    ['buy_needs_now', `${hungry}Buy every missing need near market price (+5%); keep surplus goods`, buyNow],
    ['buy_needs_patient', `${hungry}Bid for missing needs 2% below market price; cheaper but may not fill this cycle`, buyPatient],
    ['buy_essentials_only', `${hungry}Buy only the first missing need; save the rest of the purse`, buyEssential],
    ['sell_surplus_only', 'Sell surplus of goods this planet produces; buy nothing', sells],
  ];

  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const [id, lead, actions] of raw) {
    if (actions.length === 0) continue;
    const key = JSON.stringify(actions);
    if (seen.has(key)) continue; // identical bundle under an earlier id
    seen.add(key);
    out.push({ id, description: `${lead}. ${summarise(actions, purse, currency)}`, actions });
  }
  out.push(hold);
  return out;
}

/** Hunger premium for a need: HUNGER_STEP_BP per cycle it has gone unmet, capped at MAX_HUNGER_BP. */
export function hungerPremiumBp(task: AgentTask, good: string): number {
  return Math.min(MAX_HUNGER_BP, (task.observation.hunger?.[good] ?? 0) * HUNGER_STEP_BP);
}

/** "Short of grain for 3 cycles, water for 1 cycle; bids carry a hunger premium. " or "" when every need was met. */
function hungerNote(task: AgentTask): string {
  const short = Object.entries(task.observation.hunger ?? {}).filter(([, n]) => n > 0);
  if (short.length === 0) return '';
  const parts = short.map(([g, n]) => `${g} for ${n} cycle${n === 1 ? '' : 's'}`);
  return `Short of ${parts.join(', ')}; bids carry a hunger premium. `;
}

function buyNeeds(task: AgentTask, world: WorldConfig, purse: number, bandBp: number, firstOnly: boolean): Action[] {
  const obs = task.observation;
  const actions: Action[] = [];
  let budget = purse;
  for (const need of world.colonistNeeds) {
    const have = obs.inventory[need.good] ?? 0;
    if (have >= need.qty) continue;
    const market = obs.markets.find((m) => m.good === need.good);
    const refPrice = market?.lastPrice ?? baseOf(world, need.good) ?? 1;
    // Each cycle without a need, the colonist bids harder for it.
    const limit = applyBand(refPrice, bandBp + hungerPremiumBp(task, need.good));
    const canAfford = Math.floor(budget / limit);
    const qty = Math.max(0, Math.min(need.qty - have, canAfford));
    if (qty > 0) {
      actions.push({ kind: 'place_order', good: need.good, side: 'buy', qty, limitPrice: limit });
      budget -= qty * limit;
      if (firstOnly) break;
    }
  }
  return actions;
}

function sellSurplus(task: AgentTask, world: WorldConfig): Action[] {
  const obs = task.observation;
  const actions: Action[] = [];
  for (const good of producedGoods(world, task.planet)) {
    const stock = obs.inventory[good] ?? 0;
    if (stock <= KEEP_STOCK) continue;
    const limitPrice = askPrice(obs.markets.find((m) => m.good === good), baseOf(world, good));
    if (limitPrice === null) continue;
    actions.push({ kind: 'place_order', good, side: 'sell', qty: Math.min(stock - KEEP_STOCK, MAX_SELL), limitPrice });
  }
  return actions;
}

const totalQty = (levels: readonly { qty: number }[] | undefined) => (levels ?? []).reduce((s, l) => s + l.qty, 0);

/**
 * Where a colonist asks, read off the visible book:
 * - bids outnumber the units on offer: over the last price (SELL_RAISE_BP, or SELL_SQUEEZE_BP at 2x), and never under
 *   the best bid, so the price climbs while buyers outbid each other;
 * - offers outnumber bids: under the cheapest ask (SELL_UNDERCUT_BP), so a glut drags the price down;
 * - balanced: just over the best bid (SELL_BP).
 * Never below MIN_ASK_SHARE_BP of base. Null when there is no price to start from.
 */
export function askPrice(market: MarketView | undefined, base: number | null | undefined): number | null {
  const bestBid = market?.bids[0]?.price;
  const bestAsk = market?.asks[0]?.price;
  const last = market?.lastPrice ?? base;
  const ref = bestBid ?? last;
  if (!ref) return null;
  const demand = totalQty(market?.bids);
  const supply = totalQty(market?.asks);
  let price: number;
  if (demand > supply) price = Math.max(bestBid ?? 0, applyBand(last ?? ref, demand >= 2 * supply ? SELL_SQUEEZE_BP : SELL_RAISE_BP));
  else if (supply > demand && bestAsk !== undefined) price = applyBand(Math.min(bestAsk, ref), SELL_UNDERCUT_BP);
  else price = applyBand(ref, SELL_BP);
  const floor = base ? Math.ceil((base * MIN_ASK_SHARE_BP) / 10_000) : 1;
  return Math.max(floor, price);
}

function summarise(actions: Action[], purse: number, currency: string): string {
  const parts: string[] = [];
  let spend = 0;
  let earn = 0;
  for (const a of actions) {
    if (a.kind !== 'place_order') continue;
    parts.push(`${a.side} ${a.qty} ${a.good} @ ${a.limitPrice}`);
    if (a.side === 'buy') spend += a.qty * a.limitPrice;
    else earn += a.qty * a.limitPrice;
  }
  const pct = purse > 0 ? Math.round((spend * 100) / purse) : 0;
  return `Orders: ${parts.join('; ')}. Spends up to ${spend} of ${purse} ${currency} (${pct}%), earns up to ${earn}.`;
}
