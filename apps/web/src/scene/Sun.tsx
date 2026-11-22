import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { makeGlowTexture } from './glow';

/** The sun: a glowing low-poly ball at the center that lights every planet. */
export function Sun() {
  const glow = useMemo(makeGlowTexture, []);
  useEffect(() => () => glow.dispose(), [glow]);
  const ball = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ball.current) ball.current.rotation.y += dt * 0.08;
  });
  return (
    <group>
      <pointLight color="#fff0c8" intensity={2.6} decay={0} />
      <mesh ref={ball}>
        <icosahedronGeometry args={[0.75, 2]} />
        <meshBasicMaterial color="#ffd24a" />
      </mesh>
      <sprite scale={[5.2, 5.2, 1]}>
        <spriteMaterial map={glow} color="#ffb347" transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}
