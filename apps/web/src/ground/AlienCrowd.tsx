import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { alienRig, PARTS } from './alien-rig';
import type { PartName } from './alien-rig';
import { ALIEN_SUITS, alienCount, alienPose, alienSkin, makeAliens } from './aliens';
import type { CityLayout } from './city-layout';
import { alienPartGeometries } from './shapes';

// Scratch objects reused every frame so walking the crowd allocates nothing.
const rootM = new THREE.Matrix4();
const localM = new THREE.Matrix4();
const worldM = PARTS.map(() => new THREE.Matrix4());
/** Index in PARTS of each part's parent (-1 for the root), found once. */
const PARENT = PARTS.map((d) => PARTS.findIndex((o) => o.name === d.parent));
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const ZERO: [number, number, number] = [0, 0, 0];
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A fixed crowd of little aliens walking the layout's gathering loops, each stopping now and then to talk. Every moving part
 * (legs, arms, torso, head, eyes, mouth) is its own instanced mesh turned about a pivot. Skin colour follows the planet.
 */
export function Aliens({ planet, layout }: { planet: string; layout: CityLayout }) {
  const specs = useMemo(() => makeAliens(layout.gatherLoops, alienCount(), planet), [layout, planet]);
  const geometries = useMemo(() => alienPartGeometries(), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 }), []);
  const meshes = useMemo(() => {
    const out = {} as Record<PartName, THREE.InstancedMesh>;
    for (const def of PARTS) {
      const m = new THREE.InstancedMesh(geometries[def.name], material, Math.max(1, specs.length));
      m.frustumCulled = false;
      out[def.name] = m;
    }
    return out;
  }, [geometries, material, specs.length]);

  useEffect(() => () => Object.values(geometries).forEach((g) => g.dispose()), [geometries]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => Object.values(meshes).forEach((m) => m.dispose()), [meshes]);

  // Skin and suit colours never change, so set them once. The head takes the skin, the torso the suit; the rest keep their own colours.
  useLayoutEffect(() => {
    const c = new THREE.Color();
    specs.forEach((s, i) => {
      meshes.head.setColorAt(i, c.set(alienSkin(planet, s.tint)));
      meshes.torso.setColorAt(i, c.set(ALIEN_SUITS[Math.floor(s.suit * ALIEN_SUITS.length) % ALIEN_SUITS.length]!));
    });
    for (const m of [meshes.head, meshes.torso]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [meshes, specs, planet]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const shown = specs.length;
    for (let i = 0; i < shown; i++) {
      const s = specs[i]!;
      const p = alienPose(layout.gatherLoops, s, t);
      const rig = alienRig(p, t, s.voice);
      pos.set(p.x, p.bob, p.z);
      quat.setFromAxisAngle(UP, p.heading);
      scl.set(s.scale, s.scale, s.scale);
      rootM.compose(pos, quat, scl);
      PARTS.forEach((def, j) => {
        const pose = rig[def.name];
        const parent = PARENT[j]!;
        const from = parent >= 0 ? PARTS[parent]!.pivot : ZERO;
        pos.set(def.pivot[0] - from[0], def.pivot[1] - from[1], def.pivot[2] - from[2]);
        quat.setFromEuler(euler.set(pose.rx, pose.ry, pose.rz));
        scl.set(1, pose.sy, 1);
        localM.compose(pos, quat, scl);
        worldM[j]!.multiplyMatrices(parent >= 0 ? worldM[parent]! : rootM, localM);
        meshes[def.name].setMatrixAt(i, worldM[j]!);
      });
    }
    for (const m of Object.values(meshes)) {
      m.count = shown;
      m.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      {PARTS.map((def) => (
        <primitive key={def.name} object={meshes[def.name]} />
      ))}
    </group>
  );
}
