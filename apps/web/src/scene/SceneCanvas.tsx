import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import { Vector3 } from 'three';
import { CameraRig } from './CameraRig';
import type { Controls } from './CameraRig';
import { settleControls } from './controls';
import { HOME_POSE, MAP_LIMITS, shouldDive } from './focus';
import { highlightedPlanet } from './highlight';
import { createPoseMemory, recall, remember } from './map-pose';
import type { PoseMemory } from './map-pose';
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
import { back, blurAt, canBack, easeInCubic, initialState, progress, start, tick } from './view-transition';
import type { TransitionState, View } from './view-transition';

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

/** The dive ends this many planet radii from the planet's centre, just outside its surface. */
const DIVE_END_RADII = 1.15;

/** A planet's current population from the snapshot (the ground scene uses it for city size and crowds). */
const populationOf = (snapshot: Snapshot, planet: string) => snapshot.planets.find((p) => p.planet === planet)?.metrics.population;

const viewKey = (v: View) => (v.kind === 'map' ? 'map' : `ground:${v.planet}`);

/** The map's orbit limits, as OrbitControls fields. */
const MAP_ORBIT = { minDistance: MAP_LIMITS.min, maxDistance: MAP_LIMITS.max, maxPolarAngle: Math.PI };

interface DirectorProps {
  transition: { current: TransitionState };
  frame: { current: FrameState };
  /** The map camera from before the click (the camera rig saves it). */
  memory: PoseMemory;
  /** True while the camera rig is flying to or from a planet. */
  flying: { current: boolean };
  /** The focused planet right now. Focus is the single source of truth: focused and close means dive, focus cleared means go back. */
  focusedRef: { current: string | null };
  onShown: (view: View, idle: boolean) => void;
}

/**
 * Runs the map <-> ground switch each frame: dives the camera at the focused planet once the focus zoom gets close,
 * blurs the canvas, puts the map camera back exactly where it was before the click, and tells the page which scene to
 * show. It owns the camera and the controls whenever the view is not the idle map (the camera rig stands down then).
 */
function ViewDirector({ transition, frame, memory, flying, focusedRef, onShown }: DirectorProps) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;
  const dive = useRef({ from: new Vector3(), fromTarget: new Vector3(), dir: new Vector3(), planet: '' });
  const last = useRef<{ view: View; free: boolean; reported: string }>({ view: transition.current.view, free: true, reported: '' });
  const goal = useRef(new Vector3());
  const end = useRef(new Vector3());

  // Clear the blur if the scene goes away mid-transition.
  useEffect(() => () => void (gl.domElement.style.filter = ''), [gl]);

  useFrame(() => {
    if (!controls) return;
    const now = performance.now();
    const prev = last.current;
    const orbit = controls;
    let s = tick(transition.current, now);

    const focus = focusedRef.current;
    if (s.phase === 'idle' && s.view.kind === 'map' && focus) {
      // The focus zoom got close: remember the map camera now (the rig usually already has; the first save wins), and dive.
      const p = frame.current.planets[focus];
      if (p && shouldDive(camera.position.distanceTo(goal.current.set(p.x, p.y, p.z)), lookFor(focus).radius, flying.current)) {
        orbit.enabled = false;
        remember(memory, camera.position, orbit.target);
        dive.current.planet = focus;
        dive.current.from.copy(camera.position);
        dive.current.fromTarget.copy(orbit.target);
        dive.current.dir.copy(camera.position).sub(goal.current);
        if (dive.current.dir.lengthSq() < 1e-6) dive.current.dir.set(0, 0.4, 1);
        dive.current.dir.normalize();
        s = start(s, focus, now);
      }
    } else if (!focus && canBack(s)) {
      s = back(s, now); // focus was cleared (Esc, Back, or the planet vanished): leave the ground
    }
    transition.current = s;

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

    // The view flipped (we are fully blurred): back on the map, the camera goes exactly where it was before the click.
    if (viewKey(s.view) !== viewKey(prev.view) && s.view.kind === 'map') {
      const pose = recall(memory, { position: dive.current.from, target: dive.current.fromTarget });
      camera.position.set(pose.position.x, pose.position.y, pose.position.z);
      orbit.target.set(pose.target.x, pose.target.y, pose.target.z);
      Object.assign(orbit, MAP_ORBIT);
      camera.lookAt(orbit.target);
    }

    // Steering is off whenever the view is not the idle map, checked every frame so a skipped phase cannot leave it on.
    const free = s.phase === 'idle' && s.view.kind === 'map';
    if (!free) {
      if (orbit.enabled) orbit.enabled = false;
    } else if (!prev.free && !flying.current) {
      settleControls(orbit); // no leftover damping from before, or the camera would drift
      orbit.enabled = true;
    }

    const blur = blurAt(s, now);
    const filter = blur > 0 ? `blur(${blur.toFixed(2)}px)` : '';
    if (gl.domElement.style.filter !== filter) gl.domElement.style.filter = filter;

    const key = `${viewKey(s.view)}|${s.phase === 'idle'}`;
    if (key !== prev.reported) {
      prev.reported = key;
      onShown(s.view, s.phase === 'idle');
    }
    prev.free = free;
    prev.view = s.view;
  });
  return null;
}

/**
 * The whole 3D view: deep space, a glowing sun, planets with their own looks, faint trade lanes and moving freighters.
 * Click a planet to focus it (the camera flies in, it is spotlighted, its card opens); zoom in close and the camera
 * dives onto its ground. Clearing the focus (Esc or Back) returns to the camera you left.
 */
export default function SceneCanvas({ snapshot, frozen, focused, onFocus }: SceneProps) {
  const clock = useMemo(() => new CycleClock(), []);
  const frame = useRef<FrameState>({ cycle: snapshot.cycle, planets: planetPositions(snapshot, snapshot.cycle) });
  const [hoveredShip, setHoveredShip] = useState<string | null>(null);
  const [hoveredPlanet, setHoveredPlanet] = useState<string | null>(null);
  const controls = useRef<Controls | null>(null);
  // The transition lives in a ref (it changes every frame); `shown` is just what the page needs to render.
  const transition = useRef<TransitionState>(initialState());
  const [shown, setShown] = useState<{ view: View; idle: boolean }>({ view: transition.current.view, idle: true });
  const onShown = useCallback((view: View, idle: boolean) => setShown({ view, idle }), []);
  const memory = useRef<PoseMemory>(createPoseMemory()).current;
  const flying = useRef(false);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const onMap = shown.view.kind === 'map';
  // A hidden (or fading) map still gets pointer hits, so it is only interactive while it is showing and still.
  const interactive = onMap && shown.idle;
  useEffect(() => {
    if (interactive) return;
    setHoveredShip(null); // no tooltip or glow should be left behind when the map goes away
    setHoveredPlanet(null);
  }, [interactive]);
  // The spotlight: the focused planet, or else the one under the mouse. It and its lanes stand out; the rest steps back.
  const highlight = highlightedPlanet(focused, interactive ? hoveredPlanet : null);

  return (
    <>
      <Canvas className="scene-canvas" camera={{ position: [HOME_POSE.position.x, HOME_POSE.position.y, HOME_POSE.position.z], fov: 48, near: 0.02, far: 300 }} dpr={[1, 2]}>
        {onMap && <color attach="background" args={['#04050b']} />}
        <FrameDriver snapshot={snapshot} frozen={frozen} clock={clock} frame={frame} />
        <ViewDirector transition={transition} frame={frame} memory={memory} flying={flying} focusedRef={focusedRef} onShown={onShown} />
        {/* The map stays mounted while we are on the ground, just hidden, so coming back is instant. */}
        <group visible={onMap}>
          <ambientLight intensity={0.55} color="#9fb4ff" />
          <Sun />
          <Stars radius={90} depth={50} count={4000} factor={4} saturation={0} fade speed={0.3} />
          <Lanes snapshot={snapshot} frame={frame} highlight={highlight} />
          <Planets snapshot={snapshot} frame={frame} focused={focused} onFocus={onFocus} hovered={hoveredPlanet} onHover={setHoveredPlanet} highlight={highlight} interactive={interactive} />
          <Ships snapshot={snapshot} frame={frame} hovered={interactive ? hoveredShip : null} onHover={setHoveredShip} highlight={highlight} interactive={interactive} />
        </group>
        {shown.view.kind === 'ground' && <GroundScene planet={shown.view.planet} population={populationOf(snapshot, shown.view.planet)} snapshot={snapshot} frame={frame} />}
        <CameraRig focused={focused} frame={frame} controls={controls} memory={memory} flying={flying} transition={transition} />
        <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.07} {...MAP_ORBIT} />
      </Canvas>
      {shown.idle && shown.view.kind === 'ground' && (
        <button type="button" className="glass ground-back" onClick={() => onFocus(null)}>
          Back to map
        </button>
      )}
    </>
  );
}
