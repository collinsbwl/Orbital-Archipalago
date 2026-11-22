import type { V3 } from './curve';

/** Where the map camera was: its position and what it was looking at. */
export interface MapPose {
  position: V3;
  target: V3;
}

/** Remembers the map camera from before a planet was clicked, so Back can put it exactly there. */
export interface PoseMemory {
  saved: MapPose | null;
}

export const createPoseMemory = (): PoseMemory => ({ saved: null });

/** Keeps the first pose it is given and ignores later ones (clicking a second planet must not overwrite the real map view). Copies the numbers. */
export function remember(memory: PoseMemory, position: V3, target: V3): void {
  if (memory.saved) return;
  memory.saved = { position: { x: position.x, y: position.y, z: position.z }, target: { x: target.x, y: target.y, z: target.z } };
}

/** The remembered pose, or `fallback` if nothing was saved. */
export const recall = (memory: PoseMemory, fallback: MapPose): MapPose => memory.saved ?? fallback;

/** Drops the remembered pose (the camera is back on the map). */
export function forget(memory: PoseMemory): void {
  memory.saved = null;
}
