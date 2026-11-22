// Candidate action bundles for a colonist. The rule logic that used to live
// only in StubPolicy now produces a small menu; StubPolicy takes the default
// bundle and DecisionPolicy lets Gemini Decision 1 pick one.

import type { Action, AgentTask, WorldConfig } from '@orbital/contracts';
import { applyBand, baseOf, producedGoods } from '../econ.js';
import type { Candidate } from './types.js';

export type { Candidate } from './types.js';

/** The bundle StubPolicy uses (and the pre-refactor stub behaviour). */
export const DEFAULT_COLONIST_CANDIDATE = 'buy_and_sell_surplus';

/** Band around reference price for "buy now" orders. DEFAULT: +5%. */
const BUY_NOW_BP = 500;
/** Band for patient buys. DEFAULT: -2%, may not fill this cycle. */
const BUY_PATIENT_BP = -200;
/** Sell 1% above the best bid. */
const SELL_BP = 100;
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

  const raw: Array<[string, string, Action[]]> = [
    [DEFAULT_COLONIST_CANDIDATE, 'Buy every missing need near market price (+5%) and sell surplus of goods this planet produces', [...buyNow, ...sells]],
    ['buy_needs_now', 'Buy every missing need near market price (+5%); keep surplus goods', buyNow],
    ['buy_needs_patient', 'Bid for missing needs 2% below market price; cheaper but may not fill this cycle', buyPatient],
    ['buy_essentials_only', 'Buy only the first missing need; save the rest of the purse', buyEssential],
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

function buyNeeds(task: AgentTask, world: WorldConfig, purse: number, bandBp: number, firstOnly: boolean): Action[] {
  const obs = task.observation;
  const actions: Action[] = [];
  let budget = purse;
  for (const need of world.colonistNeeds) {
    const have = obs.inventory[need.good] ?? 0;
    if (have >= need.qty) continue;
    const market = obs.markets.find((m) => m.good === need.good);
    const refPrice = market?.lastPrice ?? baseOf(world, need.good) ?? 1;
    const limit = applyBand(refPrice, bandBp);
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
    const market = obs.markets.find((m) => m.good === good);
    const bestBid = market?.bids[0]?.price ?? market?.lastPrice ?? baseOf(world, good);
    if (!bestBid) continue;
    actions.push({ kind: 'place_order', good, side: 'sell', qty: Math.min(stock - KEEP_STOCK, MAX_SELL), limitPrice: applyBand(bestBid, SELL_BP) });
  }
  return actions;
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
