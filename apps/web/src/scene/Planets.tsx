import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { PlanetSnapshot, Snapshot } from '@orbital/contracts';
import { orbitOf } from '../orbits';
import { SCALE } from './frame';
import type { FrameState } from './frame';
import { makeGlowTexture } from './glow';
import { HALO_OPACITY, PLANET_TINT, planetEmphasis } from './highlight';
import { planetDetails, planetTitle } from './labels';
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

interface PlanetProps {
  look: PlanetLook;
  data: PlanetSnapshot;
  frame: FrameRef;
  hovered: boolean;
  onHover: (id: string | null) => void;
  /** The planet the camera is zoomed in on, if any, and how to ask for a different one (null = back to the map). */
  focused: string | null;
  onFocus: (id: string | null) => void;
  /** The planet being spotlighted (the focused one, else the hovered one), if any. */
  highlight: string | null;
  /** False while the map is hidden (on the ground): no hover, click or label, so nothing is picked through the scene. */
  interactive: boolean;
}

/** Stands in for a mesh's raycast so it can never be picked (used while the map is hidden). */
const noRaycast = () => null;

function Planet({ look, data, frame, hovered, onHover, focused, onFocus, highlight, interactive }: PlanetProps) {
  const isFocused = focused === look.id;
  const emphasis = planetEmphasis(look.id, highlight);
  const dimmed = emphasis === 'dimmed';
  const open = hovered && focused === null; // hover details only on the map; the card covers a focused planet
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Mesh>(null);
  const surface = useRef<THREE.MeshStandardMaterial>(null);
  const halo = useRef<THREE.SpriteMaterial>(null);
  const glow = useMemo(makeGlowTexture, []);
  useEffect(() => () => glow.dispose(), [glow]);
  const goal = useRef({ tint: new THREE.Color(PLANET_TINT[emphasis]), halo: HALO_OPACITY[emphasis] });
  goal.current.tint.set(PLANET_TINT[emphasis]);
  goal.current.halo = HALO_OPACITY[emphasis];
  const geometry = useMemo(() => buildPlanetGeometry(look), [look]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    if (!(hovered && interactive && focused === null)) return;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered, interactive, focused]);

  useFrame((_, dt) => {
    const p = frame.current.planets[look.id];
    if (p && group.current) group.current.position.set(p.x, p.y, p.z);
    if (body.current && !isFocused) body.current.rotation.y += dt * look.spin; // hold still while you are looking at the city
    // Ease toward the spotlight look: planets that step back darken, the spotlighted one glows.
    surface.current?.color.lerp(goal.current.tint, 0.12);
    if (halo.current) halo.current.opacity += (goal.current.halo - halo.current.opacity) * 0.12;
  });

  return (
    <group ref={group}>
      <mesh
        ref={body}
        geometry={geometry}
        scale={look.radius}
        raycast={interactive ? THREE.Mesh.prototype.raycast : noRaycast}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(look.id);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => {
          if (isFocused || e.delta > 5) return; // a drag that happened to end on the planet is not a click
          e.stopPropagation();
          onFocus(look.id);
        }}
      >
        <meshStandardMaterial ref={surface} vertexColors flatShading roughness={0.95} metalness={0} />
      </mesh>
      {/* A soft glow around the spotlighted planet. It sits at the planet's center, so the planet hides its middle and only the rim shows. */}
      <sprite scale={[look.radius * 4.6, look.radius * 4.6, 1]}>
        <spriteMaterial ref={halo} map={glow} color="#9cc4ff" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      {/* The name is always shown; hovering the planet adds its currency and a quick read of its economy. */}
      {!isFocused && interactive && (
      <Html position={[0, look.radius + 0.1, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`planet-label${open ? ' open' : ''}${dimmed ? ' dim' : ''}`}>
          <div className="planet-label-name">
            <i style={{ background: look.palette[0] }} />
            {planetTitle(look.id)}
          </div>
          {open && planetDetails(data).map((line) => <div key={line} className="planet-label-detail">{line}</div>)}
          {open && <div className="planet-label-hint">Click to zoom in</div>}
        </div>
      </Html>
      )}
      {look.atmosphere && (
        <mesh scale={look.radius * 1.14}>
          <icosahedronGeometry args={[1, 2]} />
          <meshBasicMaterial color={look.atmosphere.color} transparent opacity={look.atmosphere.opacity} side={THREE.BackSide} depthWrite={false} blending={THREE.AdditiveBlending} />
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

/** Every planet, on its orbit, with its own look. */
export function Planets({ snapshot, frame, focused, onFocus, hovered, onHover, highlight, interactive = true }: {
  snapshot: Snapshot;
  frame: FrameRef;
  focused: string | null;
  onFocus: (id: string | null) => void;
  /** The planet under the mouse, and how to report a new one. */
  hovered: string | null;
  onHover: (id: string | null) => void;
  highlight: string | null;
  interactive?: boolean;
}) {
  return (
    <>
      {snapshot.planets.map((p, i) => (
        <group key={p.planet}>
          <OrbitRing radius={orbitOf(p.planet, i).radius * SCALE} />
          <Planet look={lookFor(p.planet)} data={p} frame={frame} hovered={hovered === p.planet} onHover={onHover} focused={focused} onFocus={onFocus} highlight={highlight} interactive={interactive} />
        </group>
      ))}
    </>
  );
}
