import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Snapshot } from '@orbital/contracts';
import { lanePoints } from './curve';
import type { FrameState } from './frame';
import { LANE_STYLE, routeEmphasis } from './highlight';

type FrameRef = { current: FrameState };
const SEGMENTS = 40;

/** One faint arc between two planets. It is redrawn every frame, so it follows them as they orbit. */
function Lane({ from, to, frame, style }: { from: string; to: string; frame: FrameRef; style: { opacity: number; color: string } }) {
  const goal = useRef({ opacity: style.opacity, color: new THREE.Color(style.color) });
  goal.current.opacity = style.opacity;
  goal.current.color.set(style.color);
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
    const material = line.material as THREE.LineBasicMaterial;
    // Ease to the new look when the spotlight changes: lanes that touch the spotlighted planet turn gold, the rest fade.
    material.opacity += (goal.current.opacity - material.opacity) * 0.15;
    material.color.lerp(goal.current.color, 0.15);
    const a = frame.current.planets[from];
    const b = frame.current.planets[to];
    if (!a || !b) return;
    lanePoints(a, b, SEGMENTS).forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
    attr.needsUpdate = true;
  });
  return <primitive object={line} />;
}

/** A faint permanent lane between every pair of planets, so the map reads as a network. The lanes that touch the spotlighted planet turn gold and the rest fade. */
export function Lanes({ snapshot, frame, highlight }: { snapshot: Snapshot; frame: FrameRef; highlight: string | null }) {
  const ids = snapshot.planets.map((p) => p.planet);
  const key = ids.join('|');
  const pairs = useMemo(() => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {pairs.map(([a, b]) => {
        const style = LANE_STYLE[routeEmphasis({ from: a, to: b }, highlight)];
        return <Lane key={`${a}|${b}`} from={a} to={b} frame={frame} style={style} />;
      })}
    </>
  );
}
