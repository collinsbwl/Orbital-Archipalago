import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Shipment, Snapshot } from '@orbital/contracts';
import { pointOnLane, tangentOnLane } from './curve';
import { shipProgress, shipTooltip } from './frame';
import type { FrameState } from './frame';
import { ENGINE_OFFSET, FreighterModel, pushTrail, SHIP_SCALE, useTrail } from './Freighter';

type FrameRef = { current: FrameState };

interface FreighterProps {
  shipment: Shipment;
  frame: FrameRef;
  hovered: boolean;
  onHover: (id: string | null) => void;
}

const aim = new THREE.Vector3();
const back = new THREE.Vector3();

/** A small freighter riding its lane, with an engine trail. Hover it for owner, cargo, route and arrival. */
function Freighter({ shipment, frame, hovered, onHover }: FreighterProps) {
  const group = useRef<THREE.Group>(null);
  const trail = useTrail();

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
    pushTrail(trail, back);
  });

  return (
    <FreighterModel
      groupRef={group}
      trail={trail}
      id={shipment.id}
      hovered={hovered}
      onHover={onHover}
      tooltip={hovered ? shipTooltip(shipment, frame.current.cycle) : []}
    />
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
