import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { GroundLook } from './ground-look';

/** The sky dome is this big; the camera's far plane must be bigger (the ground scene sets that). */
export const SKY_RADIUS = 900;

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  varying vec3 vDir;
  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(up, 0.5));
    float c = dot(dir, uSunDir);
    col += uSunColor * pow(max(c, 0.0), 24.0) * 0.28;   // wide glow round the sun
    col = mix(col, uSunColor, smoothstep(0.9990, 0.9996, c));   // the disc
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** A gradient sky (horizon to zenith) with a sun disc. It follows the camera, so it is always at the horizon. */
export function Sky({ look, sunDir }: { look: GroundLook; sunDir: [number, number, number] }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          uTop: { value: new THREE.Color(look.skyTop) },
          uHorizon: { value: new THREE.Color(look.sky) },
          uSunDir: { value: new THREE.Vector3(...sunDir).normalize() },
          uSunColor: { value: new THREE.Color(look.sunColor) },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    [look, sunDir],
  );
  const geometry = useMemo(() => new THREE.SphereGeometry(SKY_RADIUS, 32, 16), []);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useFrame(({ camera }) => mesh.current?.position.copy(camera.position));
  return <mesh ref={mesh} geometry={geometry} material={material} renderOrder={-10} frustumCulled={false} />;
}
