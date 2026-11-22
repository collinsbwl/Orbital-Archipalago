import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyPlacements, setInstance } from './instancing';
import { alienGeometry, carGeometry, groundedBox, haulerGeometry, treeGeometry } from './shapes';
import type { TreeKind } from './trees';

describe('model geometry', () => {
  const kinds: TreeKind[] = ['broadleaf', 'conifer', 'scrub', 'rock', 'spire'];
  for (const kind of kinds) {
    it(`${kind} is coloured, small and stands on the ground`, () => {
      const g = treeGeometry(kind);
      g.computeBoundingBox();
      expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
      expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.05);
      expect(g.boundingBox!.max.y).toBeLessThan(8);
      expect(g.getAttribute('position').count).toBeLessThan(700);
    });
  }
  it('alien is about 2 m tall and cheap', () => {
    const g = alienGeometry();
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(g.boundingBox!.max.y).toBeGreaterThan(1.5);
    expect(g.boundingBox!.max.y).toBeLessThan(2.4);
    expect(g.getAttribute('position').count).toBeLessThan(600);
  });
  it('car and hauler are coloured, on the ground, nose along +z, with a sensible length', () => {
    for (const [g, long] of [[carGeometry(), 4.2], [haulerGeometry(), 6.3]] as const) {
      g.computeBoundingBox();
      expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
      expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.01);
      expect(g.boundingBox!.max.y).toBeLessThan(3);
      expect(g.boundingBox!.max.z - g.boundingBox!.min.z).toBeGreaterThan(long * 0.9);
      expect(g.boundingBox!.max.z - g.boundingBox!.min.z).toBeLessThan(long * 1.3);
      expect(g.getAttribute('position').count).toBeLessThan(600);
    }
  });
  it('grounded box sits on y = 0', () => {
    const g = groundedBox();
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0);
    expect(g.boundingBox!.max.y).toBeCloseTo(1);
  });
});

describe('instancing', () => {
  it('writes matrices and colours, capped at capacity', () => {
    const mesh = new THREE.InstancedMesh(groundedBox(), new THREE.MeshBasicMaterial(), 2);
    applyPlacements(mesh, [
      { x: 1, y: 2, z: 3, scale: [2, 3, 4], color: '#ff0000' },
      { x: 4, y: 5, z: 6, rotY: 1 },
      { x: 7, y: 8, z: 9 },
    ]);
    expect(mesh.count).toBe(2);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(0, m);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), scl);
    expect(pos.toArray()).toEqual([1, 2, 3]);
    expect(scl.toArray()).toEqual([2, 3, 4]);
    setInstance(mesh, 1, { x: 0, y: 0, z: 0, scale: 2 });
    mesh.getMatrixAt(1, m);
    m.decompose(pos, new THREE.Quaternion(), scl);
    expect(scl.x).toBe(2);
  });
});
