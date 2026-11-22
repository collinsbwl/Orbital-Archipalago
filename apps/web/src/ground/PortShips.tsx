import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Shipment } from '@orbital/contracts';
import { shipTooltip } from '../scene/frame';
import type { FrameState } from '../scene/frame';
import { ENGINE_OFFSET, FreighterModel, TRAIL_JUMP, TRAIL_STEP, pushTrail, useTrail } from '../scene/Freighter';
import type { Port } from './port';
import { planPort, shipPhase, shipPose, shipsAt } from './port-traffic';
import type { PortShip } from './port-traffic';

type FrameRef = { current: FrameState };

/** The shared freighter model is 0.17 long; this scale makes it about 12 m, a size that reads against the city. */
export const GROUND_SHIP_SCALE = 70;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const nose = new THREE.Vector3();
const back = new THREE.Vector3();

interface ViewProps {
  ship: PortShip;
  planet: string;
  port: Port;
  frame: FrameRef;
  hovered: boolean;
  onHover: (id: string | null) => void;
}

/** One freighter at the port: lands, sits, or lifts off, following the smooth cycle. */
function PortShipView({ ship, planet, port, frame, hovered, onHover }: ViewProps) {
  const group = useRef<THREE.Group>(null);
  const trail = useTrail();

  // Stay hidden until the first frame has placed it, so it never flashes at the origin.
  useLayoutEffect(() => {
    if (group.current) group.current.visible = false;
    trail.line.visible = false;
  }, [trail]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const at = shipPhase(ship.shipment, planet, frame.current.cycle);
    if (!at) {
      g.visible = false;
      trail.line.visible = false;
      trail.seeded = false;
      return;
    }
    const pad = port.pads[ship.pad]!;
    const pose = shipPose(at, port.heading);
    g.visible = pose.fade > 0.02;
    g.position.set(pad.x + pose.x, pad.y + pose.y, pad.z + pose.z);
    g.quaternion.setFromUnitVectors(Z_AXIS, nose.set(...pose.nose));
    g.scale.setScalar(GROUND_SHIP_SCALE * Math.max(pose.fade, 0.001));
    if (pose.burning && g.visible) {
      trail.line.visible = true;
      back.copy(nose).multiplyScalar(-ENGINE_OFFSET * GROUND_SHIP_SCALE).add(g.position);
      pushTrail(trail, back, TRAIL_STEP * GROUND_SHIP_SCALE, TRAIL_JUMP * GROUND_SHIP_SCALE);
    } else {
      trail.line.visible = false;
      trail.seeded = false;
    }
  });

  return (
    <FreighterModel
      groupRef={group}
      trail={trail}
      id={ship.shipment.id}
      scale={GROUND_SHIP_SCALE}
      hovered={hovered}
      onHover={onHover}
      tooltip={hovered ? shipTooltip(ship.shipment, frame.current.cycle) : []}
    />
  );
}

/**
 * Freighters landing at, parked on and leaving the spaceport, from the snapshot's shipments and the same smooth cycle
 * the map uses. Hover one for its owner, cargo, route and arrival.
 */
export function PortShips({ planet, port, shipments, frame }: { planet: string; port: Port; shipments: Shipment[]; frame: FrameRef }) {
  // Which shipments touch this port, and their pads, are worked out once per snapshot; each frame only picks who is there now.
  const plan = useMemo(() => planPort(shipments, planet, port.pads.length), [shipments, planet, port.pads.length]);
  const planRef = useRef(plan);
  planRef.current = plan;
  const [active, setActive] = useState<PortShip[]>(() => shipsAt(plan, planet, frame.current.cycle));
  const key = useRef('');
  const [hovered, setHovered] = useState<string | null>(null);

  // Only touch React state when the set of ships (or their pads) changes, not every frame.
  useFrame(() => {
    const list = shipsAt(planRef.current, planet, frame.current.cycle);
    const k = list.map((s) => `${s.shipment.id}@${s.pad}`).join('|');
    if (k !== key.current) {
      key.current = k;
      setActive(list);
    }
  });

  return (
    <>
      {active.map((s) => (
        <PortShipView key={s.shipment.id} ship={s} planet={planet} port={port} frame={frame} hovered={hovered === s.shipment.id} onHover={setHovered} />
      ))}
    </>
  );
}
