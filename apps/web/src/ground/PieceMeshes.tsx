import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AtmosphereRef } from './atmosphere-ref';
import { InstancedGroup } from './InstancedGroup';
import type { Placement } from './instancing';
import type { Piece, PieceShape } from './industry';
import { groundedBox, groundedCone, groundedCylinder, groundedDome } from './shapes';

const GEOMETRY: Record<PieceShape, () => THREE.BufferGeometry> = {
  box: groundedBox,
  cyl: () => groundedCylinder(10),
  cone: () => groundedCone(8),
  dome: groundedDome,
};

/** How bright lamps are by day, as a share of their night brightness. */
const LAMP_DAY = 0.22;

/** The instance placement for a piece. Domes are half a unit sphere (0.5 tall), so their height scales by two. */
function placementOf(p: Piece): Placement {
  const [w, h, d] = p.size;
  return { x: p.x, y: p.y, z: p.z, rotY: p.rotY, pitch: p.pitch, scale: [w, p.shape === 'dome' ? h * 2 : h, d], color: p.color };
}

/** All pieces of one shape and lighting (solid, glowing, or a lamp that follows the time of day) as one instanced mesh. */
function PieceGroup({ shape, glow, lamp, pieces, atmo }: { shape: PieceShape; glow: boolean; lamp: boolean; pieces: Piece[]; atmo?: AtmosphereRef }) {
  const geometry = useMemo(() => GEOMETRY[shape](), [shape]);
  const material = useMemo(
    () => (glow ? new THREE.MeshBasicMaterial({ toneMapped: false }) : new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, metalness: 0.05 })),
    [glow],
  );
  const items = useMemo(() => pieces.map(placementOf), [pieces]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  // Lamps: the material colour multiplies each instance's colour, so grey dims them by day and white shows them at night.
  useFrame(() => {
    if (!lamp || !atmo) return;
    (material as THREE.MeshBasicMaterial).color.setScalar(LAMP_DAY + (1 - LAMP_DAY) * atmo.current.atmosphere.lamps);
  });
  return <InstancedGroup geometry={geometry} material={material} items={items} />;
}

type Group = { shape: PieceShape; glow: boolean; lamp: boolean; pieces: Piece[] };

/** Splits pieces by shape and lighting (one draw call each). */
export function groupPieces(pieces: Piece[]): [string, Group][] {
  const by = new Map<string, Group>();
  for (const p of pieces) {
    const lamp = !!p.glow && !!p.lamp;
    const key = `${p.shape}:${p.glow ? 1 : 0}:${lamp ? 1 : 0}`;
    const g = by.get(key) ?? { shape: p.shape, glow: !!p.glow, lamp, pieces: [] };
    g.pieces.push(p);
    by.set(key, g);
  }
  return [...by.entries()];
}

/** A list of solid pieces drawn as instanced meshes. Pass a stable `pieces` array, and `atmo` if any of them are lamps. */
export function Pieces({ pieces, atmo }: { pieces: Piece[]; atmo?: AtmosphereRef }) {
  const groups = useMemo(() => groupPieces(pieces), [pieces]);
  return (
    <>
      {groups.map(([key, g]) => (
        <PieceGroup key={key} shape={g.shape} glow={g.glow} lamp={g.lamp} pieces={g.pieces} atmo={atmo} />
      ))}
    </>
  );
}
