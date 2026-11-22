import { smoothstep } from './rng';

/** The moving parts of an alien. Each is its own instanced mesh, turned about a pivot. */
export type PartName = 'legL' | 'legR' | 'torso' | 'head' | 'face' | 'mouth' | 'armL' | 'armR';

export interface PartDef {
  name: PartName;
  /** The part this one hangs off (it moves with it), or null for the root. */
  parent: PartName | null;
  /** Where the part turns, in model space at rest (y up, faces +z), metres. */
  pivot: [number, number, number];
}

/** Parents come before their children, so a pose can be built in one pass down this list. */
export const PARTS: readonly PartDef[] = [
  { name: 'legL', parent: null, pivot: [-0.1, 0.72, 0] },
  { name: 'legR', parent: null, pivot: [0.1, 0.72, 0] },
  { name: 'torso', parent: null, pivot: [0, 0.72, 0] },
  { name: 'head', parent: 'torso', pivot: [0, 1.17, 0] },
  { name: 'face', parent: 'head', pivot: [0, 1.17, 0] },
  { name: 'mouth', parent: 'head', pivot: [0, 1.29, 0.15] },
  { name: 'armL', parent: 'torso', pivot: [-0.19, 1.12, 0] },
  { name: 'armR', parent: 'torso', pivot: [0.19, 1.12, 0] },
];

/** Seconds to ease between walking and talking, so nobody stops or starts with a jolt. */
export const RAMP = 0.5;
/** Seconds a quarter turn to face a partner takes. */
export const TURN_TIME = 1.2;
/** Metres for one full walking cycle (both legs). */
export const STRIDE_LENGTH = 1.5;

/** How an alien splits its time: walk for `walkSpan` seconds, stop and talk for `talkSpan`, repeat. */
export interface AlienCycle {
  walkSpan: number;
  talkSpan: number;
  /** Shifts this alien along its own cycle so a crowd is not in step. */
  cycleOffset: number;
}

export interface Activity {
  /** 0 standing still, 1 walking at full pace. */
  walk: number;
  /** 0 not talking, 1 talking. */
  talk: number;
  /** 0 facing the way it walks, 1 turned to face its talking partner. Eases over longer than `talk`, since a quarter turn needs it. */
  face: number;
  /** Seconds spent walking so far, counting the ease-in and ease-out. Multiply by speed for metres. */
  walked: number;
}

/** Integral of the walking pace over `tau` seconds into a cycle (ramps up, holds, ramps down, then stands). */
function walkedWithin(walkSpan: number, r: number, tau: number): number {
  const up = (u: number) => r * (u ** 3 - u ** 4 / 2);
  if (tau < r) return up(tau / r);
  if (tau < walkSpan - r) return r / 2 + (tau - r);
  if (tau < walkSpan) {
    const v = (tau - (walkSpan - r)) / r;
    return r / 2 + (walkSpan - 2 * r) + r * (v - (v ** 3 - v ** 4 / 2));
  }
  return walkSpan - r;
}

/** What an alien is doing `time` seconds in. Pure: the same time gives the same answer. */
export function alienActivity(c: AlienCycle, time: number): Activity {
  const { walkSpan, talkSpan } = c;
  const cycle = walkSpan + talkSpan;
  const r = Math.min(RAMP, walkSpan / 2, talkSpan / 2);
  const t0 = time + c.cycleOffset;
  const k = Math.floor(t0 / cycle);
  const tau = t0 - k * cycle;
  const walk = tau < r ? smoothstep(0, r, tau) : tau < walkSpan - r ? 1 : tau < walkSpan ? 1 - smoothstep(walkSpan - r, walkSpan, tau) : 0;
  const talk = smoothstep(walkSpan, walkSpan + r, tau) * (1 - smoothstep(cycle - r, cycle, tau));
  // Starts turning as it slows to a stop, and is facing forward again before it sets off.
  const face = smoothstep(walkSpan - r, walkSpan + TURN_TIME, tau) * (1 - smoothstep(cycle - TURN_TIME, cycle, tau));
  return { walk, talk, face, walked: k * (walkSpan - r) + walkedWithin(walkSpan, r, tau) };
}

/** One part's turn about its pivot (radians) and its stretch up its own height. */
export interface PartPose {
  rx: number;
  ry: number;
  rz: number;
  sy: number;
}

export type Rig = Record<PartName, PartPose>;

export interface RigInput {
  walk: number;
  talk: number;
  /** Walking-cycle phase in radians. */
  stride: number;
  /** 0 listening to a partner, 1 speaking. Default 1 (a loner always speaks). */
  speak?: number;
  /** In a talking pair: the body already faces the partner, so the head looks around less and listens between turns. */
  paired?: boolean;
}

const still = (): PartPose => ({ rx: 0, ry: 0, rz: 0, sy: 1 });

/** Every part's pose for one alien: walking swing blended with talking gestures. `voice` (any number) keeps neighbours out of step. */
export function alienRig(input: RigInput, time: number, voice: number): Rig {
  const { walk: w, talk: k, stride } = input;
  const speak = input.speak ?? 1;
  const paired = input.paired ?? false;
  const s = Math.sin(stride);
  const c = Math.cos(stride);
  const rig: Rig = { legL: still(), legR: still(), torso: still(), head: still(), face: still(), mouth: still(), armL: still(), armR: still() };

  // Walking: legs swing against each other, each arm against the leg on its side, the body twists and bobs a little.
  rig.legL.rx = 0.6 * w * s;
  rig.legR.rx = -0.6 * w * s;
  rig.armL.rx = -0.45 * w * s;
  rig.armR.rx = 0.45 * w * s;
  rig.torso.ry = 0.1 * w * s;
  rig.torso.rz = 0.04 * w * c;
  rig.head.ry = -0.6 * rig.torso.ry;
  rig.head.rx = 0.03 * w * Math.sin(2 * stride);

  // Talking: speech comes in phrases (slow wave) made of syllables (fast wave); the mouth, a nod and a free arm follow it.
  const phrase = smoothstep(0.1, 0.5, 0.5 + 0.5 * Math.sin(time * 1.7 + voice * 2));
  const syllable = 0.5 + 0.5 * Math.sin(time * 9 + voice * 5);
  // A listener keeps its mouth shut, nods now and then and only lifts its arm a little; a speaker does the full routine.
  const speech = phrase * syllable * k * speak;
  const gesture = 0.25 + 0.75 * speak;
  rig.mouth.sy = 1 + 5 * speech;
  rig.head.ry += (paired ? 0.1 : 0.35) * k * Math.sin(time * 0.8 + voice);
  rig.head.rx += 0.07 * speech + (paired ? 0.06 * k * (1 - speak) * Math.sin(time * 2.2 + voice) : 0);
  rig.torso.rz += 0.03 * k * Math.sin(time * 1.3 + voice);
  rig.armR.rx += k * (-1.0 * gesture + 0.35 * phrase * speak * Math.sin(time * 4.1 + voice));
  rig.armR.rz += k * 0.3 * gesture;
  rig.armL.rx += k * (-0.25 + 0.1 * Math.sin(time * 2.3 + voice));
  rig.armL.rz += k * -0.12;
  return rig;
}
