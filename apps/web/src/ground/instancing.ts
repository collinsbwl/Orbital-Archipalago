import * as THREE from 'three';

/** Where and how big one instance is. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  rotY?: number;
  /** Tilt about the model's own sideways (x) axis, radians, applied before the turn about the vertical (a slope, a lying cylinder). */
  pitch?: number;
  /** Scale per axis, or one number for all three. */
  scale?: number | [number, number, number];
  /** Per-instance colour (multiplies the geometry's colours). */
  color?: THREE.ColorRepresentation;
}

const dummy = new THREE.Object3D();
const tmp = new THREE.Color();

/** Writes one instance's matrix (and colour, if given). */
export function setInstance(mesh: THREE.InstancedMesh, i: number, p: Placement): void {
  dummy.position.set(p.x, p.y, p.z);
  dummy.rotation.order = 'YXZ';
  dummy.rotation.set(p.pitch ?? 0, p.rotY ?? 0, 0);
  const s = p.scale ?? 1;
  if (typeof s === 'number') dummy.scale.set(s, s, s);
  else dummy.scale.set(s[0], s[1], s[2]);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
  if (p.color !== undefined) mesh.setColorAt(i, tmp.set(p.color));
}

/** Fills a whole instanced mesh from a list (up to its capacity) and sets how many to draw. */
export function applyPlacements(mesh: THREE.InstancedMesh, placements: Placement[]): void {
  const n = Math.min(placements.length, mesh.instanceMatrix.count);
  for (let i = 0; i < n; i++) setInstance(mesh, i, placements[i]!);
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
