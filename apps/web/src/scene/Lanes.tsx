import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Snapshot } from '@orbital/contracts';
import { lanePoints } from './curve';
import type { FrameState } from './frame';

type FrameRef = { current: FrameState };
const SEGMENTS = 40;

/** One faint arc between two planets. It is redrawn every frame, so it follows them as they orbit. */
function Lane({ from, to, frame }: { from: string; to: string; frame: FrameRef }) {
  const { line, attr } = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    const material = new THREE.LineBasicMaterial({ color: '#7fa2ff', transparent: true, opacity: 0.42, depthWrite: false });
    const l = new THREE.Line(geometry, material);
    l.frustumCulled = false;
    return { line: l, attr: attribute };
  }, []);
  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );

  useFrame(() => {
    const a = frame.current.planets[from];
    const b = frame.current.planets[to];
    if (!a || !b) return;
    lanePoints(a, b, SEGMENTS).forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
    attr.needsUpdate = true;
  });
  return <primitive object={line} />;
}

/** A faint permanent lane between every pair of planets, so the map reads as a network. */
export function Lanes({ snapshot, frame }: { snapshot: Snapshot; frame: FrameRef }) {
  const ids = snapshot.planets.map((p) => p.planet);
  const key = ids.join('|');
  const pairs = useMemo(() => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {pairs.map(([a, b]) => (
        <Lane key={`${a}|${b}`} from={a} to={b} frame={frame} />
      ))}
    </>
  );
}
