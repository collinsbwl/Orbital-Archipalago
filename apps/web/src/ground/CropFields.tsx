import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { SimEvent } from '@orbital/contracts';
import type { FrameState } from '../scene/frame';
import { blightLevel, cropColor, cropGrowth, cropHeight, cropPlants } from './crops';
import { setInstance } from './instancing';
import { groundedCone } from './shapes';
import type { FieldPatch } from './terrain-features';

type FrameRef = { current: FrameState };
/** Plants are refreshed this often (seconds): growth is slow, so there is no need to touch every plant each frame. */
const REFRESH = 0.25;
const color = new THREE.Color();

/**
 * Crops on the terrain's fields. They grow with the smooth cycle from seedling to ripe, are cut at harvest and sown
 * again, and turn brown while a drought or blight event names the planet.
 */
export function Crops({ planet, fields, events, frame }: { planet: string; fields: FieldPatch[]; events: Pick<SimEvent, 'cycle' | 'kind' | 'planet' | 'text'>[]; frame: FrameRef }) {
  const plants = useMemo(() => cropPlants(fields), [fields]);
  const geometry = useMemo(() => groundedCone(5), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }), []);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(1, plants.length));
    m.frustumCulled = false;
    m.count = plants.length;
    return m;
  }, [geometry, material, plants.length]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => void mesh.dispose(), [mesh]);

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const since = useRef(Infinity);

  const refresh = () => {
    const cycle = frame.current.cycle;
    const blight = blightLevel(eventsRef.current, planet, cycle);
    for (let i = 0; i < plants.length; i++) {
      const p = plants[i]!;
      const g = cropGrowth(cycle, p.phase);
      const h = cropHeight(g, blight) * (0.9 + p.tint * 0.2);
      const [r, gr, b] = cropColor(g, blight, p.tint);
      setInstance(mesh, i, { x: p.x, y: p.y, z: p.z, rotY: p.rotY, scale: [0.9, h, 0.9], color: color.setRGB(r, gr, b) });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  // Show something sensible right away; `useFrame` keeps it current.
  useLayoutEffect(refresh, [mesh, plants]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    since.current += dt;
    if (since.current < REFRESH) return;
    since.current = 0;
    refresh();
  });

  if (plants.length === 0) return null;
  return <primitive object={mesh} />;
}
