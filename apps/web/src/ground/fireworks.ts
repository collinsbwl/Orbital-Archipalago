import { hashString } from '../scene/planet-look';
import { makeRng } from './rng';
import type { Vec3 } from './sky-bodies';

/**
 * Fireworks for a festival night (Phase 11). Pure: for any time it says which bursts are in the air and where every
 * spark is, so the same seed always gives the same show. Two launch streams each fire at most one rocket per slot.
 */

export const SLOT_SECONDS = 5;
export const STREAMS = 2;
/** Chance a slot has a rocket, so the show is occasional. */
export const FIRE_CHANCE = 0.55;
export const RISE_SECONDS = 1.1;
export const BURST_SECONDS = 2.6;
export const SPARKS = 48;
const SPEED = 24;
const GRAVITY = 9;

export interface Burst {
  /** Seconds since launch. */
  age: number;
  /** Where it left the ground (x, z) and how high it bursts. */
  x: number;
  z: number;
  height: number;
  color: [number, number, number];
}

const PALETTE: [number, number, number][] = [[1, 0.45, 0.35], [1, 0.85, 0.35], [0.45, 0.8, 1], [0.6, 1, 0.55], [0.9, 0.55, 1]];

/** Bursts in the air at time `t` (seconds). */
export function activeBursts(t: number, seed: string): Burst[] {
  const out: Burst[] = [];
  const base = hashString(`fireworks:${seed}`);
  for (let s = 0; s < STREAMS; s++) {
    const shifted = t + s * (SLOT_SECONDS / STREAMS);
    const slot = Math.floor(shifted / SLOT_SECONDS);
    const rng = makeRng(base + s * 7919 + slot * 104729);
    if (rng() > FIRE_CHANCE) continue;
    const age = shifted - slot * SLOT_SECONDS - rng() * 1.2;
    const a = rng() * Math.PI * 2;
    const dist = 55 + rng() * 60;
    const height = 55 + rng() * 35;
    const color = PALETTE[Math.floor(rng() * PALETTE.length)]!;
    if (age >= 0 && age < RISE_SECONDS + BURST_SECONDS) out.push({ age, x: Math.sin(a) * dist, z: Math.cos(a) * dist, height, color });
  }
  return out;
}

/** The rocket while it climbs, or null once it has burst. */
export function rocketPosition(b: Burst): Vec3 | null {
  if (b.age >= RISE_SECONDS) return null;
  const u = b.age / RISE_SECONDS;
  return [b.x, b.height * (1 - (1 - u) * (1 - u)), b.z];
}

/** Spark `i` of `SPARKS` after the burst, or null before it. Sparks fly out on a sphere, slow down and fall. */
export function sparkPosition(b: Burst, i: number): Vec3 | null {
  const age = b.age - RISE_SECONDS;
  if (age < 0) return null;
  // Evenly spread directions on a sphere.
  const y = 1 - (2 * (i + 0.5)) / SPARKS;
  const r = Math.sqrt(1 - y * y);
  const phi = i * 2.399963;
  const speed = SPEED * (0.7 + 0.3 * ((i * 37) % 10) / 10);
  const reach = speed * (1 - Math.exp(-age * 1.6)) / 1.6;
  return [b.x + Math.cos(phi) * r * reach, b.height + y * reach - 0.5 * GRAVITY * age * age * 0.35, b.z + Math.sin(phi) * r * reach];
}

/** How bright the sparks are: full at the burst, gone at the end. */
export const sparkFade = (b: Burst): number => Math.max(0, 1 - Math.max(0, b.age - RISE_SECONDS) / BURST_SECONDS) ** 1.5;
