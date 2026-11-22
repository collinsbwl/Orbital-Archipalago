import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { InstancedGroup } from './InstancedGroup';
import type { Placement } from './instancing';
import { buildIndustry } from './industry';
import type { Piece, PieceShape } from './industry';
import { groundedBox, groundedCone, groundedCylinder, groundedDome } from './shapes';
import type { Terrain } from './terrain';

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

/** Mine headframes and conveyors, refineries, farmsteads, pump stations and forges, standing on the terrain's sites. */
export function Industry({ terrain }: { terrain: Terrain }) {
  const groups = useMemo(() => {
    const models = buildIndustry(terrain.sites, terrain.features.pits, terrain);
    const by = new Map<string, { shape: PieceShape; glow: boolean; pieces: Piece[] }>();
    for (const m of models) {
      for (const p of m.pieces) {
        const key = `${p.shape}:${p.glow ? 1 : 0}`;
        const g = by.get(key) ?? { shape: p.shape, glow: !!p.glow, pieces: [] };
        g.pieces.push(p);
        by.set(key, g);
      }
    }
    return [...by.entries()];
  }, [terrain]);
  return (
    <>
      {groups.map(([key, g]) => (
        <PieceGroup key={key} shape={g.shape} glow={g.glow} pieces={g.pieces} />
      ))}
    </>
  );
}
