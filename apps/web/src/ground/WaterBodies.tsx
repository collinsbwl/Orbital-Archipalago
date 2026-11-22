import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Terrain } from './terrain';
import { lakeSurface, riverSurface } from './water';

function useSurface(positions: Float32Array) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }, [positions]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return geometry;
}

/** One flat surface of water or ice. Water is a little see-through; ice is a solid pale slab. */
function Surface({ positions, frozen }: { positions: Float32Array; frozen: boolean }) {
  const geometry = useSurface(positions);
  return (
    <mesh geometry={geometry}>
      {frozen ? (
        <meshStandardMaterial color="#cfeaf6" flatShading roughness={0.25} metalness={0.05} />
      ) : (
        <meshStandardMaterial color="#3f8fc4" flatShading roughness={0.15} metalness={0.1} transparent opacity={0.82} />
      )}
    </mesh>
  );
}

/** The planet's lakes and rivers (frozen on ice worlds). */
export function WaterBodies({ terrain }: { terrain: Terrain }) {
  const lakes = useMemo(() => terrain.lakes.map((l) => ({ id: l.id, frozen: l.frozen, positions: lakeSurface(l) })), [terrain]);
  const rivers = useMemo(() => terrain.rivers.map((r) => ({ id: r.id, positions: riverSurface(r) })), [terrain]);
  return (
    <>
      {lakes.map((l) => (
        <Surface key={l.id} positions={l.positions} frozen={l.frozen} />
      ))}
      {rivers.map((r) => (
        <Surface key={r.id} positions={r.positions} frozen={terrain.features.icy} />
      ))}
    </>
  );
}
