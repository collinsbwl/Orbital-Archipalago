// StubPolicy — the smarter rule-based fallback used in the `stub` profile, when
// the budget is exhausted, and in CI. One class, role-specific branches.
//
// - Colonists buy their needs up to purse, priced near lastPrice/basePrice.
//   They sell goods their planet produces above the best bid. Confidence tracks
//   the price trend.
// - Traders pick the good with the largest cross-planet margin net of FX and
//   ship it. This follows comparative advantage from planet.recipes.
// - Governments and news default to pass / a canned headline.

import type { Action, AgentDecision, AgentTask, SurveyAnswer } from '@orbital/contracts';
import type { Policy, PolicyCtx } from '../policy.js';
import { colonistCandidates, DEFAULT_COLONIST_CANDIDATE } from '../candidates/colonist.js';
import { baseOf, confidenceFromTrend } from '../econ.js';

/** Minimum margin a trader needs before shipping. DEFAULT: 10%. */
const TRADER_MARGIN_BP = 1_000;
/** RATE_SCALE = 1_000_000 for ppm; keep the local copy to avoid a runtime import cycle. */
const RATE_SCALE = 1_000_000;

export class StubPolicy implements Policy {
  readonly name = 'stub';

  async decide(task: AgentTask, ctx: PolicyCtx): Promise<AgentDecision> {
    switch (task.role) {
      case 'colonist':
        return this.colonist(task, ctx);
      case 'trader':
        return this.trader(task, ctx);
      case 'government':
        return pass(task, 'routine review');
      case 'reserve_bank':
        // Reserve banks use RulePolicy by default; StubPolicy only sees them in the `stub` profile.
        return pass(task, 'hold rates');
      case 'news':
        return {
          agentId: task.agentId,
          actions: [{ kind: 'publish_headlines', headlines: ['Markets quiet as cycle closes.'] }],
          reason: 'canned headline',
          source: 'stub',
        };
      case 'economist':
        return {
          agentId: task.agentId,
          actions: [{ kind: 'write_report', text: 'Stub economist report: see metrics for details.' }],
          reason: 'stub report',
          source: 'stub',
        };
    }
  }

  // --------------------------------------------------------------- colonist

  private colonist(task: AgentTask, ctx: PolicyCtx): AgentDecision {
    // Same bundle the pre-refactor stub built: needs at +5% within purse, plus surplus sales.
    const pick = colonistCandidates(task, ctx.world).find((c) => c.id === DEFAULT_COLONIST_CANDIDATE);
    const actions: Action[] = pick ? pick.actions : [{ kind: 'pass' }];
    const survey: SurveyAnswer = { type: 'consumer', confidence: confidenceFromTrend(task.observation.markets.flatMap((m) => m.trend)) };
    return {
      agentId: task.agentId,
      actions,
      survey,
      reason: 'rule-based needs + surplus',
      source: 'stub',
    };
  }

  // --------------------------------------------------------------- trader

  private trader(task: AgentTask, ctx: PolicyCtx): AgentDecision {
    const { observation: obs } = task;
    const home = ctx.world.planets.find((p) => p.id === task.planet);
    if (!home) return pass(task, 'unknown planet');

    // Candidate margins: for each good we see a local price for, compare to each
    // peer planet's last price (converted to home currency through FX).
    type Candidate = { good: string; to: string; margin: number; buyPrice: number; qty: number };
    const candidates: Candidate[] = [];

    for (const peer of ctx.world.planets) {
      if (peer.id === home.id) continue;
      const rate = findFxRate(obs.fx, home.currency, peer.currency);
      if (rate == null) continue;
      for (const market of obs.markets) {
        // Local ask on the home planet (buy price).
        const localAsk = market.asks[0]?.price ?? market.lastPrice;
        if (!localAsk) continue;
        // Peer price lives in a separate market view the trader observed on the peer
        // planet — represented by the market's trend tail priced in peer currency.
        // Lacking that from a lone AgentTask, use peer basePrice × (peer vs home ratio).
        const peerBase = baseOf(ctx.world, market.good);
        if (!peerBase) continue;
        const peerPriceInHome = Math.floor((peerBase * RATE_SCALE) / rate);
        const marginBp = Math.floor(((peerPriceInHome - localAsk) * 10_000) / Math.max(1, localAsk));
        if (marginBp < TRADER_MARGIN_BP) continue;
        candidates.push({ good: market.good, to: peer.id, margin: marginBp, buyPrice: localAsk, qty: 5 });
      }
    }

    candidates.sort((a, b) => b.margin - a.margin);
    const pick = candidates[0];
    if (!pick || !task.allowedActions.includes('ship')) return pass(task, 'no profitable route');

    const action: Action = { kind: 'ship', to: pick.to, cargo: [{ good: pick.good, qty: pick.qty }] };
    const survey: SurveyAnswer = { type: 'business', confidence: Math.min(100, 50 + Math.floor(pick.margin / 200)) };
    return {
      agentId: task.agentId,
      actions: [action],
      survey,
      reason: `ship ${pick.good} to ${pick.to}, ${pick.margin}bp margin`,
      memo: `watching ${pick.good}:${pick.to}`,
      source: 'stub',
    };
  }
}

function pass(task: AgentTask, reason: string): AgentDecision {
  return { agentId: task.agentId, actions: [{ kind: 'pass' }], reason, source: 'stub' };
}

function findFxRate(
  fx: Array<{ base: string; quote: string; lastRatePpm: number | null }>,
  base: string,
  quote: string,
): number | null {
  const direct = fx.find((f) => f.base === base && f.quote === quote);
  if (direct?.lastRatePpm) return direct.lastRatePpm;
  const inverse = fx.find((f) => f.base === quote && f.quote === base);
  if (inverse?.lastRatePpm) return Math.floor((RATE_SCALE * RATE_SCALE) / inverse.lastRatePpm);
  return null;
}
