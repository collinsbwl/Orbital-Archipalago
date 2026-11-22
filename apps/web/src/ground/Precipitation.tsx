import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AtmosphereRef } from './atmosphere-ref';
import type { PrecipKind } from './ground-look';
import { makeRng } from './rng';
import { PRECIP, PRECIP_BOX } from './precip';

const vertex = /* glsl */ `
  attribute vec3 aSeed;     // 0..1 position in the box
  attribute float aEnd;     // 0 or 1: which end of a rain streak
  uniform vec3 uBox;
  uniform vec3 uVel;
  uniform vec3 uCam;
  uniform float uTime;
  uniform float uStreak;
  uniform float uSway;
  uniform float uSize;
  uniform float uAmount;
  varying float vFade;
  void main() {
    float rnd = fract(aSeed.x * 91.7 + aSeed.z * 47.3);
    vec3 rel = mod(aSeed * uBox + uVel * uTime - uCam, uBox) - uBox * 0.5;
    rel.x += sin(uTime * 0.9 + rnd * 40.0) * uSway;
    rel.z += cos(uTime * 0.7 + rnd * 30.0) * uSway;
    vec3 world = uCam + rel;
    if (uStreak > 0.0) world -= normalize(uVel) * uStreak * aEnd;
    vFade = (1.0 - smoothstep(0.35, 1.0, length(rel) / (uBox.x * 0.5))) * step(rnd, uAmount);
    vec4 mv = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * 260.0 / max(1.0, -mv.z);
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uRound;
  varying float vFade;
  void main() {
    if (vFade <= 0.0) discard;
    float a = uAlpha * vFade;
    if (uRound > 0.5) a *= smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(uColor, a);
  }
`;

/** One kind of precipitation as a box of particles that follows the camera (rain as streaks, dust and snow as soft dots). */
function Falling({ kind, atmo }: { kind: PrecipKind; atmo: AtmosphereRef }) {
  const spec = PRECIP[kind];
  const streaks = spec.streak > 0;
  const geometry = useMemo(() => {
    const rng = makeRng(kind.length * 977 + spec.count);
    const per = streaks ? 2 : 1;
    const seed = new Float32Array(spec.count * per * 3);
    const end = new Float32Array(spec.count * per);
    for (let i = 0; i < spec.count; i++) {
      const x = rng();
      const y = rng();
      const z = rng();
      for (let k = 0; k < per; k++) {
        seed.set([x, y, z], (i * per + k) * 3);
        end[i * per + k] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    // The positions come from the shader, so give three something to count.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(spec.count * per * 3), 3));
    return g;
  }, [kind, spec.count, streaks]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          uBox: { value: new THREE.Vector3(...PRECIP_BOX) },
          uVel: { value: new THREE.Vector3(...spec.velocity) },
          uCam: { value: new THREE.Vector3() },
          uTime: { value: 0 },
          uStreak: { value: spec.streak },
          uSway: { value: spec.sway },
          uSize: { value: spec.size },
          uAmount: { value: 0 },
          uColor: { value: new THREE.Color() },
          uAlpha: { value: spec.alpha },
          uRound: { value: streaks ? 0 : 1 },
        },
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    [spec, streaks],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const mesh = useMemo(() => {
    const m = streaks ? new THREE.LineSegments(geometry, material) : new THREE.Points(geometry, material);
    m.frustumCulled = false;
    m.visible = false;
    return m;
  }, [geometry, material, streaks]);

  useFrame(({ camera, clock }) => {
    const a = atmo.current.atmosphere;
    const u = material.uniforms;
    u.uTime!.value = clock.elapsedTime;
    u.uCam!.value.copy(camera.position);
    u.uAmount!.value = a.precipitation.kind === kind ? a.precipitation.amount : 0;
    // Dimmer in the dark; tinted toward the sky so it sits in the fog.
    const dim = 0.25 + 0.75 * a.daylight;
    u.uColor!.value.setRGB(spec.color[0] * dim, spec.color[1] * dim, spec.color[2] * dim, THREE.SRGBColorSpace);
    mesh.visible = (u.uAmount!.value as number) > 0.01;
  });
  return <primitive object={mesh} />;
}

/** Rain, blowing dust or snow for the planet, thick in a storm and absent otherwise. Reads the shared atmosphere. */
export function Precipitation({ kind, atmo }: { kind: PrecipKind; atmo: AtmosphereRef }) {
  return <Falling key={kind} kind={kind} atmo={atmo} />;
}
