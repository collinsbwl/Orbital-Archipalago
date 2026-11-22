import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AtmosphereRef } from './atmosphere-ref';
import type { CityLayout } from './city-layout';
import { festivalPieces } from './festival';
import { activeBursts, rocketPosition, SPARKS, sparkFade, sparkPosition, STREAMS } from './fireworks';
import { Pieces } from './PieceMeshes';

const MAX_POINTS = STREAMS * (SPARKS + 1);

/** Sparks and rockets as one cheap additive point cloud. Only fires in the dark of a festive night. */
function Fireworks({ planet, atmo }: { planet: string; atmo: AtmosphereRef }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3));
    return g;
  }, []);
  const material = useMemo(() => new THREE.PointsMaterial({ size: 2.4, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false }), []);
  const points = useMemo(() => {
    const p = new THREE.Points(geometry, material);
    p.frustumCulled = false;
    return p;
  }, [geometry, material]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ clock }) => {
    const dark = atmo.current.atmosphere.night;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = geometry.getAttribute('color') as THREE.BufferAttribute;
    let n = 0;
    if (dark > 0.3) {
      for (const b of activeBursts(clock.elapsedTime, planet)) {
        const r = rocketPosition(b);
        if (r) {
          pos.setXYZ(n, r[0], r[1], r[2]);
          col.setXYZ(n++, 1, 0.9, 0.7);
          continue;
        }
        const fade = sparkFade(b) * dark;
        for (let i = 0; i < SPARKS; i++) {
          const p = sparkPosition(b, i)!;
          pos.setXYZ(n, p[0], p[1], p[2]);
          col.setXYZ(n++, b.color[0] * fade, b.color[1] * fade, b.color[2] * fade);
        }
      }
    }
    geometry.setDrawRange(0, n);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });
  return <primitive object={points} />;
}

/** A festive mood: banners down the roads, lanterns round the plaza, and fireworks after dark. Mount it only while festive. */
export function Festival({ planet, layout, atmo }: { planet: string; layout: CityLayout; atmo: AtmosphereRef }) {
  const pieces = useMemo(() => festivalPieces(layout), [layout]);
  return (
    <>
      <Pieces pieces={pieces} />
      <Fireworks planet={planet} atmo={atmo} />
    </>
  );
}
