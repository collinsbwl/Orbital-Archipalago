import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/** A soft round glow, drawn once on a canvas and used as a billboard behind the sun. */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

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
