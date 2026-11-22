import { hashString } from '../scene/planet-look';
import type { Building } from './city-layout';
import { smoothstep } from './rng';

/** How a building is shown right now: how far it has risen out of the ground, and the height it is growing towards. */
export interface Shown {
  /** 0 (just planted, not drawn) to 1 (fully risen). Never goes down. */
  appear: number;
  /** Height the building has reached so far; chases the layout's height. */
  h: number;
  /** Seconds to wait before this building starts to rise, so a new ring does not pop up all at once. */
  delay: number;
}

export type GrowthState = Map<string, Shown>;

/** Seconds for a new building to rise. */
export const APPEAR_SECONDS = 1.6;
/** Longest stagger before a new building starts rising, seconds. */
export const MAX_DELAY = 1.2;
/** How fast an existing building closes on a new height (per second, exponential). */
const CHASE_RATE = 2.5;

/** A small stable delay (0 to MAX_DELAY) for a building id, so the same building always starts at the same offset. */
export function delayFor(id: string): number {
  return ((hashString(`delay:${id}`) % 1000) / 1000) * MAX_DELAY;
}

/**
 * Moves the display state `dt` seconds towards the layout. New buildings rise out of the ground after a short delay;
 * existing ones grow smoothly to a new height; with `instant` (the first layout seen) everything is simply there.
 * Nothing the layout still has ever shrinks or vanishes. Returns true while anything is still moving.
 */
export function stepGrowth(state: GrowthState, buildings: Building[], dt: number, instant = false): boolean {
  const present = new Set<string>();
  let moving = false;
  for (const b of buildings) {
    present.add(b.id);
    let s = state.get(b.id);
    if (!s) {
      s = instant ? { appear: 1, h: b.h, delay: 0 } : { appear: 0, h: b.h, delay: delayFor(b.id) };
      state.set(b.id, s);
    }
    if (s.delay > 0) {
      s.delay = Math.max(0, s.delay - dt);
      moving = true;
      continue;
    }
    if (s.appear < 1) {
      s.appear = Math.min(1, s.appear + dt / APPEAR_SECONDS);
      if (s.appear < 1) moving = true;
    }
    if (s.h < b.h) {
      s.h += (b.h - s.h) * (1 - Math.exp(-dt * CHASE_RATE));
      if (b.h - s.h < 0.02) s.h = b.h;
      else moving = true;
    } else if (s.h > b.h) {
      // Only happens if the population falls; follow it down gently.
      s.h = b.h;
    }
  }
  // Buildings the layout no longer has (population fell) are dropped.
  for (const id of state.keys()) if (!present.has(id)) state.delete(id);
  return moving;
}

/** The height to draw: the reached height, scaled by how far the building has risen out of the ground. */
export function shownHeight(s: Shown): number {
  return s.h * smoothstep(0, 1, s.appear);
}

/** True when nothing is waiting or moving: every building is fully up at its layout height. */
export function isSettled(state: GrowthState, buildings: Building[]): boolean {
  return buildings.every((b) => {
    const s = state.get(b.id);
    return !!s && s.delay === 0 && s.appear === 1 && s.h === b.h;
  });
}
