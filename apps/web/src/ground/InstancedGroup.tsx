import { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { applyPlacements } from './instancing';
import type { Placement } from './instancing';

/**
 * One InstancedMesh drawn from a list of placements. Pass a stable `items` array; the mesh is rebuilt only when the
 * list's length changes, and refilled when the list itself changes. Geometry and material belong to the caller.
 */
export function InstancedGroup({ geometry, material, items }: { geometry: THREE.BufferGeometry; material: THREE.Material; items: Placement[] }) {
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(1, items.length));
    m.frustumCulled = false; // instances can be spread wider than one model's bounds
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, material, items.length]);
  useLayoutEffect(() => {
    applyPlacements(mesh, items);
  }, [mesh, items]);
  useEffect(() => () => void mesh.dispose(), [mesh]);
  return <primitive object={mesh} />;
}
