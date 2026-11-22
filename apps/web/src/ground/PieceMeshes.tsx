import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
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

/** The instance placement for a piece. Domes are half a unit sphere (0.5 tall), so their height scales by two. */
function placementOf(p: Piece): Placement {
  const [w, h, d] = p.size;
  return { x: p.x, y: p.y, z: p.z, rotY: p.rotY, pitch: p.pitch, scale: [w, p.shape === 'dome' ? h * 2 : h, d], color: p.color };
}

/** All pieces of one shape and lighting (lit or glowing) as one instanced mesh. */
function PieceGroup({ shape, glow, pieces }: { shape: PieceShape; glow: boolean; pieces: Piece[] }) {
  const geometry = useMemo(() => GEOMETRY[shape](), [shape]);
  const material = useMemo(
    () => (glow ? new THREE.MeshBasicMaterial({ toneMapped: false }) : new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, metalness: 0.05 })),
    [glow],
  );
  const items = useMemo(() => pieces.map(placementOf), [pieces]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <InstancedGroup geometry={geometry} material={material} items={items} />;
}

/** Splits pieces by shape and glow (one draw call each). */
export function groupPieces(pieces: Piece[]): [string, { shape: PieceShape; glow: boolean; pieces: Piece[] }][] {
  const by = new Map<string, { shape: PieceShape; glow: boolean; pieces: Piece[] }>();
  for (const p of pieces) {
    const key = `${p.shape}:${p.glow ? 1 : 0}`;
    const g = by.get(key) ?? { shape: p.shape, glow: !!p.glow, pieces: [] };
    g.pieces.push(p);
    by.set(key, g);
  }
  return [...by.entries()];
}

/** A list of solid pieces drawn as instanced meshes. Pass a stable `pieces` array. */
export function Pieces({ pieces }: { pieces: Piece[] }) {
  const groups = useMemo(() => groupPieces(pieces), [pieces]);
  return (
    <>
      {groups.map(([key, g]) => (
        <PieceGroup key={key} shape={g.shape} glow={g.glow} pieces={g.pieces} />
      ))}
    </>
  );
}
