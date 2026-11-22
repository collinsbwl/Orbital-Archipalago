import { useEffect, useRef } from 'react';
import type { ElementRef, MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { V3 } from './curve';
import { focusPose, HOME_POSE, MAP_LIMITS, surfaceSite } from './focus';
import type { FrameState } from './frame';
import { lookFor } from './planet-look';

export type Controls = ElementRef<typeof OrbitControls>;

const vec = (v: V3) => new THREE.Vector3(v.x, v.y, v.z);

interface Flight {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** The orbit limits to apply once the camera has arrived. */
  min: number;
  max: number;
}

/**
 * Flies the camera to a planet when one is focused, and back to where it was when focus ends. While it flies, the
 * mouse controls are off (they would fight the motion) and their distance limits are wide open; on arrival the limits
 * for the new view go on and the controls come back. While focused it follows the planet, so orbiting planets would work too.
 */
export function CameraRig({ focused, frame, controls }: { focused: string | null; frame: { current: FrameState }; controls: MutableRefObject<Controls | null> }) {
  const { camera } = useThree();
  const flight = useRef<Flight | null>(null);
  const saved = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (focused) {
      const planet = frame.current.planets[focused];
      if (!planet) return;
      if (!previous.current) saved.current = { position: camera.position.clone(), target: c.target.clone() }; // remember the map view
      const pose = focusPose(planet, lookFor(focused).radius);
      flight.current = { position: vec(pose.position), target: vec(pose.target), min: pose.minDistance, max: pose.maxDistance };
    } else if (previous.current) {
      const home = saved.current ?? { position: vec(HOME_POSE.position), target: vec(HOME_POSE.target) };
      flight.current = { position: home.position, target: home.target, min: MAP_LIMITS.min, max: MAP_LIMITS.max };
    }
    if (flight.current) {
      c.enabled = false;
      c.minDistance = 0.01;
      c.maxDistance = 1000;
    }
    previous.current = focused;
  }, [focused, camera, controls, frame]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
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
        c.enabled = true;
        c.update();
        flight.current = null;
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
