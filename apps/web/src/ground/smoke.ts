import { hashString } from '../scene/planet-look';
import type { EmitterKind } from './industry';
import { smoothstep } from './rng';

/**
 * Smoke and flame puffs for the points industry gives off from (Phase 10). Pure: given a time, each puff's place and
 * size follow from its emitter and index, so nothing has to be stored between frames.
 */

export interface PuffLayer {
  /** Smoke is dull and lit by the sun; fire glows. */
  kind: 'smoke' | 'fire';
  /** Puffs in the cycle of this layer, per emitter, at full density. */
  count: number;
  /** Seconds from leaving the emitter to fading out. */
  life: number;
  /** Metres risen over a life. */
  rise: number;
  /** Metres blown downwind over a life. */
  drift: number;
  /** Radius at birth and at the end of life, metres. */
  size: [number, number];
  /** Colour at birth and at the end. */
  color: [string, string];
}

/** What each kind of emitter gives off. */
export const LAYERS: Record<EmitterKind, PuffLayer[]> = {
  chimney: [{ kind: 'smoke', count: 8, life: 8, rise: 12, drift: 9, size: [0.5, 2.4], color: ['#7d7f86', '#c4c7cc'] }],
  flare: [
    { kind: 'fire', count: 4, life: 0.7, rise: 2.5, drift: 0.6, size: [0.9, 0.2], color: ['#ffd36a', '#ff6a1f'] },
    { kind: 'smoke', count: 5, life: 6, rise: 10, drift: 10, size: [0.6, 2.2], color: ['#2e2f33', '#6b6e75'] },
  ],
  forge: [
    { kind: 'smoke', count: 6, life: 7, rise: 9, drift: 8, size: [0.5, 2], color: ['#55575d', '#aeb1b7'] },
    { kind: 'fire', count: 3, life: 1.1, rise: 3, drift: 0.8, size: [0.35, 0.1], color: ['#ffb347', '#ff5a1a'] },
  ],
};

/** Most puffs a single emitter can have, so renderers can size their buffers. */
export const MAX_PUFFS_PER_EMITTER = Math.max(...Object.values(LAYERS).map((ls) => ls.reduce((n, l) => n + l.count, 0)));

export interface Wind {
  x: number;
  z: number;
}

/** A steady wind direction for the planet (unit vector). */
export function windFor(planet: string): Wind {
  const a = ((hashString(`${planet}:wind`) >>> 2) % 360) * (Math.PI / 180);
  return { x: Math.sin(a), z: Math.cos(a) };
}

export interface Puff {
  x: number;
  y: number;
  z: number;
  /** Radius, metres. Shrinks to nothing at the very end of life, so a puff fades rather than pops. */
  radius: number;
  /** 0 at birth, 1 at the end of its life. */
  age: number;
}

/**
 * Puff `k` of a layer from an emitter, `time` seconds in, or null while that puff is switched off. A density of 0 to 1
 * shows that share of the layer's puffs (the first ones, so a rising density only adds puffs).
 */
export function puffAt(emitter: { x: number; y: number; z: number }, emitterIndex: number, layer: PuffLayer, k: number, time: number, wind: Wind, density: number): Puff | null {
  if (density <= 0 || k >= Math.ceil(layer.count * Math.min(1, density) - 1e-9)) return null;
  const stagger = ((hashString(`puff:${emitterIndex}`) % 1000) / 1000 + k) / layer.count;
  const age = (((time / layer.life + stagger) % 1) + 1) % 1;
  const [r0, r1] = layer.size;
  // Rises fast at first, then slows; a little sideways wobble so the column is not a straight line.
  const lift = 1 - (1 - age) ** 2;
  const wobble = Math.sin(time * 1.3 + k * 2.1 + emitterIndex) * 0.4 * age;
  return {
    x: emitter.x + wind.x * layer.drift * age + wobble,
    y: emitter.y + layer.rise * lift,
    z: emitter.z + wind.z * layer.drift * age - wobble,
    radius: (r0 + (r1 - r0) * age) * (1 - smoothstep(0.8, 1, age)),
    age,
  };
}
