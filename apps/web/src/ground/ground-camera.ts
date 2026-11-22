import type { CityLayout } from './city-layout';
import { aboveGround } from './terrain';
import type { HeightField } from './terrain';

/** The camera never goes lower than this above the ground, so it cannot sink into it. */
export const MIN_CAMERA_HEIGHT = 0.5;
/** Eye height of someone standing in the street, metres. */
export const EYE_HEIGHT = 1.7;
/** The orbit target may wander this far past the city edge when panning. */
export const PAN_MARGIN = 12;
/** Limits while walking around on the ground: zoom range and how far down you can look from above the plaza. */
export const GROUND_LIMITS = { minDistance: 3, maxDistance: 100, maxPolarAngle: Math.PI / 2 - 0.05 };
/** How high above the plaza the orbit target sits (roughly eye height, so the view centres on people). */
export const TARGET_HEIGHT = 1.5;

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
}

/** Lifts a camera height up to the minimum. */
export function clampCameraY(y: number): number {
  return y < MIN_CAMERA_HEIGHT ? MIN_CAMERA_HEIGHT : y;
}

/** Keeps the camera at least `margin` above the real ground under it. */
export function clampAboveTerrain(field: HeightField, x: number, y: number, z: number, margin = MIN_CAMERA_HEIGHT): number {
  return aboveGround(field, x, z, y, margin);
}

/**
 * Where you land: standing at eye height at the far end of a road, looking along it to the plaza. Which road comes from
 * the layout's first road, so it is the same each visit.
 */
export function landingPose(layout: CityLayout, field: HeightField, eye = EYE_HEIGHT): Pose {
  const road = layout.roads[0]!;
  const back = road.length - 2;
  const x = road.dir[0] * back;
  const z = road.dir[1] * back;
  return { position: [x, field.heightAt(x, z) + eye, z], target: [0, TARGET_HEIGHT, 0] };
}

/** Pulls a pan target back inside the city (plus a small margin). Returns the same numbers if it is already inside. */
export function clampPanTarget(x: number, z: number, cityRadius: number, margin = PAN_MARGIN): { x: number; z: number } {
  const limit = cityRadius + margin;
  const d = Math.hypot(x, z);
  if (d <= limit) return { x, z };
  const k = limit / d;
  return { x: x * k, z: z * k };
}
