import * as THREE from 'three';

/** How one planet looks. The scene only asks for a look by planet id; swapping art later means changing this file. */
export interface PlanetLook {
  id: string;
  /** Scene units. */
  radius: number;
  /** Surface colors; faces pick among them by noise, so the planet gets patches (land, sea, ice, rock). */
  palette: string[];
  /** How lumpy the surface is, as a fraction of the radius. */
  roughness: number;
  seed: number;
  /** Radians per second. */
  spin: number;
  ring?: { color: string; inner: number; outer: number; tilt: number };
  atmosphere?: { color: string; opacity: number };
}

const KNOWN: Record<string, Omit<PlanetLook, 'id' | 'seed'>> = {
  // Helion mines iron and refines fuel: a rough, rusty rock.
  helion: { radius: 0.5, palette: ['#c2672f', '#a64b25', '#d6934f', '#7d3b20'], roughness: 0.16, spin: 0.25 },
  // Verdan farms grain and pumps water: green land, blue seas, a thin haze.
  verdan: { radius: 0.56, palette: ['#4b9a47', '#3a8240', '#2f6fae', '#86c45f'], roughness: 0.05, spin: 0.18, atmosphere: { color: '#5aa8ff', opacity: 0.3 } },
  // Tethys pumps water and forges tools: pale ice with a ring.
  tethys: {
    radius: 0.46, palette: ['#d4ebf5', '#a3cfe6', '#eef8fc', '#78b2d6'], roughness: 0.08, spin: 0.12,
    ring: { color: '#cfe6f2', inner: 1.4, outer: 1.85, tilt: 0.45 }, atmosphere: { color: '#bfe6ff', opacity: 0.26 },
  },
};

/** Small stable string hash, so a planet the scene has never heard of still gets the same look every time. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function genericLook(id: string): Omit<PlanetLook, 'id' | 'seed'> {
  const hue = (hashString(id) % 360) / 360;
  const shade = (dh: number, s: number, l: number) => `#${new THREE.Color().setHSL((hue + dh + 1) % 1, s, l).getHexString()}`;
  return { radius: 0.48, palette: [shade(0, 0.5, 0.5), shade(0.04, 0.45, 0.42), shade(-0.05, 0.5, 0.6), shade(0.08, 0.4, 0.35)], roughness: 0.12, spin: 0.2 };
}

const cache = new Map<string, PlanetLook>();

/** The look for a planet: hand-made for the default world's planets, generated from the id for any other. */
export function lookFor(planetId: string): PlanetLook {
  let look = cache.get(planetId);
  if (!look) {
    look = { id: planetId, seed: hashString(planetId), ...(KNOWN[planetId] ?? genericLook(planetId)) };
    cache.set(planetId, look);
  }
  return look;
}

// ---- Surface ---------------------------------------------------------------------------------------

/** Deterministic value in [0, 1) for a lattice point. */
function lattice(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Smooth 3D value noise in [0, 1). */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const [ix, iy, iz] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [fx, fy, fz] = [smooth(x - ix), smooth(y - iy), smooth(z - iz)];
  const at = (dx: number, dy: number, dz: number) => lattice(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), fx), lerp(at(0, 1, 0), at(1, 1, 0), fx), fy),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), fx), lerp(at(0, 1, 1), at(1, 1, 1), fx), fy),
    fz,
  );
}

/**
 * A low-poly planet of radius 1: a flat-shaded icosphere with a lumpy surface and each face colored from the palette.
 * Scale it to `look.radius`. Same look, same planet, every time.
 */
export function buildPlanetGeometry(look: PlanetLook): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 3).toNonIndexed();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const lump = noise3(v.x * 2.2 + 11, v.y * 2.2 + 11, v.z * 2.2 + 11, look.seed);
    v.multiplyScalar(1 + (lump - 0.5) * 2 * look.roughness);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  const colors = look.palette.map((c) => new THREE.Color(c));
  const out = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let f = 0; f < pos.count; f += 3) {
    a.fromBufferAttribute(pos, f);
    b.fromBufferAttribute(pos, f + 1);
    c.fromBufferAttribute(pos, f + 2);
    const centre = a.add(b).add(c).divideScalar(3).normalize();
    const n = noise3(centre.x * 1.6 + 5, centre.y * 1.6 + 5, centre.z * 1.6 + 5, look.seed + 7);
    const base = colors[Math.min(colors.length - 1, Math.floor(n * colors.length))]!;
    const jitter = 0.92 + lattice(f, f * 3, f * 7, look.seed) * 0.16; // each face a touch lighter or darker
    tint.copy(base).multiplyScalar(jitter);
    for (let k = 0; k < 3; k++) {
      out[(f + k) * 3] = tint.r;
      out[(f + k) * 3 + 1] = tint.g;
      out[(f + k) * 3 + 2] = tint.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geo;
}
