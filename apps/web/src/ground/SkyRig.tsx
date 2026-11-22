import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Snapshot } from '@orbital/contracts';
import type { FrameState } from '../scene/frame';
import { computeAtmosphere } from './atmosphere';
import type { AtmosphereRef } from './atmosphere-ref';
import type { GroundLook } from './ground-look';
import { busynessOf, moodScores, settledMood, stepBusyness, stepMood } from './mood';
import type { MoodKind, MoodState } from './mood';
import { skyView } from './sky-bodies';

/** The few things the rest of the scene needs from the mood. It changes in coarse steps so React only re-renders when it matters. */
export interface MoodView {
  kind: MoodKind;
  /** Multiplier for crowds, vehicles, stalls and smoke. */
  busyness: number;
  /** Show festival banners and lanterns. */
  festive: boolean;
}

const NO_EVENTS: Snapshot['events'] = [];

/**
 * The scene's single sky and light controller. Every frame it eases the mood, finds the sun (from the map positions, then
 * turned by the planet's spin for the time of day), asks atmosphere.ts for the result, stores it in `atmo` for the sky
 * dome, weather, windows and lamps to read, and applies it to the fog, background and the three lights.
 */
export function SkyRig({ planet, look, snapshot, frame, atmo, onMood }: {
  planet: string;
  look: GroundLook;
  snapshot?: Snapshot;
  frame: { current: FrameState };
  atmo: AtmosphereRef;
  onMood: (view: MoodView) => void;
}) {
  const scores = useMemo(
    () => moodScores({ metrics: snapshot?.planets.find((p) => p.planet === planet)?.metrics, events: snapshot?.events ?? NO_EVENTS, planet, cycle: snapshot?.cycle ?? 0 }),
    [snapshot, planet],
  );
  const scoresRef = useRef(scores);
  scoresRef.current = scores;
  // Start settled in the mood the scores call for, so diving in does not begin with a storm easing in.
  const mood = useRef<MoodState>(settledMood(scores));
  const last = useRef<MoodView | null>(null);

  const bg = useRef<THREE.Color>(null);
  const fog = useRef<THREE.Fog>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const moon = useRef<THREE.DirectionalLight>(null);

  useFrame((_, delta) => {
    mood.current = stepMood(mood.current, scoresRef.current, Math.min(delta, 0.25));
    const view = skyView({ planetId: planet, sunElevation: look.sunElevation, cycle: frame.current.cycle, planets: frame.current.planets });
    const a = computeAtmosphere({ look, mood: mood.current, timeOfDay: view.timeOfDay, sunDir: view.sun });
    atmo.current = { atmosphere: a, mood: mood.current, basis: view.basis, bodies: view.bodies };

    bg.current?.setRGB(...a.skyHorizon, THREE.SRGBColorSpace);
    if (fog.current) {
      fog.current.color.setRGB(...a.fogColor, THREE.SRGBColorSpace);
      fog.current.near = a.fogNear;
      fog.current.far = a.fogFar;
    }
    if (hemi.current) {
      hemi.current.color.setRGB(...a.hemi.sky, THREE.SRGBColorSpace);
      hemi.current.groundColor.setRGB(...a.hemi.ground, THREE.SRGBColorSpace);
      hemi.current.intensity = a.hemi.intensity;
    }
    if (sun.current) {
      sun.current.position.set(a.sunLight.dir[0] * 200, a.sunLight.dir[1] * 200, a.sunLight.dir[2] * 200);
      sun.current.color.setRGB(...a.sunLight.color, THREE.SRGBColorSpace);
      sun.current.intensity = a.sunLight.intensity;
    }
    if (moon.current) {
      moon.current.position.set(a.moonLight.dir[0] * 200, a.moonLight.dir[1] * 200, a.moonLight.dir[2] * 200);
      moon.current.color.setRGB(...a.moonLight.color, THREE.SRGBColorSpace);
      moon.current.intensity = a.moonLight.intensity;
    }

    const next: MoodView = { kind: mood.current.kind, busyness: stepBusyness(busynessOf(mood.current)), festive: mood.current.cheer > 0.5 };
    const l = last.current;
    if (!l || l.kind !== next.kind || l.busyness !== next.busyness || l.festive !== next.festive) {
      last.current = next;
      onMood(next);
    }
  });

  const a = atmo.current.atmosphere;
  return (
    <>
      <color ref={bg} attach="background" args={[look.sky]} />
      <fog ref={fog} attach="fog" args={[look.sky, a.fogNear, a.fogFar]} />
      <hemisphereLight ref={hemi} args={[look.skyTop, look.ground, a.hemi.intensity]} />
      <directionalLight ref={sun} intensity={a.sunLight.intensity} />
      <directionalLight ref={moon} intensity={a.moonLight.intensity} />
    </>
  );
}
