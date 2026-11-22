import * as THREE from 'three';
import { hashString, noise3 } from '../scene/planet-look';
import type { GroundLook } from './ground-look';
import { smoothstep } from './rng';
import { applyFeatures, fieldLocal, isIcyPlanet, lakeUnits, nearestRiver, planFeatures, reliefForGoods, waterDepth } from './terrain-features';
import type { FeatureSet, FieldPatch, Footprint, Lake, River, TerrainSite } from './terrain-features';

export type { FeatureSet, FieldPatch, Lake, River, TerrainSite } from './terrain-features';

/** Anything that can say how high the ground is. Trees, camera and props only need this. */
export interface HeightField {
  heightAt: (x: number, z: number) => number;
}

export interface TerrainOptions {
  planet: string;
  /** Goods the planet makes. Shapes the land: iron gets pits and taller mountains, grain fields, water a lake and river, and so on. */
  goods?: string[];
  /** Not used yet; the city may claim more flat land as it grows. */
  population?: number;
  /** Ground is dead flat (height 0) out to this distance from the plaza. */
  flatRadius: number;
  /** Where mines, fields and lakes are placed out from (default `flatRadius`). */
  siteRadius?: number;
  /** Width of the smooth ramp from flat ground up to the hills. */
  rampWidth?: number;
  /** Hills and mountains, metres. Usually from the planet's look. */
  relief: GroundLook['relief'];
}

/** What covers the ground at a point, for colouring. `k` is how strongly (0 to 1); `shade` varies the tone. */
export interface Surface {
  kind: 'none' | 'field' | 'pad' | 'pit' | 'bed' | 'shore' | 'ice';
  k: number;
  shade: number;
}

export interface Terrain extends HeightField {
  options: TerrainOptions;
  /** The relief actually used (iron worlds get taller, closer mountains than the planet's look says). */
  relief: GroundLook['relief'];
  /** Rise over run of the ground at a point. */
  slopeAt: (x: number, z: number) => number;
  /** Everything the goods put on the land: pits, pads, fields, lakes, rivers, ice. */
  features: FeatureSet;
  /** Where industry buildings stand (Phase 8), with their ground height. */
  sites: TerrainSite[];
  /** Crop fields (Phase 10 grows crops on these). */
  fields: FieldPatch[];
  lakes: Lake[];
  rivers: River[];
  /** Metres of water above the ground at a point; 0 on dry land. */
  waterDepthAt: (x: number, z: number) => number;
  /** Space between a point and the nearest feature (pit, pad, field, lake, river, ice sheet); negative inside one. Trees stay off it. */
  siteClearance: (x: number, z: number) => number;
  /** Ground cover for colouring. */
  surfaceAt: (x: number, z: number) => Surface;
}

/** Layered noise in about [0, 1). */
function fbm(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * f, 3.7 * i, z * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Builds the height function for one planet: flat city ground, a smooth ramp, rolling hills, a ring of mountains, then the goods' features. */
export function makeTerrain(options: TerrainOptions): Terrain {
  const seed = hashString(`${options.planet}:terrain`);
  const ramp = options.rampWidth ?? 60;
  const relief = reliefForGoods(options.relief, options.goods);
  const { hills, hillScale, mountains, mountainStart } = relief;

  /** The plain ground: city flat, hills, mountain ring. */
  const baseAt = (x: number, z: number): number => {
    const d = Math.hypot(x, z);
    if (d <= options.flatRadius) return 0;
    const open = smoothstep(options.flatRadius, options.flatRadius + ramp, d);
    const rolling = (fbm(x / hillScale, z / hillScale, seed, 3) - 0.5) * 2 * hills;
    // The mountain ring: rises from `mountainStart`, taller where the ridge noise is high, never a smooth wall.
    const rise = smoothstep(mountainStart, mountainStart + 130, d);
    const ridge = fbm(x / 70 + 40, z / 70 + 40, seed + 99, 3);
    const peaks = rise * mountains * (0.25 + 1.5 * ridge * ridge);
    return rolling * open + peaks;
  };

  const goods = options.goods ?? [];
  const features = planFeatures({ planet: options.planet, goods, baseHeight: baseAt, flatRadius: options.flatRadius, siteRadius: options.siteRadius, mountainStart });
  const hasFeatures = features.footprints.length > 0 || features.rivers.length > 0;
  const heightAt = (x: number, z: number): number => {
    const base = baseAt(x, z);
    return hasFeatures ? applyFeatures(features, x, z, base) : base;
  };
  const slopeAt = (x: number, z: number): number => {
    const e = 2;
    const dx = heightAt(x + e, z) - heightAt(x - e, z);
    const dz = heightAt(x, z + e) - heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  };

  const sites = features.sites.map((s) => ({ ...s, y: heightAt(s.x, s.z) }));
  const fields = features.fields;
  const waterDepthAt = (x: number, z: number) => (features.lakes.length || features.rivers.length ? waterDepth(features, x, z, heightAt(x, z)) : 0);

  const siteClearance = (x: number, z: number): number => {
    let best = Infinity;
    for (const f of features.footprints as Footprint[]) best = Math.min(best, Math.hypot(x - f.x, z - f.z) - f.r);
    for (const r of features.rivers) {
      const n = nearestRiver(r, x, z);
      best = Math.min(best, n.dist - (n.half + 4));
    }
    return best;
  };

  const surfaceAt = (x: number, z: number): Surface => {
    const none: Surface = { kind: 'none', k: 0, shade: 0 };
    if (!hasFeatures) return none;
    const h = heightAt(x, z);
    const wet = waterDepth(features, x, z, h);
    if (wet > 0) return features.icy ? { kind: 'ice', k: 1, shade: 0.5 } : { kind: 'bed', k: Math.min(1, 0.45 + wet / 1.5), shade: 0 };
    for (const lake of features.lakes) {
      const dn = lakeUnits(lake, x, z);
      if (dn < 1.3) return { kind: 'shore', k: 1 - smoothstep(1.15, 1.3, dn), shade: 0 };
    }
    for (const pit of features.pits) {
      const d = Math.hypot(x - pit.x, z - pit.z);
      if (d < pit.radius * 1.2) {
        const t = Math.min(1, Math.max(0, 1 - d / pit.radius));
        return { kind: 'pit', k: 1 - smoothstep(pit.radius * 1.0, pit.radius * 1.2, d), shade: Math.min(pit.steps - 1, Math.floor(t * pit.steps)) / (pit.steps - 1) };
      }
    }
    for (const f of features.fields) {
      const { u, v } = fieldLocal(f, x, z);
      const out = Math.max(Math.abs(u) - f.halfW, Math.abs(v) - f.halfD);
      if (out < 1.5) return { kind: 'field', k: 1 - smoothstep(0, 1.5, out), shade: f.crop + (Math.floor(u / 3) & 1) * 0.5 };
    }
    for (const s of features.sheets) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < s.r + s.ramp * 0.5) return { kind: 'ice', k: 1 - smoothstep(s.r * 0.85, s.r + s.ramp * 0.5, d), shade: 0 };
    }
    for (const p of features.pads) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r + 2) return { kind: 'pad', k: 1 - smoothstep(p.r * 0.9, p.r + 2, d), shade: 0 };
    }
    return none;
  };

  return { options, relief, heightAt, slopeAt, features, sites, fields, lakes: features.lakes, rivers: features.rivers, waterDepthAt, siteClearance, surfaceAt };
}

export { isIcyPlanet };

export interface TerrainMeshData {
  /** Three numbers per vertex; every three vertices are one flat triangle. */
  positions: Float32Array;
  /** One colour per vertex (every face's three vertices share a colour). */
  colors: Float32Array;
}

export interface TerrainMeshOptions {
  /** Half the width of the square ground, metres. */
  half: number;
  /** Cells along one side. */
  segments: number;
}

/**
 * Samples the terrain into flat triangles coloured by height and steepness: palette patches on open ground, rock on
 * steep slopes and high flanks, the peak colour on the tops.
 */
export function buildTerrainData(terrain: Terrain, look: GroundLook, mesh: TerrainMeshOptions): TerrainMeshData {
  const { half, segments: n } = mesh;
  const step = (2 * half) / n;
  const seed = hashString(`${terrain.options.planet}:colors`);
  const palette = look.palette.map((c) => new THREE.Color(c));
  const rock = new THREE.Color(look.rock);
  const peak = new THREE.Color(look.peak);
  const mountainTop = terrain.relief.mountains;

  const grid = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) grid[j * (n + 1) + i] = terrain.heightAt(-half + i * step, -half + j * step);

  const positions = new Float32Array(n * n * 6 * 3);
  const colors = new Float32Array(n * n * 6 * 3);
  const tint = new THREE.Color();
  let o = 0;

  const face = (a: number, b: number, c: number, ia: number, ib: number, ic: number, ja: number, jb: number, jc: number) => {
    const xs = [-half + ia * step, -half + ib * step, -half + ic * step];
    const zs = [-half + ja * step, -half + jb * step, -half + jc * step];
    const ys = [a, b, c];
    // Steepness from the face's own normal.
    const ux = xs[1]! - xs[0]!, uy = ys[1]! - ys[0]!, uz = zs[1]! - zs[0]!;
    const vx = xs[2]! - xs[0]!, vy = ys[2]! - ys[0]!, vz = zs[2]! - zs[0]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const steep = 1 - Math.abs(ny) / Math.hypot(nx, ny, nz);
    const cx = (xs[0]! + xs[1]! + xs[2]!) / 3, cz = (zs[0]! + zs[1]! + zs[2]!) / 3;
    const h = (ys[0]! + ys[1]! + ys[2]!) / 3;

    const patch = noise3(cx / 40, 0, cz / 40, seed);
    tint.copy(palette[Math.min(palette.length - 1, Math.floor(patch * palette.length))]!);
    const rockiness = Math.max(smoothstep(0.18, 0.4, steep), smoothstep(mountainTop * 0.2, mountainTop * 0.55, h));
    tint.lerp(rock, rockiness);
    tint.lerp(peak, smoothstep(mountainTop * 0.6, mountainTop * 0.95, h));
    applySurface(tint, terrain.surfaceAt(cx, cz), rock);
    const jitter = 0.93 + noise3(cx * 0.9, 5, cz * 0.9, seed + 3) * 0.14;
    tint.multiplyScalar(jitter);

    for (let k = 0; k < 3; k++) {
      positions[o] = xs[k]!;
      positions[o + 1] = ys[k]!;
      positions[o + 2] = zs[k]!;
      colors[o] = tint.r;
      colors[o + 1] = tint.g;
      colors[o + 2] = tint.b;
      o += 3;
    }
  };

  const H = (i: number, j: number) => grid[j * (n + 1) + i]!;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Counter-clockwise seen from above, so faces point up.
      face(H(i, j), H(i, j + 1), H(i + 1, j), i, i, i + 1, j, j + 1, j);
      face(H(i + 1, j), H(i, j + 1), H(i + 1, j + 1), i + 1, i, i + 1, j, j + 1, j + 1);
    }
  }
  return { positions, colors };
}

const CROPS = ['#86b64e', '#c9b24c', '#6f9a3e', '#9a7a42'];
const SURFACE_COLORS = { pad: '#9a9a96', shore: '#cfc39a', bed: '#5d5c48', ice: '#d6f0fb', pitDark: '#3a2a24' };
const scratch = new THREE.Color();
const dark = new THREE.Color();

/** Blends the ground colour towards what covers it: crops, pit rock, concrete pads, lake beds, shore sand, ice. */
function applySurface(tint: THREE.Color, s: Surface, rock: THREE.Color): void {
  if (s.kind === 'none' || s.k <= 0) return;
  switch (s.kind) {
    case 'field': {
      scratch.set(CROPS[Math.floor(s.shade) % CROPS.length]!);
      scratch.multiplyScalar(s.shade % 1 >= 0.5 ? 0.82 : 1);
      break;
    }
    case 'pit':
      scratch.copy(rock).lerp(dark.set(SURFACE_COLORS.pitDark), 0.35 + 0.45 * s.shade);
      break;
    case 'pad':
      scratch.set(SURFACE_COLORS.pad);
      break;
    case 'shore':
      scratch.set(SURFACE_COLORS.shore);
      break;
    case 'bed':
      scratch.set(SURFACE_COLORS.bed);
      break;
    case 'ice':
      scratch.set(SURFACE_COLORS.ice);
      break;
  }
  tint.lerp(scratch, s.k);
}

/** Lifts a camera height so it stays at least `margin` above the ground at its spot. */
export function aboveGround(field: HeightField, x: number, z: number, y: number, margin: number): number {
  return Math.max(y, field.heightAt(x, z) + margin);
}

