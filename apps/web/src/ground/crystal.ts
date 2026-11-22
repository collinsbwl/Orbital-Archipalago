import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AtmosphereRef } from './atmosphere-ref';

/** Where the shaft of a crystal ends and its point begins, as a share of its height. */
const SHAFT = 0.8;

/**
 * A unit crystal spire standing on y = 0: a six-sided shaft that narrows a little as it rises, capped by a sharp point.
 * About 1 across and 1 tall, so scaling an instance by (w, h, d) stands it on the ground like a box.
 */
export function crystalSpireGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.36, 0.5, SHAFT, 6, 4).translate(0, SHAFT / 2, 0);
  const tip = new THREE.ConeGeometry(0.36, 1 - SHAFT, 6).translate(0, SHAFT + (1 - SHAFT) / 2, 0);
  const merged = mergeGeometries([shaft.toNonIndexed(), tip.toNonIndexed()])!;
  shaft.dispose();
  tip.dispose();
  merged.computeVertexNormals();
  return merged;
}

/**
 * A unit futuristic igloo standing on y = 0: a smooth ice dome 1 across and 1 tall with a low arched entrance tunnel
 * poking out of its front (-z, toward the plaza when turned like a city building) and a raised skylight ring on top.
 * Scale an instance by (diameter, height, diameter).
 */
export function iglooGeometry(): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(0.5, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1);
  // Half a cylinder lying along z: the arched tunnel. Its open bottom sits on the ground.
  const tunnel = new THREE.CylinderGeometry(0.17, 0.17, 0.36, 10, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const skylight = new THREE.CylinderGeometry(0.1, 0.14, 0.06, 12).translate(0, 0.985, 0);
  const parts = [dome, tunnel, skylight];
  const merged = mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
  parts.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

/**
 * A colossal carved ice monolith, about 1 across and 1 tall on y = 0: a tall, leaning, lumpy shell like a frozen wave.
 * Scale it up by tens of metres.
 */
export function iceShellGeometry(seed = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 3);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const up = v.y + 0.5; // 0 at the bottom, 1 at the top
    // Pointed top, swept back like a wave, with ridges running up it.
    const narrow = 1 - 0.75 * Math.pow(Math.max(0, up - 0.1), 1.6);
    const ridge = 1 + 0.06 * Math.sin(Math.atan2(v.z, v.x) * 9 + up * 6 + seed) + 0.04 * Math.sin(up * 23 + seed * 3);
    v.x *= narrow * ridge;
    v.z *= narrow * ridge * 0.7;
    v.x += 0.22 * up * up;
    v.y = Math.max(0, up) * 1.0;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const out = g.toNonIndexed();
  g.dispose();
  out.computeVertexNormals();
  return out;
}

const CRYSTAL_HASH = /* glsl */ `
  float crHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
`;

/**
 * Glassy ice: glossy, a little metallic, lit from within. The facet edges glow, a cold light rises toward the tip,
 * thin bands of light ring the shaft, the rim catches the sky, and at dusk scattered windows warm up one by one (from
 * the shared atmosphere's `windows` level). Works on instanced and plain meshes; reads the geometry's own height
 * (0 to 1) for the glow, so use it with the unit crystal shapes above.
 */
export function useCrystalMaterial(atmo?: AtmosphereRef, options: { glow?: string; strength?: number } = {}) {
  const glow = useMemo(() => ({ value: 0 }), []);
  const glowColor = options.glow ?? '#7fd8ff';
  const strength = options.strength ?? 1;
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.16, metalness: 0.35 });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = glow;
      shader.uniforms.uCrystal = { value: new THREE.Color(glowColor) };
      shader.uniforms.uStrength = { value: strength };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCrLocal;\nvarying vec3 vCrSeed;\nvarying vec3 vCrWorld;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            mat4 crM = modelMatrix * instanceMatrix;
          #else
            mat4 crM = modelMatrix;
          #endif
          vCrLocal = position;
          vCrSeed = (crM * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vCrWorld = (crM * vec4(transformed, 1.0)).xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying vec3 vCrLocal;\nvarying vec3 vCrSeed;\nvarying vec3 vCrWorld;\nuniform float uGlow;\nuniform vec3 uCrystal;\nuniform float uStrength;\n${CRYSTAL_HASH}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float crH = clamp(vCrLocal.y, 0.0, 1.0);
          float crAng = atan(vCrLocal.z, vCrLocal.x);
          // Bright seams down the six edges of the shaft.
          float crEdge = pow(abs(cos(crAng * 3.0)), 60.0);
          // Thin rings of light every few metres.
          float crBand = step(0.975, fract(vCrWorld.y / 9.0 + crHash(floor(vCrSeed)))) * step(crH, 0.8);
          // Scattered narrow window slits that light at dusk.
          vec2 crGrid = vec2(crAng * 7.0, vCrWorld.y / 2.6);
          vec2 crF = fract(crGrid);
          float crSlit = step(0.42, crF.x) * step(crF.x, 0.58) * step(0.25, crF.y) * step(crF.y, 0.7);
          float crWin = crHash(vec3(floor(crGrid), dot(vCrSeed.xz, vec2(0.0731, 0.1183))));
          float crLit = crSlit * step(crWin, uGlow * 0.28) * step(1.5, vCrWorld.y) * step(crH, 0.76);
          // Paler and frostier toward the tip, deeper blue at the base.
          diffuseColor.rgb *= mix(0.72, 1.12, crH);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float crRim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0);
          float crNight = 0.45 + 0.55 * uGlow;
          totalEmissiveRadiance += uCrystal * uStrength * (
            (0.08 + 0.55 * pow(crH, 3.0)) * crNight
            + crEdge * 0.7 * crNight
            + crBand * 0.45 * crNight
            + crRim * 0.35
          );
          totalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * crLit * 0.9;`,
        );
    };
    m.customProgramCacheKey = () => `crystal:${glowColor}:${strength}`;
    return m;
  }, [glow, glowColor, strength]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => {
    if (atmo) glow.value = atmo.current.atmosphere.windows;
  });
  return material;
}
