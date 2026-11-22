import { hashString } from '../scene/planet-look';
import { alienActivity, STRIDE_LENGTH } from './alien-rig';
import { sampleLoop } from './city-layout';
import type { Loop } from './city-layout';
import { clamp, makeRng, smoothstep } from './rng';

/** How many aliens there are. Always the same, so a planet's crowd is always all there. */
export const ALIEN_COUNT = 30;
export function alienCount(): number {
  return ALIEN_COUNT;
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
  /** Unused by the pose now (the bob follows the legs); kept so existing specs stay the same. */
  bob: number;
  /** Seconds walking, then seconds stopped to talk, before it walks on again. */
  walkSpan: number;
  talkSpan: number;
  /** Shifts it along its walk/talk cycle so a crowd is not in step. */
  cycleOffset: number;
  /** Seed for its gestures (radians), so neighbours talk differently. */
  voice: number;
  /** Shade, 0 to 1, picks its suit colour. */
  suit: number;
  /** Shifts its walking-cycle phase so two aliens on the same path do not step in unison. */
  strideOffset: number;
  /** 0 for a loner; for a talking pair, +1 for one member and -1 for the other (they take turns speaking). */
  role: 0 | 1 | -1;
  /** How far it swings round to face its partner while they talk, radians (0 for a loner). */
  turn: number;
  /** Shared by both members of a pair: sets when they swap who is speaking. */
  pairPhase: number;
}

/** Skin colour of each planet's aliens; any other planet gets the first. */
export const ALIEN_SKINS: Record<string, string> = { verdan: '#6fd08a', tethys: '#6fa8e8', helion: '#f0a050' };
export const DEFAULT_SKIN = ALIEN_SKINS.verdan!;
/** Suit colours aliens pick from by their `suit`: pinks and magentas. */
export const ALIEN_SUITS = ['#d6246e', '#c42a7a', '#e0307a', '#b02a86'];

/** A planet's skin colour, a little lighter or darker per alien (`tint` 0 to 1). Never brighter than the base. */
export function alienSkin(planet: string, tint: number): string {
  const base = ALIEN_SKINS[planet] ?? DEFAULT_SKIN;
  const k = 0.8 + 0.2 * clamp(tint, 0, 1);
  const n = parseInt(base.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * k).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** How far a walker may stray to either side of its loop's line, metres. */
export const LATERAL_RANGE = 1.0;

/** How many talking pairs there are (each pair is two of the aliens). */
export const PAIR_COUNT = 10;
/** How far apart, sideways, a pair walks, metres. */
export const PAIR_GAP = 1.1;

type Rng = () => number;

/** One walker on its own. */
function loner(rng: Rng, loops: Loop[]): AlienSpec {
  const loop = Math.floor(rng() * loops.length);
  const spec: AlienSpec = {
    loop, offset: rng() * loops[loop]!.length, speed: 0.8 + rng() * 0.9, direction: rng() < 0.5 ? 1 : -1,
    lateral: (rng() - 0.5) * 2 * LATERAL_RANGE, scale: 0.85 + rng() * 0.35, tint: rng(), bob: rng() * Math.PI * 2,
    walkSpan: 8 + rng() * 14, talkSpan: 3 + rng() * 5, cycleOffset: 0, voice: rng() * Math.PI * 2, suit: rng(),
    strideOffset: rng() * Math.PI * 2, role: 0, turn: 0, pairPhase: 0,
  };
  spec.cycleOffset = rng() * (spec.walkSpan + spec.talkSpan);
  return spec;
}

/**
 * Spreads `count` walkers at random over the gathering loops. The first `pairs` couples (two aliens each) walk side by side
 * on the same path and stop together; while they talk they turn to face each other and take turns speaking. The rest walk
 * alone. Seeded by planet.
 */
export function makeAliens(loops: Loop[], count: number, planet: string, pairs = PAIR_COUNT): AlienSpec[] {
  const rng = makeRng(hashString(`${planet}:aliens`));
  const out: AlienSpec[] = [];
  for (let p = 0; p < Math.min(pairs, Math.floor(count / 2)); p++) {
    const a = loner(rng, loops);
    const b = loner(rng, loops);
    // b shares a's path, pace and timing, so the two stay abreast and stop and start together.
    Object.assign(b, { loop: a.loop, offset: a.offset, speed: a.speed, direction: a.direction, walkSpan: a.walkSpan, talkSpan: a.talkSpan, cycleOffset: a.cycleOffset });
    const middle = (rng() - 0.5) * 2 * (LATERAL_RANGE - PAIR_GAP / 2);
    a.lateral = middle - PAIR_GAP / 2;
    b.lateral = middle + PAIR_GAP / 2;
    // A positive lateral is the walker's own left or right; each turns a quarter turn toward the other.
    a.role = 1;
    b.role = -1;
    a.turn = -Math.PI / 2;
    b.turn = Math.PI / 2;
    a.pairPhase = b.pairPhase = rng() * Math.PI * 2;
    out.push(a, b);
  }
  while (out.length < count) out.push(loner(rng, loops));
  return out;
}

/** Metres either side of a walker that its heading looks at, so it turns smoothly round bends instead of snapping at corners. */
const LOOK = 0.4;

/** Seconds per turn of speaking inside a pair: each speaks for half of it. */
const TURN_RATE = 1.1;

export interface AlienPose {
  x: number;
  z: number;
  /** Turn about the vertical axis, so the alien faces where it walks. */
  heading: number;
  /** Small up-and-down step, metres. */
  bob: number;
  /** 0 standing, 1 walking; 0 not talking, 1 talking; and the walking-cycle phase in radians. */
  walk: number;
  talk: number;
  stride: number;
  /** 0 listening, 1 speaking; a loner is always 1. Pairs trade this back and forth. */
  speak: number;
  /** True for a member of a talking pair. */
  paired: boolean;
}

/** Where a walker is `time` seconds in. Pure: the same time gives the same pose. */
export function alienPose(loops: Loop[], spec: AlienSpec, time: number): AlienPose {
  const loop = loops[spec.loop]!;
  const act = alienActivity(spec, time);
  const metres = spec.speed * act.walked;
  const here = spec.offset + spec.direction * metres;
  // Which way it is going, taken from the loop a little behind and ahead rather than the segment under its feet. A polygon's
  // corners would otherwise snap the heading and make the sideways shift jump; this tangent changes smoothly everywhere.
  const q = sampleLoop(loop, here);
  const ahead = sampleLoop(loop, here + spec.direction * LOOK);
  const behind = sampleLoop(loop, here - spec.direction * LOOK);
  const len = Math.hypot(ahead.x - behind.x, ahead.z - behind.z) || 1;
  const dx = (ahead.x - behind.x) / len;
  const dz = (ahead.z - behind.z) / len;
  const stride = (metres / STRIDE_LENGTH) * Math.PI * 2 + spec.strideOffset;
  return {
    x: q.x + -dz * spec.lateral,
    z: q.z + dx * spec.lateral,
    // While talking, a pair swing round to face each other; a loner keeps the way it was walking.
    heading: Math.atan2(dx, dz) + spec.turn * act.face,
    bob: Math.abs(Math.cos(stride)) * 0.06 * act.walk,
    walk: act.walk,
    talk: act.talk,
    stride,
    speak: spec.role === 0 ? 1 : smoothstep(-0.25, 0.25, spec.role * Math.sin(time * TURN_RATE + spec.pairPhase)),
    paired: spec.role !== 0,
  };
}
