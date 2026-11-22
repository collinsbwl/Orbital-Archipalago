import * as THREE from 'three';
import { initialBoom, squashScale, stepBoom } from './boom';

const CAMERA_BASE = new THREE.Vector3(0, 2.2, 15);
const LOOK_AT = new THREE.Vector3(0, 0.4, 0);

const mat = (color: number) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });

/** Roughens a geometry with a position-hashed offset, so duplicate seam vertices move together and no cracks open. */
function jitter(geo: THREE.BufferGeometry, amount: number, keepAbove: number): THREE.BufferGeometry {
  const p = geo.attributes.position as THREE.BufferAttribute;
  const fract = (v: number) => v - Math.floor(v);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y > keepAbove) continue;
    const n = fract(Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453);
    const m = fract(Math.sin(x * 93.989 + y * 67.345 + z * 11.13) * 24634.6345);
    p.setXYZ(i, x + (n - 0.5) * amount, y + (n - m) * amount * 0.5, z + (m - 0.5) * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

function buildIsland(): THREE.Group {
  const island = new THREE.Group();
  island.add(new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.25, 0.45, 11), mat(0x6cc25a)));
  const dirt = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.0, 0.4, 11), mat(0x8b5a3c));
  dirt.position.y = -0.42;
  island.add(dirt);
  const rock = new THREE.Mesh(jitter(new THREE.ConeGeometry(2.0, 2.8, 11, 3), 0.35, 1.3), mat(0x6b4a37));
  rock.rotation.x = Math.PI;
  rock.position.y = -2.02;
  island.add(rock);

  const tree = (x: number, z: number, s: number) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.45, 5), mat(0x6b4630));
    trunk.position.y = 0.45;
    const low = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 6), mat(0x2f7d4f));
    low.position.y = 0.95;
    const high = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.7, 6), mat(0x3a9460));
    high.position.y = 1.35;
    g.add(trunk, low, high);
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    island.add(g);
  };
  tree(-1.1, -0.6, 1.1);
  tree(-0.4, -1.3, 0.85);
  tree(1.3, -0.9, 0.95);
  tree(0.9, 0.9, 0.7);

  const boulder = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), mat(0x9a948c));
  boulder.position.set(0.2, 0.35, 0.5);
  const pebble = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2, 0), mat(0xb0aaa0));
  pebble.position.set(-0.5, 0.3, 1.2);
  island.add(boulder, pebble);

  const hut = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.55), mat(0xe9dcc5));
  walls.position.y = 0.45;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.52, 0.45, 4), mat(0xd9643a));
  roof.position.y = 0.9;
  roof.rotation.y = Math.PI / 4;
  hut.add(walls, roof);
  hut.position.set(-0.2, 0, 0.1);
  hut.rotation.y = 0.5;
  island.add(hut);
  return island;
}

interface Dust { mesh: THREE.Mesh; v: THREE.Vector3; life: number }

/**
 * Draws the landing island into `canvas` and plays its entrance. Returns a function that stops the loop and frees the
 * GPU resources. Throws if WebGL is unavailable; the caller treats that as "no island".
 */
export function startIslandScene(canvas: HTMLCanvasElement): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);
  camera.position.copy(CAMERA_BASE);
  camera.lookAt(LOOK_AT);

  const resize = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 46 : 32; // a phone is tall and narrow: widen the view so the island fits
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);

  scene.add(new THREE.HemisphereLight(0xe6ecff, 0x3b2a22, 1.3));
  const sun = new THREE.DirectionalLight(0xfff1e0, 2.6);
  sun.position.set(5, 9, 7);
  const rim = new THREE.DirectionalLight(0x8ea2ff, 1.1);
  rim.position.set(-6, 2, -5);
  scene.add(sun, rim);

  const rig = new THREE.Group();
  const squash = new THREE.Group();
  const island = buildIsland();
  squash.add(island);
  rig.add(squash);
  scene.add(rig);

  const ringMat = new THREE.MeshBasicMaterial({ color: 0xf2ede4, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 72), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.5;
  scene.add(ring);
  let ringT = -1;

  const dustGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
  const dustMat = mat(0xcbb08a);
  const dust: Dust[] = Array.from({ length: 28 }, () => {
    const mesh = new THREE.Mesh(dustGeo, dustMat);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, v: new THREE.Vector3(), life: 0 };
  });
  const burst = (speed: number) => {
    dust.forEach((d, i) => {
      const a = (i / dust.length) * Math.PI * 2 + Math.random() * 0.3;
      d.mesh.position.set(Math.cos(a) * 2.3, -0.3, Math.sin(a) * 2.3);
      d.v.set(Math.cos(a) * (2 + Math.random() * 3), 3 + Math.random() * speed * 0.35, Math.sin(a) * (2 + Math.random() * 3));
      d.life = 1;
      d.mesh.visible = true;
      d.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    });
  };

  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const s = initialBoom(reduced);
  const clock = new THREE.Clock();
  let raf = 0;

  const tick = () => {
    const dt = Math.min(clock.getDelta(), 1 / 30);
    const impact = stepBoom(s, dt);
    if (impact !== null) {
      ringT = 0;
      burst(impact);
    }

    rig.visible = s.phase !== 'wait';
    rig.position.set(s.x, s.y, s.z);
    rig.scale.setScalar(s.scale);
    squash.scale.set(...squashScale(s));
    island.rotation.y = s.rotY;
    island.rotation.z = s.phase === 'launch' ? Math.sin(s.t * 20) * 0.08 : 0;

    if (ringT >= 0) {
      ringT += dt;
      const r = ringT / 0.9;
      ring.scale.setScalar(2.4 + r * 5);
      ringMat.opacity = Math.max(0, 0.75 * (1 - r));
      if (r >= 1) ringT = -1;
    }
    for (const d of dust) {
      if (d.life <= 0) continue;
      d.v.y -= 18 * dt;
      d.mesh.position.addScaledVector(d.v, dt);
      d.mesh.rotation.x += dt * 4;
      d.life -= dt * 1.1;
      d.mesh.scale.setScalar(Math.max(0.001, d.life));
      if (d.life <= 0) d.mesh.visible = false;
    }

    camera.position.set(
      CAMERA_BASE.x + (Math.random() - 0.5) * s.shake,
      CAMERA_BASE.y + (Math.random() - 0.5) * s.shake,
      CAMERA_BASE.z,
    );
    camera.lookAt(LOOK_AT);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    renderer.dispose();
  };
}
