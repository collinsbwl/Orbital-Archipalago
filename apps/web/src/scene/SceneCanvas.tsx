import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import { CameraRig } from './CameraRig';
import type { Controls } from './CameraRig';
import { HOME_POSE, MAP_LIMITS } from './focus';
import { highlightedPlanet } from './highlight';
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
  /** The planet the camera is zoomed in on, or null for the map. */
  focused: string | null;
  /** Ask to zoom in on a planet, or (null) to go back to the map. */
  onFocus: (planetId: string | null) => void;
}

/**
 * Runs before everything else each frame: works out the smooth cycle and where every planet is, once, so the planets,
 * lanes and ships all agree on the same moment.
 */
function FrameDriver({ snapshot, frozen, clock, frame }: Pick<SceneProps, 'snapshot' | 'frozen'> & { clock: CycleClock; frame: { current: FrameState } }) {
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
export default function SceneCanvas({ snapshot, frozen, focused, onFocus }: SceneProps) {
  const clock = useMemo(() => new CycleClock(), []);
  const frame = useRef<FrameState>({ cycle: snapshot.cycle, planets: planetPositions(snapshot, snapshot.cycle) });
  const [hoveredShip, setHoveredShip] = useState<string | null>(null);
  const [hoveredPlanet, setHoveredPlanet] = useState<string | null>(null);
  // The spotlight: the focused planet, or else the one under the mouse. It and its lanes stand out; the rest steps back.
  const highlight = highlightedPlanet(focused, hoveredPlanet);
  const controls = useRef<Controls | null>(null);
  return (
    <Canvas className="scene-canvas" camera={{ position: [HOME_POSE.position.x, HOME_POSE.position.y, HOME_POSE.position.z], fov: 48, near: 0.02, far: 300 }} dpr={[1, 2]}>
      <color attach="background" args={['#04050b']} />
      <FrameDriver snapshot={snapshot} frozen={frozen} clock={clock} frame={frame} />
      <ambientLight intensity={0.55} color="#9fb4ff" />
      <Sun />
      <Stars radius={90} depth={50} count={4000} factor={4} saturation={0} fade speed={0.3} />
      <Lanes snapshot={snapshot} frame={frame} highlight={highlight} />
      <Planets snapshot={snapshot} frame={frame} focused={focused} onFocus={onFocus} hovered={hoveredPlanet} onHover={setHoveredPlanet} highlight={highlight} />
      <Ships snapshot={snapshot} frame={frame} hovered={hoveredShip} onHover={setHoveredShip} highlight={highlight} />
      <CameraRig focused={focused} frame={frame} controls={controls} />
      <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.07} minDistance={MAP_LIMITS.min} maxDistance={MAP_LIMITS.max} />
    </Canvas>
  );
}
