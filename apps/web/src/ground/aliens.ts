import { hashString } from '../scene/planet-look';
import { sampleLoop } from './city-layout';
import type { Loop } from './city-layout';
import { clamp, makeRng } from './rng';

export const MIN_ALIENS = 10;
export const MAX_ALIENS = 120;

/** How many aliens walk about: grows with the logarithm of the population, within fixed limits. */
export function alienCount(population: number | undefined): number {
  const digits = Math.log10(Math.max(1, population ?? 100_000));
  return Math.round(clamp(MIN_ALIENS + (digits - 2) * 10, MIN_ALIENS, MAX_ALIENS));
}

/** One walker: which loop, where on it, how fast, and what it looks like. */
export interface AlienSpec {
  loop: number;
  /** Starting distance along the loop, metres. */
  offset: number;
  /** Metres per second, always positive. */
  speed: number;
  /** +1 or -1: which way round the loop. */
  direction: 1 | -1;
  /** Sideways shift off the loop's line, metres, so walkers do not queue in single file. */
  lateral: number;
  /** Height multiplier. */
  scale: number;
  /** Shade, 0 to 1, picks a colour. */
  tint: number;
  /** Phase of the walking bob. */
  bob: number;
}

/** Spreads `count` walkers over the loops, more on the plaza loops, the rest along the roads. Seeded by planet. */
export function makeAliens(loops: Loop[], count: number, planet: string): AlienSpec[] {
  const rng = makeRng(hashString(`${planet}:aliens`));
  const out: AlienSpec[] = [];
  for (let i = 0; i < count; i++) {
    // A plaza loop gets roughly a third of the walkers (loops 0 and 1 are the plaza loops).
    const loop = rng() < 0.35 || loops.length <= 2 ? Math.floor(rng() * Math.min(2, loops.length)) : 2 + Math.floor(rng() * (loops.length - 2));
    out.push({
      loop, offset: rng() * loops[loop]!.length, speed: 0.8 + rng() * 0.9, direction: rng() < 0.5 ? 1 : -1,
      lateral: (rng() - 0.5) * 0.7, scale: 0.85 + rng() * 0.35, tint: rng(), bob: rng() * Math.PI * 2,
    });
  }
  return out;
}

export interface AlienPose {
  x: number;
  z: number;
  /** Turn about the vertical axis, so the alien faces where it walks. */
  heading: number;
  /** Small up-and-down step, metres. */
  bob: number;
}

/** Where a walker is `time` seconds in. Pure: the same time gives the same pose. */
export function alienPose(loops: Loop[], spec: AlienSpec, time: number): AlienPose {
  const loop = loops[spec.loop]!;
  const s = sampleLoop(loop, spec.offset + spec.direction * spec.speed * time);
  const dx = s.dx * spec.direction;
  const dz = s.dz * spec.direction;
  return {
    x: s.x + -dz * spec.lateral,
    z: s.z + dx * spec.lateral,
    heading: Math.atan2(dx, dz),
    bob: Math.abs(Math.sin(time * spec.speed * 4 + spec.bob)) * 0.06,
  };
}
