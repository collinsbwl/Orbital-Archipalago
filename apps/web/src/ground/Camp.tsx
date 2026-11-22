import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AtmosphereRef } from './atmosphere-ref';
import { CLEARING_TOP, clearingPieces, hutPieces, rackPieces, torchPieces, trailPieces } from './camp-layout';
import type { CityLayout } from './city-layout';
import { openCount } from './market';
import type { Stall } from './market';
import { Pieces } from './PieceMeshes';

/** Flame tongues: [x, z, height, lean phase]. */
const TONGUES: [number, number, number, number][] = [
  [0, 0, 1.5, 0],
  [0.25, 0.1, 1.0, 2.1],
  [-0.2, -0.15, 1.1, 4.2],
  [0.05, -0.3, 0.8, 5.3],
];

/** The campfire's flames and light: glowing cones that flicker, and a warm point light that is stronger after dark. */
function Fire({ atmo }: { atmo?: AtmosphereRef }) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const light = useRef<THREE.PointLight>(null);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffa43a', toneMapped: false }), []);
  const core = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffe08a', toneMapped: false }), []);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => core.dispose(), [core]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    TONGUES.forEach(([, , h, phase], i) => {
      const m = refs.current[i];
      if (!m) return;
      const f = 0.8 + 0.2 * Math.sin(t * 9 + phase) + 0.12 * Math.sin(t * 17 + phase * 1.7);
      m.scale.set(1 + 0.12 * Math.sin(t * 7 + phase), f, 1 + 0.12 * Math.cos(t * 8 + phase));
      m.rotation.z = 0.12 * Math.sin(t * 5 + phase);
      m.position.y = CLEARING_TOP + 0.3 + (h * f) / 2;
    });
    if (light.current) {
      const night = atmo?.current.atmosphere.lamps ?? 0;
      light.current.intensity = (60 + 140 * night) * (0.9 + 0.1 * Math.sin(t * 11) + 0.06 * Math.sin(t * 23));
    }
  });
  return (
    <group>
      {TONGUES.map(([x, z, h], i) => (
        <mesh key={i} ref={(m) => void (refs.current[i] = m)} position={[x, CLEARING_TOP + 0.3 + h / 2, z]} material={i === 0 ? core : material}>
          <coneGeometry args={[i === 0 ? 0.32 : 0.26, h, 6]} />
        </mesh>
      ))}
      <pointLight ref={light} position={[0, CLEARING_TOP + 1.3, 0]} color="#ff9a40" distance={55} decay={2} intensity={80} />
    </group>
  );
}

/**
 * A primitive camp in place of the city: a campfire in a packed-earth clearing with log seats, hide tents and mud huts,
 * dirt trails with torches, and drying racks round the edge. `share` (0 to 1) is how many racks have hides hung out.
 */
export function Camp({ layout, planet, stalls, share, atmo }: { layout: CityLayout; planet: string; stalls: Stall[]; share: number; atmo?: AtmosphereRef }) {
  const ground = useMemo(() => [...clearingPieces(layout, planet), ...trailPieces(layout, planet)], [layout, planet]);
  const huts = useMemo(() => hutPieces(layout, planet), [layout, planet]);
  const torches = useMemo(() => torchPieces(layout), [layout]);
  const open = openCount(stalls.length, share);
  const racks = useMemo(() => stalls.flatMap((s) => rackPieces(s, s.openRank < open, planet)), [stalls, open, planet]);
  return (
    <group>
      <Pieces pieces={ground} />
      <Pieces pieces={huts} atmo={atmo} />
      <Pieces pieces={racks} />
      <Pieces pieces={torches} atmo={atmo} />
      <Fire atmo={atmo} />
    </group>
  );
}
