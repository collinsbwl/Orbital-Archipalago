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
export const GROUND_LIMITS = { minDistance: 3, maxDistance: 100, maxPolarAngle: Math.PI / 2 - 0.005 };
/** The orbit target stays between these heights above the surface under it (so panning cannot sink it into the ground or fly it off). */
export const TARGET_LIMITS = { min: 0.2, max: 30 };
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

/** A height field that may also know about water on top of the ground (the terrain does). */
export type SurfaceField = HeightField & { waterDepthAt?: (x: number, z: number) => number };

/** The height of what you would touch at a point: the ground, or the water's surface over a lake or river. */
export function surfaceHeight(field: SurfaceField, x: number, z: number): number {
  return field.heightAt(x, z) + (field.waterDepthAt?.(x, z) ?? 0);
}

/** Keeps the camera at least `margin` above the surface under it: the ground, or the water over a lake. */
export function clampAboveTerrain(field: SurfaceField, x: number, y: number, z: number, margin = MIN_CAMERA_HEIGHT): number {
  return aboveGround({ heightAt: (px, pz) => surfaceHeight(field, px, pz) }, x, z, y, margin);
}

/** Keeps an orbit target's height within TARGET_LIMITS of the surface at its spot. */
export function clampTargetY(field: SurfaceField, x: number, y: number, z: number): number {
  const s = surfaceHeight(field, x, z);
  return Math.min(s + TARGET_LIMITS.max, Math.max(s + TARGET_LIMITS.min, y));
}

/** The angle from straight up to the line from the target to the camera (0 = looking straight down, PI/2 = level). OrbitControls caps this. */
export function polarAngle(pose: Pose): number {
  const dx = pose.position[0] - pose.target[0];
  const dy = pose.position[1] - pose.target[1];
  const dz = pose.position[2] - pose.target[2];
  return Math.acos(dy / (Math.hypot(dx, dy, dz) || 1));
}

/**
 * Where you land: standing at eye height at the far end of a road, looking along it to the plaza. Which road comes from
 * the layout's first road, so it is the same each visit. The target is aimed at the plaza, but never so high that the
 * view is flatter than the polar cap allows (the controls would lift the camera into the air to fix it).
 */
export function landingPose(layout: CityLayout, field: HeightField, eye = EYE_HEIGHT, maxPolar = GROUND_LIMITS.maxPolarAngle): Pose {
  const road = layout.roads[0]!;
  const back = road.length - 2;
  const x = road.dir[0] * back;
  const z = road.dir[1] * back;
  const y = field.heightAt(x, z) + eye;
  const flat = Math.hypot(x, z);
  // The lowest the target may be, so the polar angle sits a hair inside the cap: height difference = distance * cos(angle).
  const polar = maxPolar - 0.002;
  const targetY = Math.min(field.heightAt(0, 0) + TARGET_HEIGHT, y - (flat / Math.tan(polar)));
  return { position: [x, y, z], target: [0, targetY, 0] };
}

/** Pulls a pan target back inside the city (plus a small margin). Returns the same numbers if it is already inside. */
export function clampPanTarget(x: number, z: number, cityRadius: number, margin = PAN_MARGIN): { x: number; z: number } {
  const limit = cityRadius + margin;
  const d = Math.hypot(x, z);
  if (d <= limit) return { x, z };
  const k = limit / d;
  return { x: x * k, z: z * k };
}
