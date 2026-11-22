import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CityLayout } from './city-layout';
import { InstancedGroup } from './InstancedGroup';
import type { Placement } from './instancing';
import { treeGeometry, TREE_COLORS } from './shapes';
import type { HeightField } from './terrain';
import { scatterTrees } from './trees';
import type { TreeKind } from './trees';

/** Shade a base colour a little lighter or darker by `t` in 0..1. */
function shade(base: string, t: number): THREE.Color {
  return new THREE.Color(base).multiplyScalar(0.82 + t * 0.36);
}

function TreeGroup({ kind, items }: { kind: TreeKind; items: Placement[] }) {
  const geometry = useMemo(() => treeGeometry(kind), [kind]);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  return <InstancedGroup geometry={geometry} material={material} items={items} />;
}

/** Plants and rocks scattered over the land (never in the city, on roads or on steep ground), species by planet. */
export function Trees({ planet, terrain, layout }: { planet: string; terrain: HeightField & { slopeAt: (x: number, z: number) => number; siteClearance?: (x: number, z: number) => number }; layout: CityLayout }) {
  const groups = useMemo(() => {
    const by = new Map<TreeKind, Placement[]>();
    for (const t of scatterTrees(terrain, layout, { planet })) {
      const list = by.get(t.kind) ?? [];
      list.push({ x: t.x, y: t.y, z: t.z, rotY: t.rotY, scale: t.scale, color: shade(TREE_COLORS[t.kind], t.tint) });
      by.set(t.kind, list);
    }
    return [...by.entries()];
  }, [planet, terrain, layout]);
  return (
    <>
      {groups.map(([kind, items]) => (
        <TreeGroup key={kind} kind={kind} items={items} />
      ))}
    </>
  );
}
