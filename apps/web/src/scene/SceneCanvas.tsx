import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import { Vector3 } from 'three';
import type { Snapshot } from '@orbital/contracts';
import { GroundScene } from '../ground/GroundScene';
import type { ControlsLike } from '../ground/GroundScene';
import { CycleClock } from './clock';
import { planetPositions } from './frame';
import type { FrameState } from './frame';
import { Lanes } from './Lanes';
import { lookFor } from './planet-look';
import { Planets } from './Planets';
import { Ships } from './Ships';
import { Sun } from './Sun';
import { back, blurAt, easeInCubic, initialState, progress, start, tick } from './view-transition';
import type { Phase, TransitionState, View } from './view-transition';

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

/** Camera limits on the map. (The ground scene sets its own when it lands.) */
const MAP_LIMITS = { minDistance: 2.5, maxDistance: 32, maxPolarAngle: Math.PI };
/** The dive ends this many planet radii from the planet's centre, just outside its surface. */
const DIVE_END_RADII = 1.15;

/** A planet's current population from the snapshot (the ground scene uses it for city size and crowds). */
const populationOf = (snapshot: Snapshot, planet: string) => snapshot.planets.find((p) => p.planet === planet)?.metrics.population;

const viewKey = (v: View) => (v.kind === 'map' ? 'map' : `ground:${v.planet}`);

/**
 * Runs the map <-> ground switch each frame: dives the camera at a planet, blurs the canvas, remembers where the map
 * camera was and puts it back exactly, and tells the page which scene to show.
 */
function ViewDirector({ transition, frame, onShown }: {
  transition: { current: TransitionState };
  frame: { current: FrameState };
  onShown: (view: View, idle: boolean) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const saved = useRef({ position: new Vector3(), target: new Vector3() });
  const dive = useRef({ from: new Vector3(), fromTarget: new Vector3(), dir: new Vector3(), planet: '' });
  const last = useRef<{ phase: Phase; view: View; reported: string }>({ phase: 'idle', view: transition.current.view, reported: '' });
  const goal = useRef(new Vector3());
  const end = useRef(new Vector3());

  // Clear the blur if the scene goes away mid-transition.
  useEffect(() => () => void (gl.domElement.style.filter = ''), [gl]);

  useFrame(() => {
    if (!controls) return;
    const now = performance.now();
    const prev = last.current;
    const s = tick(transition.current, now);
    transition.current = s;
    const orbit = controls;

    // A transition just began: keep the map camera and stop the user steering.
    if (prev.phase === 'idle' && s.phase !== 'idle') {
      orbit.enabled = false;
      if (prev.view.kind === 'map') {
        saved.current.position.copy(camera.position);
        saved.current.target.copy(orbit.target);
        dive.current.from.copy(camera.position);
        dive.current.fromTarget.copy(orbit.target);
        const goalView = s.next ?? s.view;
        dive.current.planet = goalView.kind === 'ground' ? goalView.planet : '';
        const p = frame.current.planets[dive.current.planet];
        dive.current.dir.set(0, 0.4, 1);
        if (p) dive.current.dir.copy(dive.current.from).sub(goal.current.set(p.x, p.y, p.z));
        if (dive.current.dir.lengthSq() < 1e-6) dive.current.dir.set(0, 0.4, 1);
        dive.current.dir.normalize();
      }
    }

    // Falling toward the planet: ease in, ending just outside its surface, with the view centred on it.
    if (s.phase === 'diving') {
      const p = frame.current.planets[dive.current.planet];
      if (p) {
        const k = easeInCubic(progress(s, now));
        const reach = lookFor(dive.current.planet).radius * DIVE_END_RADII;
        goal.current.set(p.x, p.y, p.z);
        end.current.copy(goal.current).addScaledVector(dive.current.dir, reach);
        camera.position.copy(dive.current.from).lerp(end.current, k);
        orbit.target.copy(dive.current.fromTarget).lerp(goal.current, k);
        camera.lookAt(orbit.target);
      }
    }

    // The view flipped (we are fully blurred): back on the map, the camera goes exactly where it was.
    if (viewKey(s.view) !== viewKey(prev.view) && s.view.kind === 'map') {
      camera.position.copy(saved.current.position);
      orbit.target.copy(saved.current.target);
      Object.assign(orbit, MAP_LIMITS);
      camera.lookAt(orbit.target);
    }

    if (s.phase === 'idle' && prev.phase !== 'idle') orbit.enabled = true;

    const blur = blurAt(s, now);
    const filter = blur > 0 ? `blur(${blur.toFixed(2)}px)` : '';
    if (gl.domElement.style.filter !== filter) gl.domElement.style.filter = filter;

    const key = `${viewKey(s.view)}|${s.phase === 'idle'}`;
    if (key !== prev.reported) {
      prev.reported = key;
      onShown(s.view, s.phase === 'idle');
    }
    prev.phase = s.phase;
    prev.view = s.view;
  });
  return null;
}

/**
 * The whole 3D view: deep space, a glowing sun, planets with their own looks, faint trade lanes and moving freighters.
 * Click a planet to dive down to a ground scene; "Back to map" or Esc returns to the camera you left.
 */
export default function SceneCanvas({ snapshot, frozen }: SceneProps) {
  const clock = useMemo(() => new CycleClock(), []);
  const frame = useRef<FrameState>({ cycle: snapshot.cycle, planets: planetPositions(snapshot, snapshot.cycle) });
  const [hoveredShip, setHoveredShip] = useState<string | null>(null);
  // The transition lives in a ref (it changes every frame); `shown` is just what the page needs to render.
  const transition = useRef<TransitionState>(initialState());
  const [shown, setShown] = useState<{ view: View; idle: boolean }>({ view: transition.current.view, idle: true });
  const onShown = useCallback((view: View, idle: boolean) => setShown({ view, idle }), []);

  const selectPlanet = useCallback((planet: string) => {
    const next = start(transition.current, planet, performance.now());
    if (next === transition.current) return;
    transition.current = next;
    setHoveredShip(null); // no tooltip should be left behind when the map goes away
  }, []);
  const goBack = useCallback(() => {
    transition.current = back(transition.current, performance.now());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  const onMap = shown.view.kind === 'map';
  // A hidden map still gets pointer hits, so only let ships be hovered while it is showing.
  const hoverShip = useCallback((id: string | null) => setHoveredShip(id && transition.current.view.kind === 'map' && transition.current.phase === 'idle' ? id : null), []);
  return (
    <>
      <Canvas className="scene-canvas" camera={{ position: [0, 7.5, 10.5], fov: 48, near: 0.1, far: 300 }} dpr={[1, 2]}>
        {onMap && <color attach="background" args={['#04050b']} />}
        <FrameDriver snapshot={snapshot} frozen={frozen} clock={clock} frame={frame} />
        <ViewDirector transition={transition} frame={frame} onShown={onShown} />
        {/* The map stays mounted while we are on the ground, just hidden, so coming back is instant. */}
        <group visible={onMap}>
          <ambientLight intensity={0.55} color="#9fb4ff" />
          <Sun />
          <Stars radius={90} depth={50} count={4000} factor={4} saturation={0} fade speed={0.3} />
          <Lanes snapshot={snapshot} frame={frame} />
          <Planets snapshot={snapshot} frame={frame} onSelect={onMap ? selectPlanet : undefined} />
          <Ships snapshot={snapshot} frame={frame} hovered={onMap ? hoveredShip : null} onHover={hoverShip} />
        </group>
        {shown.view.kind === 'ground' && <GroundScene planet={shown.view.planet} population={populationOf(snapshot, shown.view.planet)} snapshot={snapshot} frame={frame} />}
        <OrbitControls makeDefault enableDamping dampingFactor={0.07} {...MAP_LIMITS} />
      </Canvas>
      {shown.idle && shown.view.kind === 'ground' && (
        <button type="button" className="glass ground-back" onClick={goBack}>
          Back to map
        </button>
      )}
    </>
  );
}
