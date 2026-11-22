import { useEffect, useRef } from 'react';
import type { ElementRef, MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { settleControls } from './controls';
import type { V3 } from './curve';
import { focusPose, HOME_POSE, MAP_LIMITS, surfaceSite } from './focus';
import type { FrameState } from './frame';
import { forget, recall, remember } from './map-pose';
import type { PoseMemory } from './map-pose';
import { lookFor } from './planet-look';
import type { TransitionState } from './view-transition';

export type Controls = ElementRef<typeof OrbitControls>;

const vec = (v: V3) => new THREE.Vector3(v.x, v.y, v.z);

interface Flight {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** The orbit limits to apply once the camera has arrived. */
  min: number;
  max: number;
}

interface RigProps {
  focused: string | null;
  frame: { current: FrameState };
  controls: MutableRefObject<Controls | null>;
  /** The map camera from before the first click; shared with the view director so Back puts the camera exactly there. */
  memory: PoseMemory;
  /** Set while a focus flight is under way (the view director waits for it to finish before it will dive). */
  flying: MutableRefObject<boolean>;
  /** The map <-> ground switch. This rig only moves the camera while the map is showing and nothing is in transition. */
  transition: { current: TransitionState };
}

/**
 * Flies the camera to a planet when one is focused, and back to where it was when focus ends. While it flies, the
 * mouse controls are off (they would fight the motion) and their distance limits are wide open; on arrival the limits
 * for the new view go on and the controls come back. While focused it follows the planet, so orbiting planets would work too.
 *
 * It is one of two camera drivers; the other is the view director (the dive onto the ground). Only one moves the camera
 * at a time: this rig stands down whenever the view is not the idle map.
 */
export function CameraRig({ focused, frame, controls, memory, flying, transition }: RigProps) {
  const { camera } = useThree();
  const flight = useRef<Flight | null>(null);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (focused) {
      const planet = frame.current.planets[focused];
      if (!planet) return;
      if (!previous.current) remember(memory, camera.position, c.target); // remember the map view (kept until Back)
      const pose = focusPose(planet, lookFor(focused).radius);
      flight.current = { position: vec(pose.position), target: vec(pose.target), min: pose.minDistance, max: pose.maxDistance };
    } else if (previous.current) {
      const home = recall(memory, HOME_POSE);
      flight.current = { position: vec(home.position), target: vec(home.target), min: MAP_LIMITS.min, max: MAP_LIMITS.max };
    }
    if (flight.current) {
      flying.current = true;
      c.enabled = false;
      c.minDistance = 0.01;
      c.maxDistance = 1000;
    }
    previous.current = focused;
  }, [focused, camera, controls, frame, memory, flying]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const t = transition.current;
    if (t.phase !== 'idle' || t.view.kind !== 'map') return; // the view director owns the camera now
    const f = flight.current;
    if (f) {
      const k = 1 - Math.pow(0.002, dt); // ease toward the goal, about half a second
      camera.position.lerp(f.position, k);
      c.target.lerp(f.target, k);
      camera.lookAt(c.target);
      if (camera.position.distanceTo(f.position) < 0.03 && c.target.distanceTo(f.target) < 0.03) {
        camera.position.copy(f.position);
        c.target.copy(f.target);
        c.minDistance = f.min;
        c.maxDistance = f.max;
        c.maxPolarAngle = Math.PI;
        settleControls(c);
        c.enabled = true;
        flight.current = null;
        flying.current = false;
        if (!focused) forget(memory); // back on the map: the saved view has done its job
      }
    } else if (focused) {
      const p = frame.current.planets[focused];
      if (p) {
        const delta = vec(surfaceSite(p, lookFor(focused).radius).point).sub(c.target);
        if (delta.lengthSq() > 1e-10) {
          camera.position.add(delta);
          c.target.add(delta);
        }
      }
    }
  });
  return null;
}
