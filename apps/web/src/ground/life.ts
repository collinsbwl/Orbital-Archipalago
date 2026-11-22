import type { PlanetSnapshot } from '@orbital/contracts';
import { clamp } from './rng';

/**
 * How lively the planet is (Phase 10), as 0..1 levels the life components scale their counts by. The economy sets the
 * base (confidence readings), and `busyness` is a 0..1 multiplier on top: the mood system (Phase 11) turns it down
 * in a storm or a crisis and up for a festival.
 */

export interface LifeLevels {
  /** Share of market stalls that are open. */
  stalls: number;
  /** Share of the traffic that is out driving. */
  traffic: number;
  /** How thick the smoke is (share of puffs shown). */
  smoke: number;
  /** The multiplier everything was scaled by. */
  busyness: number;
}

type Metrics = Pick<PlanetSnapshot['metrics'], 'consumerConfidence' | 'businessConfidence'>;

/** A 0..100 reading as 0..1; a missing reading counts as middling. */
const level = (v: number | undefined) => (v === undefined ? 0.65 : clamp(v / 100, 0, 1));

export function lifeLevels(metrics: Metrics | undefined, busyness = 1): LifeLevels {
  const b = clamp(busyness, 0, 1);
  const consumer = level(metrics?.consumerConfidence);
  const business = level(metrics?.businessConfidence);
  return {
    stalls: clamp((0.25 + 0.75 * consumer) * b, 0, 1),
    traffic: clamp((0.3 + 0.7 * (consumer + business) / 2) * b, 0, 1),
    smoke: clamp((0.2 + 0.8 * business) * b, 0, 1),
    busyness: b,
  };
}
