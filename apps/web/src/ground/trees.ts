import { hashString, noise3 } from '../scene/planet-look';
import type { CityLayout } from './city-layout';
import { makeRng } from './rng';
import type { HeightField } from './terrain';

export type TreeKind = 'broadleaf' | 'conifer' | 'scrub' | 'rock' | 'spire' | 'frostscrub';

export interface Species {
  kind: TreeKind;
  /** Share of the planet's plants. */
  weight: number;
  minScale: number;
  maxScale: number;
}

export interface TreeInstance {
  kind: TreeKind;
  x: number;
  y: number;
  z: number;
  /** Uniform size multiplier. */
  scale: number;
  rotY: number;
  /** Random shade, 0 to 1, for a little colour variety. */
  tint: number;
}

/** What grows on each planet. Other planets get a mix picked from their id. */
const SPECIES: Record<string, { density: number; species: Species[] }> = {
  verdan: {
    density: 0.5,
    species: [
      { kind: 'broadleaf', weight: 0.6, minScale: 0.8, maxScale: 1.5 },
      { kind: 'conifer', weight: 0.4, minScale: 0.9, maxScale: 1.7 },
    ],
  },
  helion: {
    density: 0.3,
    species: [
      { kind: 'scrub', weight: 0.65, minScale: 0.6, maxScale: 1.3 },
      { kind: 'rock', weight: 0.35, minScale: 0.6, maxScale: 2.4 },
    ],
  },
  // Ice spires, and hardy amber scrub clinging to the frozen ground.
  tethys: {
    density: 0.5,
    species: [
      { kind: 'spire', weight: 0.55, minScale: 0.7, maxScale: 1.8 },
      { kind: 'frostscrub', weight: 0.45, minScale: 0.6, maxScale: 1.4 },
    ],
  },
};

/** What grows on a planet, with a rough density (chance a spot gets a plant, before the patchy forest noise). */
export function speciesFor(planet: string): { density: number; species: Species[] } {
  const known = SPECIES[planet];
  if (known) return known;
  const h = hashString(planet);
  const pick = h % 3;
  if (pick === 0) return SPECIES.verdan!;
  if (pick === 1) return SPECIES.helion!;
  return SPECIES.tethys!;
}

export interface ScatterOptions {
  planet: string;
  seed?: number;
  /** Hard cap on how many plants. */
  max?: number;
  /** Plants stay out beyond this distance from the plaza. */
  outerRadius?: number;
  /** Steepest ground (rise over run) a plant will grow on. */
  maxSlope?: number;
  /** Highest ground a plant will grow on. */
  treeLine?: number;
}

export const MAX_TREES = 3000;
const CELL = 8;

/**
 * Scatters plants over the land with a seeded jittered grid: none inside the city, on or beside a road, on steep slopes
 * above the tree line, or on mines, fields, pads and water. Forest comes in patches. Same planet, same trees.
 */
export function scatterTrees(terrain: HeightField & { slopeAt: (x: number, z: number) => number; siteClearance?: (x: number, z: number) => number }, layout: CityLayout, options: ScatterOptions): TreeInstance[] {
  const { density, species } = speciesFor(options.planet);
  const seed = hashString(`${options.planet}:trees`) ^ (options.seed ?? 0);
  const rng = makeRng(seed);
  const outer = options.outerRadius ?? 380;
  const maxSlope = options.maxSlope ?? 0.5;
  const treeLine = options.treeLine ?? 28;
  const max = options.max ?? MAX_TREES;
  const innerClear = layout.radius + 8;
  const total = species.reduce((s, sp) => s + sp.weight, 0);

  const out: TreeInstance[] = [];
  const cells = Math.ceil(outer / CELL);
  for (let j = -cells; j <= cells; j++) {
    for (let i = -cells; i <= cells; i++) {
      // Draw the same numbers for every cell so rejecting one never shifts the others.
      const jx = rng();
      const jz = rng();
      const roll = rng();
      const pickRoll = rng() * total;
      const sizeRoll = rng();
      const rot = rng() * Math.PI * 2;
      const tint = rng();
      const x = (i + jx) * CELL;
      const z = (j + jz) * CELL;
      const d = Math.hypot(x, z);
      if (d < innerClear || d > outer) continue;
      const patch = noise3(x / 60, 1.5, z / 60, seed);
      if (roll > density * Math.min(1, Math.max(0, (patch - 0.3) * 2.2))) continue;
      if (layout.roadClearance(x, z) < 4) continue;
      const y = terrain.heightAt(x, z);
      if (y > treeLine || terrain.slopeAt(x, z) > maxSlope) continue;
      // Keep off pits, pads, fields, lakes and rivers (and a little margin round them).
      if (terrain.siteClearance && terrain.siteClearance(x, z) < 3) continue;
      let acc = 0;
      let sp = species[species.length - 1]!;
      for (const s of species) {
        acc += s.weight;
        if (pickRoll <= acc) {
          sp = s;
          break;
        }
      }
      out.push({ kind: sp.kind, x, y, z, scale: sp.minScale + (sp.maxScale - sp.minScale) * sizeRoll, rotY: rot, tint });
    }
  }
  if (out.length <= max) return out;
  // Too many: keep a seeded random subset, so thinning is even across the land.
  for (let i = out.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [out[i], out[k]] = [out[k]!, out[i]!];
  }
  return out.slice(0, max);
}
