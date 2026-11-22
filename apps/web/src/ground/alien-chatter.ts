import { hashString } from '../scene/planet-look';
import type { AlienSpec } from './aliens';
import { TURN_RATE } from './aliens';
import { smoothstep } from './rng';

/**
 * What the talking pairs say. Drawn in the Standard Galactic Alphabet font, which maps each Latin letter to a glyph, so every
 * line is lowercase a-z and spaces only and anyone who knows the alphabet can read it. Kept short so a bubble stays small.
 */
export const CHATTER_LINES: readonly string[] = [
  'iron is up again',
  'the freighter is late',
  'did you see the fx rates',
  'my loan is due next cycle',
  'rations got cut again',
  'the reserve bank moved rates',
  'trade lanes are quiet today',
  'they say an embargo is coming',
  'buy low and ship it out',
  'the market opened hot',
  'tariffs are killing me',
  'heard the council voted',
  'another shipment docked',
  'prices never stop climbing',
  'save your credits friend',
  'the news drone is lying',
  'have you eaten today',
  'my cousin flies freighters',
  'the port is so crowded',
  'water costs more than fuel',
  'i sold everything at dawn',
  'the orbit looks clear',
  'what a strange sky',
  'the beacon blinked twice',
  'we need more workers',
  'is the ledger synced yet',
  'nobody trusts the bank',
  'ship it before the tariff',
  'wages are flat again',
  'long cycle huh',
  'i miss the old colony',
  'the stars look close tonight',
  'crisis talk is everywhere',
  'keep your head down',
  'cargo bay is full',
  'traders got rich again',
  'i might move planets',
  'the auction ran long',
  'see you at the market',
  'that ship is not ours',
];

/** Extra lines only heard on one planet, mixed in with the shared ones. */
export const PLANET_CHATTER: Readonly<Record<string, readonly string[]>> = {
  helion: [
    'the sun is brutal today',
    'solar yield is way up',
    'too hot to haul ore',
    'the panels need cleaning',
    'another flare warning',
    'my visor is melting',
    'helion runs on sunlight',
    'the forge never sleeps',
  ],
  verdan: [
    'the harvest looks huge',
    'grain prices are dropping',
    'the forest grew again',
    'rain is good for crops',
    'verdan feeds everyone',
    'my fields need more hands',
    'spores in the air again',
    'fresh fruit at the stalls',
  ],
  tethys: [
    'the ice is singing',
    'tethys ice sells high',
    'tides are rising early',
    'my igloo sprang a leak',
    'cold enough to freeze fuel',
    'the spires glow at night',
    'water exports are booming',
    'fish in the deep tides',
  ],
};

/** Every line a pair on this planet might say. */
export function chatterPool(planet: string): readonly string[] {
  const own = PLANET_CHATTER[planet];
  return own ? [...CHATTER_LINES, ...own] : CHATTER_LINES;
}

/** The speaking angle that `alienPose` feeds to `sin` to decide who of a pair is speaking. */
function turnAngle(time: number, spec: AlienSpec): number {
  return time * TURN_RATE + spec.pairPhase;
}

/**
 * Counts speaking turns: goes up by one each time a pair swap speakers. Even turns belong to the pair's first member
 * (`role` +1), odd turns to its partner, matching where `alienPose(...).speak` crosses one half.
 */
export function turnIndex(time: number, spec: AlienSpec): number {
  return Math.floor(turnAngle(time, spec) / Math.PI);
}

/** Numbers each walk-then-talk cycle, so every stop a pair makes gets fresh lines. Same split as `alienActivity`. */
export function stopIndex(time: number, spec: AlienSpec): number {
  return Math.floor((time + spec.cycleOffset) / (spec.walkSpan + spec.talkSpan));
}

/**
 * The line spoken on one turn of one stop. Deterministic, so every viewer sees the same conversation. Within a stop the
 * lines walk the pool in a fixed stride that is never a multiple of its size, so a reply never repeats the line before it.
 */
export function chatterLine(planet: string, pairIndex: number, stop: number, turn: number): string {
  const pool = chatterPool(planet);
  const n = pool.length;
  const seed = hashString(`${planet}:chat:${pairIndex}:${stop}`);
  const start = seed % n;
  const step = 1 + ((seed >>> 8) % (n - 1));
  // `turn` is never negative (time and pairPhase are not), but keep the index in range regardless.
  const i = (((start + turn * step) % n) + n) % n;
  return pool[i]!;
}

/**
 * Dips the bubble out for a moment as the pair swap speakers, so it fades between their heads instead of jumping.
 * 1 mid-turn, 0 right at the swap.
 */
export function turnFade(time: number, spec: AlienSpec): number {
  return smoothstep(0.05, 0.35, Math.abs(Math.sin(turnAngle(time, spec))));
}

/** How high above the ground the bubble's tail sits for an alien of scale 1, metres: just over its antennae (about 2 m). */
export const HEAD_CLEARANCE = 2.1;

/** Bubbles start to fade at this camera distance and are gone by the next, metres, so a wide view is not cluttered. */
export const CHAT_NEAR = 35;
export const CHAT_FAR = 55;

/** 1 for a nearby pair, falling to 0 for one far from the camera. */
export function distanceFade(distance: number): number {
  return 1 - smoothstep(CHAT_NEAR, CHAT_FAR, distance);
}
