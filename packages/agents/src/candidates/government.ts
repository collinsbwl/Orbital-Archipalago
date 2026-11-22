// Candidate policy moves for a planet's government. The policy rate belongs to
// the reserve bank's Taylor rule, so governments only touch trade policy:
// tariffs (in 5-point steps) and lifting embargoes. Gemini Decision 1 picks one.

import type { AgentTask, WorldConfig } from '@orbital/contracts';
import { baseOf, producedGoods } from '../econ.js';
import { dedupe, HOLD, optionId, type Candidate } from './types.js';

/** Tariff step per move. DEFAULT: 5 percentage points. */
export const TARIFF_STEP_BP = 500;
/** Highest tariff a government will propose. DEFAULT: 30%. */
export const MAX_GOV_TARIFF_BP = 3_000;
/** Price move over the visible trend that counts as a signal. DEFAULT: 3%. */
const SIGNAL_BP = 300;
/** Moves of each kind offered. */
const PER_KIND = 2;

export function governmentCandidates(task: AgentTask, world: WorldConfig): Candidate[] {
  const obs = task.observation;
  const allowed = new Set(task.allowedActions);
  const produced = new Set(producedGoods(world, task.planet));
  const tariffs = obs.policy.tariffsBp;
  const out: Candidate[] = [];

  // Two signals per good: the visible trend, and where the price sits against its base (calm markets have no trend).
  const signals = obs.markets.map((m) => {
    const base = baseOf(world, m.good);
    const price = m.lastPrice ?? m.trend.at(-1) ?? null;
    return {
      good: m.good,
      change: trendBp(m.trend) ?? 0,
      level: base && price !== null ? Math.floor(((price - base) * 10_000) / base) : null,
    };
  });

  if (allowed.has('set_tariff')) {
    // Protect domestic producers whose price is falling or sits below base (cheap imports).
    const raises = signals
      .filter((t) => produced.has(t.good) && (tariffs[t.good] ?? 0) < MAX_GOV_TARIFF_BP && (t.change <= -SIGNAL_BP || (t.level ?? 0) <= -SIGNAL_BP))
      .sort((a, b) => Math.min(a.change, a.level ?? 0) - Math.min(b.change, b.level ?? 0))
      .slice(0, PER_KIND);
    for (const t of raises) {
      const cur = tariffs[t.good] ?? 0;
      const next = Math.min(MAX_GOV_TARIFF_BP, cur + TARIFF_STEP_BP);
      out.push({
        id: optionId(`raise_tariff_${t.good}`),
        description: `Raise the import tariff on ${t.good} from ${pct(cur)} to ${pct(next)}: the planet produces ${t.good} and its price ${describe(t)}, so this shields local producers but raises costs for buyers.`,
        actions: [{ kind: 'set_tariff', good: t.good, rateBp: next }],
      });
    }
    // Relieve buyers where a taxed good is getting expensive or is no cheaper than base.
    const cuts = signals
      .filter((t) => (tariffs[t.good] ?? 0) > 0 && (t.change >= SIGNAL_BP || (t.level !== null && t.level >= 0)))
      .sort((a, b) => Math.max(b.change, b.level ?? 0) - Math.max(a.change, a.level ?? 0))
      .slice(0, PER_KIND);
    for (const t of cuts) {
      const cur = tariffs[t.good]!;
      const next = Math.max(0, cur - TARIFF_STEP_BP);
      out.push({
        id: optionId(`${next === 0 ? 'remove' : 'cut'}_tariff_${t.good}`),
        description: `${next === 0 ? 'Remove' : 'Cut'} the import tariff on ${t.good} from ${pct(cur)} to ${pct(next)}: its price ${describe(t)}, so cheaper imports would ease prices but expose local producers.`,
        actions: [{ kind: 'set_tariff', good: t.good, rateBp: next }],
      });
    }
  }

  if (allowed.has('set_embargo')) {
    for (const target of obs.policy.embargoes.slice(0, PER_KIND)) {
      out.push({
        id: optionId(`lift_embargo_${target}`),
        description: `Lift the embargo on ${target}, letting its shipments land here again.`,
        actions: [{ kind: 'set_embargo', target, active: false }],
      });
    }
  }

  out.push({ ...HOLD, description: 'Keep current trade policy unchanged this review.' });
  return dedupe(out);
}

/** Change from the oldest to the newest visible clearing price, in bp. Null without two prices. */
function trendBp(trend: number[]): number | null {
  if (trend.length < 2) return null;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  return first > 0 ? Math.floor(((last - first) * 10_000) / first) : null;
}

function describe(t: { change: number; level: number | null }): string {
  const parts: string[] = [];
  if (t.change !== 0) parts.push(`${t.change > 0 ? 'rose' : 'fell'} ${pct(Math.abs(t.change))} recently`);
  if (t.level !== null) parts.push(t.level === 0 ? 'is at its base level' : `is ${pct(Math.abs(t.level))} ${t.level > 0 ? 'above' : 'below'} base`);
  return parts.join(' and ') || 'is steady';
}

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;
