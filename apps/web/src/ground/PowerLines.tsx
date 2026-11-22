import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Pieces } from './PieceMeshes';
import { pylonPieces, wireSegments } from './power-line';
import type { Pylon } from './power-line';

/** Pylons along a road with sagging wires between them. */
export function PowerLines({ pylons }: { pylons: Pylon[] }) {
  const pieces = useMemo(() => pylonPieces(pylons), [pylons]);
  const wires = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(wireSegments(pylons), 3));
    const material = new THREE.LineBasicMaterial({ color: '#1c2026' });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    return lines;
  }, [pylons]);
  useEffect(
    () => () => {
      wires.geometry.dispose();
      (wires.material as THREE.Material).dispose();
    },
    [wires],
  );
  return (
    <>
      <Pieces pieces={pieces} />
      <primitive object={wires} />
    </>
  );
}
