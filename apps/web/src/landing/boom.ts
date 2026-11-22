/**
 * The landing island's entrance: it waits while the title forms, bursts toward the camera, then drops under gravity,
 * bounces a few times with a squash on each hit, and settles into a slow bob and turn. Pure state so it can be tested
 * without WebGL; `island-scene.ts` draws it.
 */

export const BOOM = {
  /** Seconds before the island appears (the title animates first). */
  delay: 1.25,
  /** Seconds the burst toward the camera takes. */
  launch: 0.5,
  gravity: 34,
  /** Fraction of the impact speed kept on each bounce. */
  restitution: 0.38,
  /** Below this bounce speed the island stops bouncing and settles. */
  settleSpeed: 1.2,
  /** Height the fall starts from, and the upward kick it starts with. */
  dropHeight: 4.2,
  dropKick: 1.5,
  /** Distance in front of the resting spot the fall starts from. */
  dropForward: 3.5,
  /** Scale the island overshoots to at the end of the burst. */
  overshoot: 1.45,
  /** Squash velocity per unit of impact speed (the first hit flattens the island by about 10%). */
  squashKick: 0.13,
  /** Largest dt one step integrates, so a stalled tab does not tunnel through the ground. */
  maxDt: 1 / 30,
} as const;

export type BoomPhase = 'wait' | 'launch' | 'fall' | 'idle';

export interface BoomState {
  phase: BoomPhase;
  t: number;
  x: number;
  y: number;
  z: number;
  vy: number;
  scale: number;
  rotY: number;
  /** Squash amount (positive = flattened) and its velocity, driven by a damped spring. */
  sq: number;
  sqV: number;
  /** Camera shake amplitude; decays after the first impact. */
  shake: number;
  bounces: number;
  landT: number;
}

export function initialBoom(reducedMotion = false): BoomState {
  return {
    phase: reducedMotion ? 'idle' : 'wait', t: 0, x: 0, y: 0, z: 0, vy: 0, scale: 1, rotY: -0.5,
    sq: 0, sqV: 0, shake: 0, bounces: 0, landT: 0,
  };
}

/** Advances the state by `dt` seconds in place. Returns the impact speed on the first landing, else null. */
export function stepBoom(s: BoomState, rawDt: number): number | null {
  const dt = Math.min(Math.max(rawDt, 0), BOOM.maxDt);
  s.t += dt;
  let impact: number | null = null;

  if (s.phase === 'wait' && s.t >= BOOM.delay) s.phase = 'launch';

  if (s.phase === 'launch') {
    const u = Math.min((s.t - BOOM.delay) / BOOM.launch, 1);
    const e = 1 - Math.pow(1 - u, 3);
    s.y = -3 + (BOOM.dropHeight + 3) * e;
    s.z = -70 + (70 + BOOM.dropForward) * e;
    s.scale = 0.2 + (BOOM.overshoot - 0.2) * e;
    s.rotY = -0.5 - (1 - e) * Math.PI * 3;
    if (u >= 1) {
      s.phase = 'fall';
      s.vy = BOOM.dropKick;
    }
  } else if (s.phase === 'fall') {
    s.vy -= BOOM.gravity * dt;
    s.y += s.vy * dt;
    s.z += (0 - s.z) * Math.min(1, dt * 7);
    s.scale += (1 - s.scale) * Math.min(1, dt * 6);
    if (s.y <= 0 && s.vy < 0) {
      const speed = -s.vy;
      s.y = 0;
      s.sqV += speed * BOOM.squashKick;
      if (s.bounces === 0) {
        s.shake = Math.min(0.45, speed * 0.022);
        impact = speed;
      }
      s.bounces++;
      s.vy = speed * BOOM.restitution;
      if (s.vy < BOOM.settleSpeed) {
        s.vy = 0;
        s.phase = 'idle';
        s.landT = s.t;
      }
    }
  } else if (s.phase === 'idle') {
    const since = s.t - s.landT;
    const k = Math.min(1, since / 1.5);
    s.scale += (1 - s.scale) * Math.min(1, dt * 6);
    s.z += (0 - s.z) * Math.min(1, dt * 7);
    s.y = Math.sin(since * 1.4) * 0.12 * k;
    s.rotY += dt * 0.22 * k;
  }

  // Squash spring: kicked on each impact, rings out on its own.
  s.sqV += (-120 * s.sq - 9 * s.sqV) * dt;
  s.sq += s.sqV * dt;
  s.shake *= Math.exp(-dt * 7);
  return impact;
}

/** The squash as x/y/z scale factors, clamped so a hard hit never inverts the mesh. */
export function squashScale(s: BoomState): [number, number, number] {
  const q = Math.max(-0.35, Math.min(0.35, s.sq));
  return [1 + q * 0.55, 1 - q, 1 + q * 0.55];
}
