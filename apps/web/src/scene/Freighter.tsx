import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

/** Points in an engine trail, and how far the ship must move before a new point is added (so the trail has the same length at any speed). */
export const TRAIL_POINTS = 30;
export const TRAIL_STEP = 0.03;
/** A ship that moves farther than this in one frame (a stalled tab catching up, or a correction) restarts its trail instead of drawing a long streak. */
export const TRAIL_JUMP = 0.35;
/** Ships are drawn this many times bigger than their model, so they read at map distance. */
export const SHIP_SCALE = 1.9;
/** How far behind the ship's center the engine (and so the trail) starts, in the model's own units. */
export const ENGINE_OFFSET = 0.095;

/** A short line of recent engine positions, fading out to the tail. */
export interface Trail {
  line: THREE.Line;
  positions: Float32Array;
  attribute: THREE.BufferAttribute;
  seeded: boolean;
  last: THREE.Vector3;
}

export function createTrail(): Trail {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(TRAIL_POINTS * 3);
  const attribute = new THREE.BufferAttribute(positions, 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  const colors = new Float32Array(TRAIL_POINTS * 3);
  for (let i = 0; i < TRAIL_POINTS; i++) {
    const f = (i / (TRAIL_POINTS - 1)) ** 2; // dark at the tail, bright at the engine
    colors.set([(0.35 + 0.65 * f) * f, (0.55 + 0.15 * f) * f, (1 - 0.72 * f) * f], i * 3); // blue-white at the tail, orange at the engine
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  return { line, positions, attribute, seeded: false, last: new THREE.Vector3() };
}

export function disposeTrail(trail: Trail): void {
  trail.line.geometry.dispose();
  (trail.line.material as THREE.Material).dispose();
}

/** Adds the engine's current position to the trail. `step` and `jump` default to the map's scale; pass bigger ones for a bigger ship. */
export function pushTrail(trail: Trail, back: THREE.Vector3, step = TRAIL_STEP, jump = TRAIL_JUMP): void {
  if (!trail.seeded || back.distanceTo(trail.last) > jump) {
    // Start (or restart) the trail folded up at the engine, so nothing streaks in from elsewhere.
    for (let i = 0; i < TRAIL_POINTS; i++) trail.positions.set([back.x, back.y, back.z], i * 3);
    trail.last.copy(back);
    trail.seeded = true;
  } else if (back.distanceTo(trail.last) >= step) {
    trail.positions.copyWithin(0, 3);
    trail.positions.set([back.x, back.y, back.z], (TRAIL_POINTS - 1) * 3);
    trail.last.copy(back);
  }
  trail.attribute.needsUpdate = true;
}

/** A trail that lives as long as the component, and is freed with it. */
export function useTrail(): Trail {
  const trail = useMemo(createTrail, []);
  useEffect(() => () => disposeTrail(trail), [trail]);
  return trail;
}

/** Stands in for a mesh's raycast so it can never be picked. */
const noRaycast = () => null;

interface FreighterModelProps {
  /** The caller moves and turns this group each frame. */
  groupRef: RefObject<THREE.Group>;
  trail: Trail;
  /** Shipment id, passed to `onHover`. */
  id: string;
  /** Model scale. The map uses `SHIP_SCALE`; the ground scene draws it much bigger. */
  scale?: number;
  hovered: boolean;
  onHover: (id: string | null) => void;
  /** Lines shown when hovered (see `shipTooltip`). */
  tooltip: string[];
  /** False while the ship's scene is hidden: the hover target is taken out of picking so it cannot swallow pointer events. */
  interactive?: boolean;
}

/**
 * The freighter everyone shares: a cone hull, a wing slab, a glowing engine, an invisible hover target and the tooltip.
 * The trail is in world space, so it is drawn outside the moving group.
 */
export function FreighterModel({ groupRef, trail, id, scale = SHIP_SCALE, hovered, onHover, tooltip, interactive = true }: FreighterModelProps) {
  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);

  return (
    <>
      <group ref={groupRef} scale={scale}>
        {/* Hull: a six-sided cone, with a dark glass canopy near the nose. */}
        <mesh rotation-x={Math.PI / 2}>
          <coneGeometry args={[0.035, 0.17, 6]} />
          <meshStandardMaterial color="#e8eef8" flatShading roughness={0.45} metalness={0.25} />
        </mesh>
        <mesh position={[0, 0.016, 0.03]} scale={[1, 0.6, 1.9]}>
          <sphereGeometry args={[0.018, 8, 6]} />
          <meshStandardMaterial color="#1c2b45" emissive="#3aa8ff" emissiveIntensity={0.7} flatShading roughness={0.2} />
        </mesh>
        {/* Swept-back wings, each with a glowing tip light (red to port, green to starboard). */}
        <mesh position={[0.055, 0, -0.03]} rotation-y={0.5}>
          <boxGeometry args={[0.08, 0.008, 0.05]} />
          <meshStandardMaterial color="#8aa2c9" flatShading roughness={0.5} metalness={0.2} />
        </mesh>
        <mesh position={[-0.055, 0, -0.03]} rotation-y={-0.5}>
          <boxGeometry args={[0.08, 0.008, 0.05]} />
          <meshStandardMaterial color="#8aa2c9" flatShading roughness={0.5} metalness={0.2} />
        </mesh>
        <mesh position={[0.09, 0, -0.05]}>
          <sphereGeometry args={[0.008, 6, 4]} />
          <meshBasicMaterial color="#5dff7a" />
        </mesh>
        <mesh position={[-0.09, 0, -0.05]}>
          <sphereGeometry args={[0.008, 6, 4]} />
          <meshBasicMaterial color="#ff4d4d" />
        </mesh>
        {/* A tail fin and two side thrusters. */}
        <mesh position={[0, 0.03, -0.065]}>
          <boxGeometry args={[0.006, 0.05, 0.05]} />
          <meshStandardMaterial color="#5f7fb0" flatShading roughness={0.5} />
        </mesh>
        {[-0.022, 0.022].map((x) => (
          <mesh key={x} position={[x, 0, -0.085]}>
            <sphereGeometry args={[0.011, 6, 5]} />
            <meshBasicMaterial color="#7fd4ff" />
          </mesh>
        ))}
        {/* The main engine: a hot core with a soft additive halo. */}
        <mesh position={[0, 0, -ENGINE_OFFSET]}>
          <sphereGeometry args={[0.02, 8, 6]} />
          <meshBasicMaterial color="#ffb347" />
        </mesh>
        <mesh position={[0, 0, -ENGINE_OFFSET - 0.005]}>
          <sphereGeometry args={[0.042, 10, 8]} />
          <meshBasicMaterial color="#ff8a2a" transparent opacity={0.25} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        {/* An invisible, bigger target so a tiny ship is easy to point at. */}
        <mesh
          raycast={interactive ? THREE.Mesh.prototype.raycast : noRaycast}
          onPointerOver={interactive ? (e) => {
            e.stopPropagation();
            onHover(id);
          } : undefined}
          onPointerOut={interactive ? () => onHover(null) : undefined}
        >
          <sphereGeometry args={[0.13, 8, 6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        {hovered && (
          <Html position={[0, 0.2, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
            <div className="ship-tip">
              {tooltip.map((line, i) => (
                <div key={i} className={i === 0 ? 'ship-tip-title' : undefined}>{line}</div>
              ))}
            </div>
          </Html>
        )}
      </group>
      <primitive object={trail.line} />
    </>
  );
}
