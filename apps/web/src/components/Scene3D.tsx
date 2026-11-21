import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Snapshot } from '@orbital/contracts';
import { orbitOf, planetXY, shipmentXY } from '../orbits';

const SCALE = 1 / 40; // world distance units -> scene units
export const PLANET_COLORS = ['#e8833a', '#5cb85c', '#4aa3df', '#c27ad6', '#e5c744'];

interface SceneApi {
  update(s: Snapshot): void;
  dispose(): void;
}

function createScene(container: HTMLElement): SceneApi {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 9, 9);
  camera.lookAt(0, 0, 0);

  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), new THREE.MeshBasicMaterial({ color: '#ffd24a' }));
  scene.add(sun);

  const planetGeo = new THREE.SphereGeometry(0.22, 20, 14);
  const shipGeo = new THREE.SphereGeometry(0.07, 8, 6);
  const shipMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const ringMat = new THREE.LineBasicMaterial({ color: '#445' });
  const disposables: { dispose(): void }[] = [planetGeo, shipGeo, shipMat, ringMat, sun.geometry, sun.material as THREE.Material];

  const planets = new Map<string, { mesh: THREE.Mesh; target: THREE.Vector3 }>();
  const ships = new THREE.Group();
  scene.add(ships);

  // Plane mapping: orbital (x, y) -> scene (x, z).
  const toScene = (p: { x: number; y: number }) => new THREE.Vector3(p.x * SCALE, 0, p.y * SCALE);

  const update = (s: Snapshot): void => {
    s.planets.forEach((p, i) => {
      let entry = planets.get(p.planet);
      if (!entry) {
        const mat = new THREE.MeshBasicMaterial({ color: PLANET_COLORS[i % PLANET_COLORS.length] ?? '#fff' });
        const mesh = new THREE.Mesh(planetGeo, mat);
        const pos = toScene(planetXY(p, i, s.cycle, s.cycle));
        mesh.position.copy(pos);
        scene.add(mesh);
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, k) => {
            const a = (k / 96) * Math.PI * 2;
            const r = orbitOf(p.planet, i).radius * SCALE;
            return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
          })),
          ringMat,
        );
        scene.add(ring);
        disposables.push(mat, ring.geometry);
        entry = { mesh, target: pos.clone() };
        planets.set(p.planet, entry);
      }
      entry.target.copy(toScene(planetXY(p, i, s.cycle, s.cycle)));
    });
    ships.clear();
    for (const sh of s.shipments) {
      const xy = sh.status === 'in_flight' ? shipmentXY(sh, s.planets, s.cycle) : null;
      if (!xy) continue;
      const dot = new THREE.Mesh(shipGeo, shipMat);
      dot.position.copy(toScene(xy));
      ships.add(dot);
    }
  };

  const resize = (): void => {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 300;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let raf = 0;
  const loop = (): void => {
    for (const { mesh, target } of planets.values()) mesh.position.lerp(target, 0.15);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  loop();

  return {
    update,
    dispose: () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export function Scene3D({ snapshot }: { snapshot: Snapshot | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<SceneApi | null>(null);
  const latest = useRef(snapshot);
  latest.current = snapshot;

  useEffect(() => {
    if (!ref.current) return;
    try {
      api.current = createScene(ref.current);
    } catch {
      return; // no WebGL
    }
    if (latest.current) api.current.update(latest.current);
    return () => {
      api.current?.dispose();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    if (snapshot) api.current?.update(snapshot);
  }, [snapshot]);

  return (
    <div>
      <div ref={ref} className="scene" />
      <div className="legend">
        {snapshot?.planets.map((p, i) => (
          <span key={p.planet}><i style={{ background: PLANET_COLORS[i % PLANET_COLORS.length] }} /> {p.planet}</span>
        ))}
        <span><i style={{ background: '#fff' }} /> shipment</span>
      </div>
    </div>
  );
}
