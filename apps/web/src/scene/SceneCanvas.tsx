import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import type { Snapshot } from '@orbital/contracts';
import { CycleClock } from './clock';
import { planetPositions } from './frame';
import type { FrameState } from './frame';
import { Lanes } from './Lanes';
import { Planets } from './Planets';
import { Ships } from './Ships';
import { Sun } from './Sun';

export interface SceneProps {
  snapshot: Snapshot;
  /** Hold everything still (playback paused, or the engine is paused). */
  frozen: boolean;
}

/**
 * Runs before everything else each frame: works out the smooth cycle and where every planet is, once, so the planets,
 * lanes and ships all agree on the same moment.
 */
function FrameDriver({ snapshot, frozen, clock, frame }: SceneProps & { clock: CycleClock; frame: { current: FrameState } }) {
  useEffect(() => {
    clock.observe(snapshot.cycle, performance.now());
  }, [clock, snapshot.cycle]);
  useFrame(() => {
    const cycle = clock.now(performance.now(), frozen);
    frame.current = { cycle, planets: planetPositions(snapshot, cycle) };
  }, -1);
  return null;
}

/** The whole 3D view: deep space, a glowing sun, planets with their own looks, faint trade lanes and moving freighters. */
export default function SceneCanvas({ snapshot, frozen }: SceneProps) {
  const clock = useMemo(() => new CycleClock(), []);
  const frame = useRef<FrameState>({ cycle: snapshot.cycle, planets: planetPositions(snapshot, snapshot.cycle) });
  const [hoveredShip, setHoveredShip] = useState<string | null>(null);
  return (
    <Canvas className="scene-canvas" camera={{ position: [0, 7.5, 10.5], fov: 48, near: 0.1, far: 300 }} dpr={[1, 2]}>
      <color attach="background" args={['#04050b']} />
      <FrameDriver snapshot={snapshot} frozen={frozen} clock={clock} frame={frame} />
      <ambientLight intensity={0.55} color="#9fb4ff" />
      <Sun />
      <Stars radius={90} depth={50} count={4000} factor={4} saturation={0} fade speed={0.3} />
      <Lanes snapshot={snapshot} frame={frame} />
      <Planets snapshot={snapshot} frame={frame} />
      <Ships snapshot={snapshot} frame={frame} hovered={hoveredShip} onHover={setHoveredShip} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.07} minDistance={2.5} maxDistance={32} />
    </Canvas>
  );
}
