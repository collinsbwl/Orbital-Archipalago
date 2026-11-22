import type { PlanetSnapshot, SimEvent } from '@orbital/contracts';
import { eventAboutPlanet } from './crops';
import { clamp, smoothstep } from './rng';

/**
 * A planet's mood (Phase 11), worked out from its confidence readings and the recent news. Pure.
 * `moodScores` reads the economy; `stepMood` turns the scores into a mood that changes kind with hysteresis (so it does
 * not flicker at a threshold) and eases between moods so the weather never jumps.
 */

export type MoodKind = 'calm' | 'gloomy' | 'storm' | 'festive';

/** How strongly each mood pulls, 0 to 1. */
export interface MoodScores {
  storm: number;
  gloom: number;
  cheer: number;
}

/** The mood as shown: its kind and smoothly eased amounts of each weather. */
export interface MoodState {
  kind: MoodKind;
  /** 0 clear to 1 full storm. */
  storm: number;
  /** 0 to 1: low spirits, overcast. */
  gloom: number;
  /** 0 to 1: festival mood. */
  cheer: number;
}

/** News stays in the mood for this many cycles, fading over the last two thirds. */
export const NEWS_CYCLES = 8;
/** Seconds the shown mood takes to cover about two thirds of the way to a new target. */
export const EASE_SECONDS = 2.5;

type Metrics = Pick<PlanetSnapshot['metrics'], 'consumerConfidence' | 'businessConfidence'>;
type NewsItem = Pick<SimEvent, 'cycle' | 'kind' | 'planet' | 'text'>;

const BAD = /crash|collapse|riot|shortage|famine|blight|drought|panic|default|crisis|recession|strike|embargo|outage|unrest|plunge|storm/i;
const GOOD = /boom|record|surge|festival|celebrat|windfall|bumper|prosper|growth|rally|discover|surplus|triumph|jubilee|upswing/i;

/** 1 for fresh news, fading to 0 after `NEWS_CYCLES`. */
const freshness = (age: number): number => (age < 0 || age > NEWS_CYCLES ? 0 : 1 - smoothstep(NEWS_CYCLES / 3, NEWS_CYCLES, age));

/** Mean of the two confidence readings as 0..1; missing readings count as middling. */
export function confidenceOf(metrics: Metrics | undefined): number {
  const c = metrics ? metrics.consumerConfidence / 100 : 0.65;
  const b = metrics ? metrics.businessConfidence / 100 : 0.65;
  return clamp((c + b) / 2, 0, 1);
}

/**
 * How stormy, gloomy and cheerful the planet is. A crisis or shock about the planet means a storm, bad headlines a milder
 * one; low confidence means gloom; high confidence or a good headline means cheer (never in a storm).
 */
export function moodScores(args: { metrics: Metrics | undefined; events: NewsItem[]; planet: string; cycle: number }): MoodScores {
  const { metrics, events, planet, cycle } = args;
  let storm = 0;
  let good = 0;
  for (const e of events) {
    if (e.kind === 'policy' || !eventAboutPlanet(e, planet)) continue;
    const fresh = freshness(cycle - e.cycle);
    if (fresh === 0) continue;
    if (e.kind === 'crisis' || e.kind === 'shock') storm = Math.max(storm, fresh);
    else if (BAD.test(e.text)) storm = Math.max(storm, 0.65 * fresh);
    else if (e.kind === 'headline' && GOOD.test(e.text)) good = Math.max(good, fresh);
  }
  const conf = confidenceOf(metrics);
  const gloom = clamp((0.45 - conf) / 0.25, 0, 1);
  const cheer = Math.max(clamp((conf - 0.72) / 0.2, 0, 1), good) * (1 - storm);
  return { storm, gloom, cheer };
}

/** Score needed to enter a mood, and the lower score that keeps it once in (the gap is the hysteresis). */
const ENTER = { storm: 0.6, gloom: 0.5, cheer: 0.6 };
const STAY = { storm: 0.3, gloom: 0.25, cheer: 0.35 };

/** The mood kind for these scores given the one before: a mood is hard to enter and easy to stay in. Storm beats gloom beats festival. */
export function nextKind(prev: MoodKind, s: MoodScores): MoodKind {
  if (s.storm >= (prev === 'storm' ? STAY.storm : ENTER.storm)) return 'storm';
  if (s.gloom >= (prev === 'gloomy' ? STAY.gloom : ENTER.gloom)) return 'gloomy';
  if (s.cheer >= (prev === 'festive' ? STAY.cheer : ENTER.cheer)) return 'festive';
  return 'calm';
}

/** What each kind eases towards. */
export function moodTarget(kind: MoodKind, s: MoodScores): Omit<MoodState, 'kind'> {
  switch (kind) {
    case 'storm': return { storm: 0.6 + 0.4 * s.storm, gloom: 0.35, cheer: 0 };
    case 'gloomy': return { storm: 0, gloom: 0.6 + 0.4 * s.gloom, cheer: 0 };
    case 'festive': return { storm: 0, gloom: 0, cheer: 0.6 + 0.4 * s.cheer };
    default: return { storm: 0, gloom: 0, cheer: 0 };
  }
}

export const CALM: MoodState = { kind: 'calm', storm: 0, gloom: 0, cheer: 0 };

/** One time step: pick the kind (with hysteresis) and ease the amounts toward it. `dt` is seconds. Returns a new state. */
export function stepMood(prev: MoodState, scores: MoodScores, dt: number): MoodState {
  const kind = nextKind(prev.kind, scores);
  const target = moodTarget(kind, scores);
  const k = 1 - Math.exp(-Math.max(0, dt) / EASE_SECONDS);
  return {
    kind,
    storm: prev.storm + (target.storm - prev.storm) * k,
    gloom: prev.gloom + (target.gloom - prev.gloom) * k,
    cheer: prev.cheer + (target.cheer - prev.cheer) * k,
  };
}

/** The mood state a planet settles into with these scores (what `stepMood` converges to), for first paint. */
export function settledMood(scores: MoodScores): MoodState {
  const kind = nextKind('calm', scores);
  return { kind, ...moodTarget(kind, scores) };
}

/**
 * The 0..1 multiplier for crowds, vehicles, stalls and smoke: full streets in a festival, quieter when gloomy, nearly
 * empty in a storm.
 */
export function busynessOf(m: Pick<MoodState, 'storm' | 'gloom' | 'cheer'>): number {
  return clamp(0.9 + 0.1 * m.cheer - 0.6 * m.storm - 0.3 * m.gloom, 0.1, 1);
}

/** Busyness rounded to steps of 0.05, so a component only re-renders when it really changes. */
export const stepBusyness = (b: number): number => Math.round(b * 20) / 20;
