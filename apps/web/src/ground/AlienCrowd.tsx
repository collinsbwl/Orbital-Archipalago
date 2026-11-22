import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { alienCount, alienPose, makeAliens } from './aliens';
import type { CityLayout } from './city-layout';
import { setInstance } from './instancing';
import { alienGeometry } from './shapes';

/** Skin colours aliens pick from by their `tint`. */
const SKINS = ['#7fd09a', '#8fb8e8', '#d6a0e0', '#e8c87a', '#9fe0d6', '#e89a9a'];

/** Little aliens walking the sidewalks and plaza, drawn as one instanced mesh. Count grows with the log of the population. */
export function Aliens({ planet, layout, population }: { planet: string; layout: CityLayout; population?: number }) {
  const specs = useMemo(() => makeAliens(layout.loops, alienCount(population), planet), [layout, planet, population]);
  const geometry = useMemo(() => alienGeometry(), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 }), []);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(1, specs.length));
    m.frustumCulled = false;
    return m;
  }, [geometry, material, specs.length]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => void mesh.dispose(), [mesh]);

  // Each alien's skin colour never changes, so set it once.
  useLayoutEffect(() => {
    const c = new THREE.Color();
    specs.forEach((s, i) => mesh.setColorAt(i, c.set(SKINS[Math.floor(s.tint * SKINS.length) % SKINS.length]!)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [mesh, specs]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i]!;
      const p = alienPose(layout.loops, s, t);
      setInstance(mesh, i, { x: p.x, y: p.bob, z: p.z, rotY: p.heading, scale: s.scale });
    }
    mesh.count = specs.length;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <primitive object={mesh} />;
}
