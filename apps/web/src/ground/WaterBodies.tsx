import { useEffect, useLayoutEffect, useMemo } from 'react';
import { MeshReflectorMaterial } from '@react-three/drei';
import * as THREE from 'three';
import type { Lake } from './terrain-features';
import type { Terrain } from './terrain';
import { applyPlacements } from './instancing';
import type { Placement } from './instancing';
import { makeRng } from './rng';
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

/**
 * A crystal world's lake: still, dark, mirror-clear water that reflects the spires and the dawn sky, with broken slabs
 * of ice drifting on it. The reflector needs a flat mesh through its own origin facing +z, so the surface is moved to
 * the origin and turned onto its back, then the mesh turns it upright again at the lake's level.
 */
function MirrorLake({ lake, positions }: { lake: Lake; positions: Float32Array }) {
  const level = positions[1]!;
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.translate(0, -level, 0);
    g.rotateX(Math.PI / 2);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }, [positions, level]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const floeGeo = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 7).translate(0, 0.5, 0), []);
  useEffect(() => () => floeGeo.dispose(), [floeGeo]);
  const floes = useMemo<Placement[]>(() => {
    const rng = makeRng(lake.seed ^ 0x51ce);
    const out: Placement[] = [];
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * lake.radius * 0.85;
      const size = 1.2 + rng() * rng() * 5;
      out.push({ x: lake.x + Math.sin(a) * r, y: level - 0.15, z: lake.z + Math.cos(a) * r, rotY: rng() * 6.28, scale: [size * (0.7 + rng() * 0.6), 0.45, size], color: rng() < 0.5 ? '#eaf6fc' : '#cfe7f4' });
    }
    return out;
  }, [lake, level]);
  const floeMesh = useMemo(() => {
    const m = new THREE.InstancedMesh(floeGeo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.35 }), floes.length);
    return m;
  }, [floeGeo, floes.length]);
  useLayoutEffect(() => {
    applyPlacements(floeMesh, floes);
    floeMesh.computeBoundingSphere();
  }, [floeMesh, floes]);
  useEffect(() => () => {
    (floeMesh.material as THREE.Material).dispose();
    floeMesh.dispose();
  }, [floeMesh]);

  return (
    <>
      <mesh geometry={geometry} position={[0, level, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <MeshReflectorMaterial
          color="#5f86a6"
          roughness={0.08}
          metalness={0.2}
          mirror={0.85}
          mixStrength={2.2}
          blur={[120, 40]}
          mixBlur={0.6}
          resolution={512}
          depthScale={0}
        />
      </mesh>
      <primitive object={floeMesh} />
    </>
  );
}

/** The planet's lakes and rivers (frozen on ice worlds; mirror-still with drifting floes on a crystal world). */
export function WaterBodies({ terrain, mirror = false }: { terrain: Terrain; mirror?: boolean }) {
  const lakes = useMemo(() => terrain.lakes.map((l) => ({ id: l.id, frozen: l.frozen, positions: lakeSurface(l) })), [terrain]);
  const rivers = useMemo(() => terrain.rivers.map((r) => ({ id: r.id, positions: riverSurface(r) })), [terrain]);
  return (
    <>
      {lakes.map((l) =>
        mirror ? <MirrorLake key={l.id} lake={terrain.lakes.find((k) => k.id === l.id)!} positions={l.positions} /> : <Surface key={l.id} positions={l.positions} frozen={l.frozen} />,
      )}
      {rivers.map((r) => (
        <Surface key={r.id} positions={r.positions} frozen={terrain.features.icy} />
      ))}
    </>
  );
}
