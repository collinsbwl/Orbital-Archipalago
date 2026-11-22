import type { PrecipKind } from './ground-look';

/** How each kind of precipitation looks and moves (Phase 11). Pure data for the weather component. */
export interface PrecipSpec {
  count: number;
  /** Fall velocity, metres per second (x, y, z). */
  velocity: [number, number, number];
  /** Streak length for rain (0 draws dots). */
  streak: number;
  /** Point size for dots. */
  size: number;
  /** Sideways wobble, metres. */
  sway: number;
  color: [number, number, number];
  /** Peak opacity. */
  alpha: number;
}

export const PRECIP: Record<PrecipKind, PrecipSpec> = {
  rain: { count: 2600, velocity: [-3, -32, -1.5], streak: 1.3, size: 0, sway: 0, color: [0.72, 0.8, 0.92], alpha: 0.5 },
  dust: { count: 1800, velocity: [16, -0.6, 7], streak: 0, size: 2.6, sway: 0.5, color: [0.86, 0.6, 0.36], alpha: 0.45 },
  snow: { count: 2200, velocity: [-0.8, -2.6, 0.3], streak: 0, size: 1.6, sway: 0.9, color: [0.95, 0.98, 1], alpha: 0.85 },
};

/** Side of the box of precipitation that follows the camera, metres. */
export const PRECIP_BOX: [number, number, number] = [80, 45, 80];
