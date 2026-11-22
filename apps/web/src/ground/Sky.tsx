import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AtmosphereRef } from './atmosphere-ref';
import { lookFor } from '../scene/planet-look';
import type { PlanetLook } from '../scene/planet-look';

/** The sky dome is this big; the camera's far plane must be bigger (the ground scene sets that). */
export const SKY_RADIUS = 900;
/** The planet discs sit a little inside the dome. */
const BODY_RADIUS = SKY_RADIUS * 0.96;

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
  uniform float uSunVisible;
  uniform float uStars;
  uniform mat3 uCelestial;   // ground axes (east, up, south) as columns, in map axes
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(uHorizon, uTop, pow(up, 0.5));
    // Stars: fixed in the map's frame, so the spin of the planet carries them across the sky.
    if (uStars > 0.01 && dir.y > -0.05) {
      vec3 p = (uCelestial * dir) * 70.0;
      vec3 cell = floor(p);
      float h = hash13(cell);
      if (h > 0.965) {
        vec3 f = fract(p) - 0.5;
        float tw = 0.75 + 0.25 * sin(h * 600.0);
        float star = smoothstep(0.28, 0.0, length(f)) * tw * smoothstep(0.0, 0.2, dir.y + 0.05);
        col += vec3(0.9, 0.93, 1.0) * star * uStars;
      }
    }
    float c = dot(dir, uSunDir);
    col += uSunColor * pow(max(c, 0.0), 24.0) * 0.28 * uSunVisible;   // wide glow round the sun
    col = mix(col, uSunColor, smoothstep(0.9990, 0.9996, c) * uSunVisible);   // the disc
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const bodyVertex = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** A little lit planet: banded in its palette colours, shaded by where the sun is, with its ring if it has one. */
const bodyFragment = /* glsl */ `
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uLight;     // toward the sun, in the disc's own axes
  uniform vec3 uRing;
  uniform vec3 uRingShape; // x: inner, y: outer (in disc radii), z: 0 when no ring
  uniform float uSeed;
  uniform float uAlpha;
  varying vec2 vP;
  void main() {
    vec2 q = vP;                 // -R..R across the quad, where R = uRingShape-sized margin
    float scale = max(uRingShape.z, 1.0);
    q *= scale;                  // now 1.0 is the planet's edge
    float r = length(q);
    vec4 outc = vec4(0.0);
    if (r < 1.0) {
      vec3 n = vec3(q, sqrt(1.0 - r * r));
      float band = 0.5 + 0.5 * sin(n.y * 6.0 + uSeed + sin(n.x * 3.0 + uSeed * 2.0) * 0.8);
      vec3 base = mix(uA, uB, band);
      float lit = clamp(dot(n, normalize(uLight)), 0.0, 1.0);
      vec3 col = base * (0.06 + 0.94 * lit);
      outc = vec4(col, uAlpha);
    }
    if (uRingShape.z > 1.0) {
      vec2 e = vec2(q.x, q.y / 0.32);
      float er = length(e);
      if (er > uRingShape.x && er < uRingShape.y && (q.y < 0.0 || r > 1.0)) {
        float lit = 0.35 + 0.65 * clamp(uLight.z * 0.5 + 0.5, 0.0, 1.0);
        outc = vec4(uRing * lit, uAlpha * 0.8);
      }
    }
    if (outc.a <= 0.0) discard;
    gl_FragColor = outc;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** One neighbouring planet's disc. */
function makeBodyMaterial(look: PlanetLook): THREE.ShaderMaterial {
  const ring = look.ring;
  return new THREE.ShaderMaterial({
    vertexShader: bodyVertex,
    fragmentShader: bodyFragment,
    uniforms: {
      uA: { value: new THREE.Color(look.palette[0]) },
      uB: { value: new THREE.Color(look.palette[Math.min(2, look.palette.length - 1)]) },
      uLight: { value: new THREE.Vector3(0, 0, 1) },
      uRing: { value: new THREE.Color(ring?.color ?? '#ffffff') },
      uRingShape: { value: new THREE.Vector3(ring ? ring.inner : 0, ring ? ring.outer : 0, ring ? ring.outer * 1.05 : 1) },
      uSeed: { value: (look.seed % 1000) / 100 },
      uAlpha: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

const basisMatrix = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const right = new THREE.Vector3();
const upv = new THREE.Vector3();
const toward = new THREE.Vector3();

/** The other planets as discs on the sky dome. Position, size and lit side come from the shared atmosphere state each frame. */
function SkyBodies({ ids, atmo }: { ids: string[]; atmo: AtmosphereRef }) {
  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const items = useMemo(
    () =>
      ids.map((id) => {
        const material = makeBodyMaterial(lookFor(id));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = -9;
        mesh.frustumCulled = false;
        return { id, material, mesh };
      }),
    [ids, geometry],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => items.forEach((i) => i.material.dispose()), [items]);
  useFrame(() => {
    const { bodies } = atmo.current;
    const night = atmo.current.atmosphere.night;
    for (const item of items) {
      const b = bodies.find((x) => x.id === item.id);
      const m = item.mesh;
      if (!b || !b.visible) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      m.position.set(b.dir[0], b.dir[1], b.dir[2]).multiplyScalar(BODY_RADIUS);
      right.set(...b.right);
      upv.set(...b.up);
      toward.set(...b.toward);
      quat.setFromRotationMatrix(basisMatrix.makeBasis(right, upv, toward));
      m.quaternion.copy(quat);
      const ring = (item.material.uniforms.uRingShape!.value as THREE.Vector3).z;
      const size = 2 * Math.tan(b.angularRadius) * BODY_RADIUS * ring;
      m.scale.set(size, size, 1);
      item.material.uniforms.uLight!.value.set(...b.light);
      item.material.uniforms.uAlpha!.value = (0.45 + 0.55 * night) * (1 - 0.9 * atmo.current.atmosphere.overcast);
    }
  });
  return (
    <>
      {items.map((i) => (
        <primitive key={i.id} object={i.mesh} />
      ))}
    </>
  );
}

/**
 * The sky: a gradient dome (colours from the shared atmosphere, so day, night and weather all show here), a sun disc in
 * the real sun direction, stars at night, and the other planets as discs. It follows the camera, so it stays at the horizon.
 */
export function Sky({ atmo, planetIds }: { atmo: AtmosphereRef; planetIds: string[] }) {
  const group = useRef<THREE.Group>(null);
  const material = useMemo(() => {
    const a = atmo.current.atmosphere;
    return new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uTop: { value: new THREE.Color().setRGB(...a.skyTop, THREE.SRGBColorSpace) },
        uHorizon: { value: new THREE.Color().setRGB(...a.skyHorizon, THREE.SRGBColorSpace) },
        uSunDir: { value: new THREE.Vector3(...a.sunDir) },
        uSunColor: { value: new THREE.Color().setRGB(...a.sunColor, THREE.SRGBColorSpace) },
        uSunVisible: { value: 1 },
        uStars: { value: 0 },
        uCelestial: { value: new THREE.Matrix3() },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const geometry = useMemo(() => new THREE.SphereGeometry(SKY_RADIUS, 32, 16), []);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame(({ camera }) => {
    group.current?.position.copy(camera.position);
    const { atmosphere: a, basis } = atmo.current;
    const u = material.uniforms;
    u.uTop!.value.setRGB(...a.skyTop, THREE.SRGBColorSpace);
    u.uHorizon!.value.setRGB(...a.skyHorizon, THREE.SRGBColorSpace);
    u.uSunDir!.value.set(...a.sunDir);
    u.uSunColor!.value.setRGB(...a.sunColor, THREE.SRGBColorSpace);
    u.uSunVisible!.value = a.sunVisible;
    u.uStars!.value = a.stars;
    const [e, up, s] = [basis.east, basis.up, basis.south];
    // Columns east, up, south: multiplying a ground direction gives the same direction in map axes.
    u.uCelestial!.value.set(e[0], up[0], s[0], e[1], up[1], s[1], e[2], up[2], s[2]);
  });

  return (
    <group ref={group}>
      <mesh geometry={geometry} material={material} renderOrder={-10} frustumCulled={false} />
      <SkyBodies ids={planetIds} atmo={atmo} />
    </group>
  );
}
