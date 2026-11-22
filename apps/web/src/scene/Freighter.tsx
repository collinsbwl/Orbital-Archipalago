import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

/** Points in an engine trail, and how far the ship must move before a new point is added (so the trail has the same length at any speed). */
export const TRAIL_POINTS = 22;
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
    colors.set([1 * f, 0.7 * f, 0.28 * f], i * 3);
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
}

/**
 * The freighter everyone shares: a cone hull, a wing slab, a glowing engine, an invisible hover target and the tooltip.
 * The trail is in world space, so it is drawn outside the moving group.
 */
export function FreighterModel({ groupRef, trail, id, scale = SHIP_SCALE, hovered, onHover, tooltip }: FreighterModelProps) {
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
        <mesh rotation-x={Math.PI / 2}>
          <coneGeometry args={[0.035, 0.17, 6]} />
          <meshStandardMaterial color="#e8eef8" flatShading roughness={0.6} />
        </mesh>
        <mesh position={[0, 0, -0.03]}>
          <boxGeometry args={[0.15, 0.008, 0.06]} />
          <meshStandardMaterial color="#8aa2c9" flatShading roughness={0.7} />
        </mesh>
        <mesh position={[0, 0, -ENGINE_OFFSET]}>
          <sphereGeometry args={[0.02, 8, 6]} />
          <meshBasicMaterial color="#ffb347" />
        </mesh>
        {/* An invisible, bigger target so a tiny ship is easy to point at. */}
        <mesh
          onPointerOver={(e) => {
            e.stopPropagation();
            onHover(id);
          }}
          onPointerOut={() => onHover(null)}
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
