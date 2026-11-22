import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Snapshot } from '@orbital/contracts';
import { orbitOf } from '../orbits';
import { SCALE } from './frame';
import type { FrameState } from './frame';
import { buildPlanetGeometry, lookFor } from './planet-look';
import type { PlanetLook } from './planet-look';

type FrameRef = { current: FrameState };

/** A faint circle showing the planet's path around the sun. */
function OrbitRing({ radius }: { radius: number }) {
  const ring = useMemo(() => {
    const points = Array.from({ length: 160 }, (_, k) => {
      const a = (k / 160) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    });
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: '#7b8bc4', transparent: true, opacity: 0.2, depthWrite: false }),
    );
    line.frustumCulled = false;
    return line;
  }, [radius]);
  useEffect(
    () => () => {
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    },
    [ring],
  );
  return <primitive object={ring} />;
}

/** A press that moved more than this many pixels was a drag of the camera, not a click on the planet. */
const CLICK_SLOP_PX = 4;
/** The invisible click target is this much bigger than the planet, so small planets are easy to hit. */
const HIT_SCALE = 1.25;

function Planet({ look, frame, onSelect }: { look: PlanetLook; frame: FrameRef; onSelect?: (planetId: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => buildPlanetGeometry(look), [look]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((_, dt) => {
    const p = frame.current.planets[look.id];
    if (p && group.current) group.current.position.set(p.x, p.y, p.z);
    if (body.current) body.current.rotation.y += dt * look.spin;
  });

  // With no handler (the map is hidden), pointer-out never arrives, so drop the hover ourselves.
  useEffect(() => {
    if (!onSelect) setHovered(false);
  }, [onSelect]);

  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);

  return (
    <group ref={group}>
      <mesh ref={body} geometry={geometry} scale={look.radius}>
        <meshStandardMaterial vertexColors flatShading roughness={0.95} metalness={0} />
      </mesh>
      {/* An invisible, slightly bigger target: hover for the pointer cursor, click (not drag) to pick the planet. */}
      <mesh
        scale={look.radius * HIT_SCALE}
        onPointerOver={onSelect && ((e) => {
          e.stopPropagation();
          setHovered(true);
        })}
        onPointerOut={onSelect && (() => setHovered(false))}
        onClick={onSelect && ((e) => {
          if (e.delta > CLICK_SLOP_PX) return;
          e.stopPropagation();
          onSelect(look.id);
        })}
      >
        <sphereGeometry args={[1, 16, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {look.atmosphere && (
        <mesh scale={look.radius * 1.14}>
          <icosahedronGeometry args={[1, 2]} />
          <meshBasicMaterial color={look.atmosphere.color} transparent opacity={look.atmosphere.opacity} side={THREE.BackSide} depthWrite={false} />
        </mesh>
      )}
      {look.ring && (
        <mesh rotation={[Math.PI / 2 + look.ring.tilt, 0, 0]}>
          <ringGeometry args={[look.radius * look.ring.inner, look.radius * look.ring.outer, 48]} />
          <meshBasicMaterial color={look.ring.color} side={THREE.DoubleSide} transparent opacity={0.4} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

/** Every planet, on its orbit, with its own look. Clicking one calls `onSelect` with its id. */
export function Planets({ snapshot, frame, onSelect }: { snapshot: Snapshot; frame: FrameRef; onSelect?: (planetId: string) => void }) {
  return (
    <>
      {snapshot.planets.map((p, i) => (
        <group key={p.planet}>
          <OrbitRing radius={orbitOf(p.planet, i).radius * SCALE} />
          <Planet look={lookFor(p.planet)} frame={frame} onSelect={onSelect} />
        </group>
      ))}
    </>
  );
}
