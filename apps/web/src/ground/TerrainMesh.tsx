import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { GroundLook } from './ground-look';
import { buildTerrainData } from './terrain';
import type { Terrain as TerrainFn } from './terrain';

/** The ground covers a square this wide, in metres. Fog hides its edge. */
export const TERRAIN_HALF = 500;
const SEGMENTS = 160;

/** The ground: one big flat-shaded mesh coloured by height and steepness. */
export function Terrain({ terrain, look }: { terrain: TerrainFn; look: GroundLook }) {
  const geometry = useMemo(() => {
    const data = buildTerrainData(terrain, look, { half: TERRAIN_HALF, segments: SEGMENTS });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }, [terrain, look]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors flatShading roughness={1} metalness={0} />
    </mesh>
  );
}
