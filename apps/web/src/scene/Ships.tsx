import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Shipment, Snapshot } from '@orbital/contracts';
import { pointOnLane, tangentOnLane } from './curve';
import { shipProgress, shipTooltip } from './frame';
import type { FrameState } from './frame';

type FrameRef = { current: FrameState };

interface FreighterProps {
  shipment: Shipment;
  frame: FrameRef;
  hovered: boolean;
  onHover: (id: string | null) => void;
}

const aim = new THREE.Vector3();
const back = new THREE.Vector3();
/** Points in an engine trail, and how far the ship must move before a new point is added (so the trail has the same length at any speed). */
const TRAIL_POINTS = 22;
const TRAIL_STEP = 0.03;
/** A ship that moves farther than this in one frame (a stalled tab catching up, or a correction) restarts its trail instead of drawing a long straight streak. */
const TRAIL_JUMP = 0.35;
/** Ships are drawn this many times bigger than their model, so they read at map distance. */
const SHIP_SCALE = 1.9;
/** How far behind the ship's center the engine (and so the trail) starts, in the model's own units. */
const ENGINE_OFFSET = 0.095;

/** A small freighter riding its lane, with an engine trail. Hover it for owner, cargo, route and arrival. */
function Freighter({ shipment, frame, hovered, onHover }: FreighterProps) {
  const group = useRef<THREE.Group>(null);
  // The engine trail: a short line of recent engine positions, fading out to the tail.
  const trail = useMemo(() => {
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
  }, []);
  useEffect(
    () => () => {
      trail.line.geometry.dispose();
      (trail.line.material as THREE.Material).dispose();
    },
    [trail],
  );

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const a = frame.current.planets[shipment.from];
    const b = frame.current.planets[shipment.to];
    if (!a || !b) {
      g.visible = false;
      return;
    }
    const t = shipProgress(shipment, frame.current.cycle);
    const p = pointOnLane(a, b, t);
    const d = tangentOnLane(a, b, t);
    g.visible = true;
    g.position.set(p.x, p.y, p.z);
    g.lookAt(aim.set(p.x + d.x, p.y + d.y, p.z + d.z)); // the ship's nose (+z) points along the lane
    back.set(d.x, d.y, d.z).normalize().multiplyScalar(-ENGINE_OFFSET * SHIP_SCALE).add(g.position);
    if (!trail.seeded || back.distanceTo(trail.last) > TRAIL_JUMP) {
      // Start (or restart) the trail folded up at the engine, so nothing streaks in from elsewhere.
      for (let i = 0; i < TRAIL_POINTS; i++) trail.positions.set([back.x, back.y, back.z], i * 3);
      trail.last.copy(back);
      trail.seeded = true;
    } else if (back.distanceTo(trail.last) >= TRAIL_STEP) {
      trail.positions.copyWithin(0, 3);
      trail.positions.set([back.x, back.y, back.z], (TRAIL_POINTS - 1) * 3);
      trail.last.copy(back);
    }
    trail.attribute.needsUpdate = true;
  });

  useEffect(() => {
    if (!hovered) return;
    document.body.style.cursor = 'pointer';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hovered]);

  return (
    <>
      <group ref={group} scale={SHIP_SCALE}>
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
            onHover(shipment.id);
          }}
          onPointerOut={() => onHover(null)}
        >
          <sphereGeometry args={[0.13, 8, 6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        {hovered && (
          <Html position={[0, 0.2, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
            <div className="ship-tip">
              {shipTooltip(shipment, frame.current.cycle).map((line, i) => (
                <div key={i} className={i === 0 ? 'ship-tip-title' : undefined}>{line}</div>
              ))}
            </div>
          </Html>
        )}
      </group>
      {/* The trail is in world space, so it lives outside the moving group. */}
      <primitive object={trail.line} />
    </>
  );
}

/** Every shipment that is in flight. */
export function Ships({ snapshot, frame, hovered, onHover }: { snapshot: Snapshot; frame: FrameRef; hovered: string | null; onHover: (id: string | null) => void }) {
  return (
    <>
      {snapshot.shipments
        .filter((s) => s.status === 'in_flight')
        .map((s) => (
          <Freighter key={s.id} shipment={s} frame={frame} hovered={hovered === s.id} onHover={onHover} />
        ))}
    </>
  );
}
