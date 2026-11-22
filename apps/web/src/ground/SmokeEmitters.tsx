import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Emitter } from './industry';
import { setInstance } from './instancing';
import { LAYERS, MAX_PUFFS_PER_EMITTER, puffAt, windFor } from './smoke';
import type { PuffLayer } from './smoke';

/** Emitters beyond this many are left out (the planet has about a dozen). */
const MAX_EMITTERS = 40;
const mix = new THREE.Color();
/** Parsed colours by CSS string: a puff's colours come from a handful of layer strings, so parse each once, not per puff per frame. */
const parsed = new Map<string, THREE.Color>();
const colorOf = (css: string): THREE.Color => {
  let c = parsed.get(css);
  if (!c) parsed.set(css, (c = new THREE.Color(css)));
  return c;
};

/** Smoke drifting from chimneys and forge stacks, flame flicker from flare stacks. `density` (0 to 1) is the share of puffs shown. */
export function Smoke({ planet, emitters, density }: { planet: string; emitters: Emitter[]; density: number }) {
  const used = useMemo(() => emitters.slice(0, MAX_EMITTERS), [emitters]);
  const wind = useMemo(() => windFor(planet), [planet]);
  const capacity = Math.max(1, used.length * MAX_PUFFS_PER_EMITTER);

  const geometry = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  const smokeMat = useMemo(() => new THREE.MeshLambertMaterial({ flatShading: true, transparent: true, opacity: 0.62, depthWrite: false }), []);
  const fireMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), []);
  const smoke = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, smokeMat, capacity);
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }, [geometry, smokeMat, capacity]);
  const fire = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, fireMat, capacity);
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }, [geometry, fireMat, capacity]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => smokeMat.dispose(), [smokeMat]);
  useEffect(() => () => fireMat.dispose(), [fireMat]);
  useEffect(() => () => void smoke.dispose(), [smoke]);
  useEffect(() => () => void fire.dispose(), [fire]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    let ns = 0;
    let nf = 0;
    used.forEach((e, ei) => {
      for (const layer of LAYERS[e.kind] as PuffLayer[]) {
        const isFire = layer.kind === 'fire';
        const mesh = isFire ? fire : smoke;
        for (let k = 0; k < layer.count; k++) {
          const p = puffAt(e, ei, layer, k, t, wind, density);
          if (!p || p.radius <= 0.01) continue;
          mix.copy(colorOf(layer.color[0])).lerp(colorOf(layer.color[1]), p.age);
          setInstance(mesh, isFire ? nf++ : ns++, { x: p.x, y: p.y, z: p.z, rotY: k, scale: p.radius, color: mix });
        }
      }
    });
    smoke.count = ns;
    fire.count = nf;
    smoke.instanceMatrix.needsUpdate = true;
    fire.instanceMatrix.needsUpdate = true;
    if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
    if (fire.instanceColor) fire.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <primitive object={smoke} />
      <primitive object={fire} />
    </>
  );
}
