import { hashString, noise3 } from '../scene/planet-look';
import { clamp, distToSegment, makeRng, smoothstep } from './rng';

/**
 * Terrain shaped by what a planet makes (Phase 6). Pure: given the plain rolling ground, it decides where the mines,
 * fields, lakes, pads and ice go, and how they change the height. Phase 8 puts industry buildings on `sites`; trees
 * stay off every footprint.
 */

export type SiteKind = 'mine' | 'refinery' | 'farm' | 'pump' | 'forge';

/** A spot where an industry building stands. Heights are filled in once the whole terrain is known. */
export interface TerrainSite {
  id: string;
  kind: SiteKind;
  /** The good this site makes: iron, fuel, grain, water or tools. */
  good: string;
  x: number;
  z: number;
  /** Ground height at the site (the pit floor for a mine). */
  y: number;
  /** Level ground around the site is at least this wide. */
  radius: number;
  /** Heading the site looks along, radians; the direction is (sin, cos). Mines and farms face the plaza, pumps the lake. */
  facing: number;
}

/** A terraced open-cast pit: rings of steps down to a flat floor. */
export interface Pit {
  id: string;
  x: number;
  z: number;
  radius: number;
  depth: number;
  /** Ground height at the rim (the pit steps down from here). */
  rim: number;
  /** Number of terraces, floor included. */
  steps: number;
}

/** Level ground (refinery, forge, farmstead): the land is blended flat to `level`. */
export interface Pad {
  x: number;
  z: number;
  r: number;
  ramp: number;
  level: number;
}

/** A flat crop field: a rotated rectangle. Phase 10 grows and browns crops on these. */
export interface FieldPatch {
  id: string;
  farmId: string;
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  /** Turn about the vertical axis; the long side (`halfD`) runs along (sin, cos) of it. */
  rotY: number;
  y: number;
  /** 0 to 1, picks the crop colour. */
  crop: number;
}

/** A round, slightly irregular lake. The water surface is at `level`, a little below the flat shore at `rim`. */
export interface Lake {
  id: string;
  x: number;
  z: number;
  radius: number;
  rim: number;
  level: number;
  depth: number;
  frozen: boolean;
  seed: number;
}

export interface RiverPoint {
  x: number;
  z: number;
  /** Water surface height here. Never rises going downstream. */
  y: number;
  /** Half width of the channel here, metres. */
  half: number;
}

/** A river leaving a lake, narrowing to a marsh. */
export interface River {
  id: string;
  points: RiverPoint[];
  depth: number;
}

export interface IceSheet {
  x: number;
  z: number;
  r: number;
  ramp: number;
  level: number;
}

/** A low, rough pressure ridge of ice. */
export interface Ridge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  height: number;
  width: number;
  seed: number;
}

export interface Footprint {
  x: number;
  z: number;
  r: number;
  /** Footprints of one cluster (a farmstead and its fields) share a group and may touch. */
  group?: string;
}

export interface FeatureSet {
  icy: boolean;
  sites: TerrainSite[];
  fields: FieldPatch[];
  pits: Pit[];
  pads: Pad[];
  lakes: Lake[];
  rivers: River[];
  sheets: IceSheet[];
  ridges: Ridge[];
  /** Everything that must stay clear of trees and other things (circles). Rivers are handled separately. */
  footprints: Footprint[];
}

export interface PlanInput {
  planet: string;
  goods: string[];
  /** Height of the plain ground (hills and mountains) before any features. */
  baseHeight: (x: number, z: number) => number;
  /** Terrain is flat out to here; features keep outside it. */
  flatRadius: number;
  /** Where the mountain ring starts, so rivers can stop before it. */
  mountainStart: number;
}

/** Tethys is an ice world; any other planet we know nothing about is icy one time in four. */
export function isIcyPlanet(planet: string): boolean {
  if (planet === 'tethys') return true;
  if (planet === 'verdan' || planet === 'helion') return false;
  return hashString(`${planet}:ice`) % 4 === 0;
}

/** Iron worlds have taller mountains, closer in. */
export function reliefForGoods<R extends { mountains: number; mountainStart: number }>(relief: R, goods: string[] | undefined): R {
  if (!goods?.includes('iron')) return relief;
  return { ...relief, mountains: relief.mountains * 1.3, mountainStart: relief.mountainStart * 0.7 };
}

const TAU = Math.PI * 2;
const PIT_STEPS = 4;
const LAKE_WIDEST = 1.28;
/** Heading from (x, z) towards (tx, tz), for a direction of (sin, cos). */
const headingTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

/** The lake's radius in the given direction (so it is not a perfect circle). */
export function lakeRadiusAt(lake: Pick<Lake, 'radius' | 'seed'>, angle: number): number {
  return lake.radius * (1 + 0.28 * (2 * noise3(Math.cos(angle) * 1.6, 0.5, Math.sin(angle) * 1.6, lake.seed) - 1));
}

/** Distance from the lake centre in units of the lake's own radius there: below ~1 is water, 1 to 1.35 flat shore. */
export function lakeUnits(lake: Lake, x: number, z: number): number {
  const dx = x - lake.x;
  const dz = z - lake.z;
  return Math.hypot(dx, dz) / lakeRadiusAt(lake, Math.atan2(dx, dz));
}

/** Where a river's centreline is nearest to a point: distance, and the interpolated water height and half width there. */
export function nearestRiver(river: River, x: number, z: number): { dist: number; y: number; half: number } {
  let best = { dist: Infinity, y: 0, half: 0 };
  for (let i = 0; i < river.points.length - 1; i++) {
    const a = river.points[i]!;
    const b = river.points[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 === 0 ? 0 : clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
    const dist = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
    if (dist < best.dist) best = { dist, y: a.y + (b.y - a.y) * t, half: a.half + (b.half - a.half) * t };
  }
  return best;
}

/** How much of a rectangle-shaped patch covers a point: local coordinates u (across) and v (along the long side). */
export function fieldLocal(f: Pick<FieldPatch, 'x' | 'z' | 'rotY'>, x: number, z: number): { u: number; v: number } {
  const dx = x - f.x;
  const dz = z - f.z;
  const s = Math.sin(f.rotY);
  const c = Math.cos(f.rotY);
  return { u: dx * c - dz * s, v: dx * s + dz * c };
}

/** Pit ground height for one terrace profile: stepped from the rim level down to the floor, with short risers. */
function terraceLevel(pit: Pit, d: number): number {
  const t = clamp(1 - d / pit.radius, 0, 1);
  const k = Math.min(PIT_STEPS - 1, Math.floor(t * PIT_STEPS));
  const riser = k < PIT_STEPS - 1 ? smoothstep(0.82, 1, t * PIT_STEPS - k) : 0;
  return pit.rim - pit.depth * (Math.min(PIT_STEPS - 1, k + riser) / (PIT_STEPS - 1));
}

const flatten = (h: number, level: number, weight: number) => h + (level - h) * weight;

/** The final ground height at a point: plain ground `base` changed by every feature. */
export function applyFeatures(set: FeatureSet, x: number, z: number, base: number): number {
  let h = base;
  for (const lake of set.lakes) {
    const dn = lakeUnits(lake, x, z);
    if (dn > 2.3) continue;
    h = flatten(h, lake.rim, 1 - smoothstep(1.35, 2.3, dn)) - lake.depth * (1 - smoothstep(0.7, 1.15, dn));
  }
  for (const river of set.rivers) {
    const n = nearestRiver(river, x, z);
    const w = n.half * 2;
    if (n.dist > w * 1.5) continue;
    const bed = n.y - river.depth * 0.35;
    h = flatten(h, Math.min(h, bed), 1 - smoothstep(n.half, w * 1.5, n.dist));
  }
  for (const r of set.ridges) {
    const d = distToSegment(x, z, r.ax, r.az, r.bx, r.bz);
    if (d > r.width) continue;
    h += r.height * (1 - smoothstep(0, r.width, d)) * (0.65 + 0.7 * noise3(x / 9, 2, z / 9, r.seed));
  }
  for (const s of set.sheets) h = flatten(h, s.level, 1 - smoothstep(s.r, s.r + s.ramp, Math.hypot(x - s.x, z - s.z)));
  for (const p of set.pads) h = flatten(h, p.level, 1 - smoothstep(p.r, p.r + p.ramp, Math.hypot(x - p.x, z - p.z)));
  for (const f of set.fields) {
    const { u, v } = fieldLocal(f, x, z);
    const out = Math.max(Math.abs(u) - f.halfW, Math.abs(v) - f.halfD);
    if (out < 10) h = flatten(h, f.y, 1 - smoothstep(0, 10, out));
  }
  for (const pit of set.pits) {
    const d = Math.hypot(x - pit.x, z - pit.z);
    if (d > pit.radius * 1.25) continue;
    h = flatten(h, terraceLevel(pit, d), 1 - smoothstep(pit.radius * 0.9, pit.radius * 1.25, d));
  }
  return h;
}

/** How deep the water is above the ground at a point (0 on dry land). */
export function waterDepth(set: FeatureSet, x: number, z: number, ground: number): number {
  let depth = 0;
  for (const lake of set.lakes) if (lakeUnits(lake, x, z) < 1.2) depth = Math.max(depth, lake.level - ground);
  for (const river of set.rivers) {
    const n = nearestRiver(river, x, z);
    if (n.dist < n.half) depth = Math.max(depth, n.y - ground);
  }
  return depth;
}

/**
 * Decides where everything goes. Seeded per planet and per good, so the same planet and goods always give the same
 * map. Spots are the flattest of a few dozen random tries, and never overlap each other.
 */
export function planFeatures(input: PlanInput): FeatureSet {
  const { planet, baseHeight, flatRadius } = input;
  const goods = new Set(input.goods);
  const icy = isIcyPlanet(planet);
  const set: FeatureSet = { icy, sites: [], fields: [], pits: [], pads: [], lakes: [], rivers: [], sheets: [], ridges: [], footprints: [] };

  const slopeAt = (x: number, z: number) => Math.hypot(baseHeight(x + 2, z) - baseHeight(x - 2, z), baseHeight(x, z + 2) - baseHeight(x, z - 2)) / 4;
  /** Roughness over a disc: the steepest of five samples. */
  const rugged = (x: number, z: number, r: number) => {
    let s = slopeAt(x, z);
    for (let k = 0; k < 4; k++) s = Math.max(s, slopeAt(x + Math.sin((k * TAU) / 4) * r * 0.7, z + Math.cos((k * TAU) / 4) * r * 0.7));
    return s;
  };
  const claim = (x: number, z: number, r: number, group?: string) => set.footprints.push({ x, z, r, group });
  const free = (x: number, z: number, r: number) => set.footprints.every((f) => Math.hypot(x - f.x, z - f.z) >= f.r + r + 6);

  /** The flattest free spot of 60 tries in the ring rMin..rMax. */
  const findSpot = (rng: () => number, rMin: number, rMax: number, radius: number): { x: number; z: number } | null => {
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < 60; i++) {
      const a = rng() * TAU;
      const d = rMin + (rMax - rMin) * rng();
      const x = Math.sin(a) * d;
      const z = Math.cos(a) * d;
      if (!free(x, z, radius)) continue;
      const score = rugged(x, z, radius);
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best;
  };

  const addPad = (x: number, z: number, r: number, ramp: number, group?: string) => {
    set.pads.push({ x, z, r, ramp, level: baseHeight(x, z) });
    claim(x, z, r + ramp * 0.6, group);
  };
  const addSite = (kind: SiteKind, good: string, x: number, z: number, radius: number, facing: number) => {
    const n = set.sites.filter((s) => s.kind === kind).length;
    set.sites.push({ id: `${kind}:${n}`, kind, good, x, z, y: 0, radius, facing });
  };
  const rngFor = (tag: string) => makeRng(hashString(`${planet}:${tag}`));

  // Iron: terraced pits in the foothills.
  if (goods.has('iron')) {
    const rng = rngFor('iron');
    for (let i = 0; i < 2; i++) {
      const radius = 24 + rng() * 6;
      const depth = 7 + rng() * 3;
      const spot = findSpot(rng, flatRadius + 25, flatRadius + 115, radius * 1.3);
      if (!spot) continue;
      const rim = baseHeight(spot.x, spot.z);
      const id = `pit:${i}`;
      set.pits.push({ id, x: spot.x, z: spot.z, radius, depth, rim, steps: PIT_STEPS });
      claim(spot.x, spot.z, radius * 1.3);
      addSite('mine', 'iron', spot.x, spot.z, radius / PIT_STEPS, headingTo(spot.x, spot.z, 0, 0));
    }
  }
  // Fuel: a refinery on a levelled pad.
  if (goods.has('fuel')) {
    const rng = rngFor('fuel');
    const spot = findSpot(rng, flatRadius + 20, flatRadius + 75, 36);
    if (spot) {
      addPad(spot.x, spot.z, 22, 14);
      addSite('refinery', 'fuel', spot.x, spot.z, 22, headingTo(spot.x, spot.z, 0, 0));
    }
  }
  // Tools: a forge on a levelled pad.
  if (goods.has('tools')) {
    const rng = rngFor('tools');
    const spot = findSpot(rng, flatRadius + 15, flatRadius + 70, 28);
    if (spot) {
      addPad(spot.x, spot.z, 16, 10);
      addSite('forge', 'tools', spot.x, spot.z, 16, headingTo(spot.x, spot.z, 0, 0));
    }
  }
  // Grain: farmsteads, each with two or three flat fields round it.
  if (goods.has('grain')) {
    const rng = rngFor('grain');
    for (let i = 0; i < 2; i++) {
      const spot = findSpot(rng, flatRadius + 60, flatRadius + 120, 60);
      const nFields = 2 + (rng() < 0.5 ? 1 : 0);
      const spin = rng() * TAU;
      const sizes = Array.from({ length: 3 }, () => ({ hw: 12 + rng() * 5, hd: 16 + rng() * 6, crop: rng() }));
      if (!spot) continue;
      const farmId = `farm:${set.sites.filter((s) => s.kind === 'farm').length}`;
      addPad(spot.x, spot.z, 9, 8, farmId);
      addSite('farm', 'grain', spot.x, spot.z, 9, headingTo(spot.x, spot.z, 0, 0));
      for (let k = 0; k < nFields; k++) {
        const a = spin + (k * TAU) / nFields;
        const { hw, hd, crop } = sizes[k]!;
        const off = 9 + 3 + hd;
        const x = spot.x + Math.sin(a) * off;
        const z = spot.z + Math.cos(a) * off;
        set.fields.push({ id: `${farmId}:field:${k}`, farmId, x, z, halfW: hw, halfD: hd, rotY: a, y: baseHeight(x, z), crop });
        claim(x, z, Math.hypot(hw, hd) + 6, farmId);
      }
    }
  }
  // Water: an irregular lake (frozen on ice worlds) with pump sites on its shore, and, off ice worlds, a river.
  if (goods.has('water')) {
    const rng = rngFor('water');
    const radius = 24 + rng() * 8;
    const spot = findSpot(rng, flatRadius + 50, flatRadius + 110, radius * LAKE_WIDEST * 1.4);
    const swing = rng() - 0.5;
    const riverTurn = (rng() - 0.5) * 1.6;
    if (spot) {
      const rim = baseHeight(spot.x, spot.z);
      const lake: Lake = { id: 'lake:0', x: spot.x, z: spot.z, radius, rim, level: rim - 0.5, depth: 3.2, frozen: icy, seed: hashString(`${planet}:lake`) };
      set.lakes.push(lake);
      claim(spot.x, spot.z, radius * LAKE_WIDEST * 1.4);
      const toCity = headingTo(spot.x, spot.z, 0, 0);
      for (let k = 0; k < 2; k++) {
        const a = toCity + (k === 0 ? -0.45 : 0.9) + swing * 0.3;
        const edge = lakeRadiusAt(lake, a) * 1.25;
        const x = spot.x + Math.sin(a) * edge;
        const z = spot.z + Math.cos(a) * edge;
        addSite('pump', 'water', x, z, 7, headingTo(x, z, spot.x, spot.z));
      }
      if (!icy) planRiver(set, lake, spot, riverTurn, input, baseHeight);
    }
  }
  // Ice worlds: flat ice sheets and rough ridges.
  if (icy) {
    const rng = rngFor('ice');
    for (let i = 0; i < 3; i++) {
      const r = 20 + rng() * 14;
      const spot = findSpot(rng, flatRadius + 15, flatRadius + 130, r + 12);
      if (!spot) continue;
      set.sheets.push({ x: spot.x, z: spot.z, r, ramp: 12, level: baseHeight(spot.x, spot.z) });
      claim(spot.x, spot.z, r + 8);
    }
    for (let i = 0; i < 4; i++) {
      const a = rng() * TAU;
      const d = flatRadius + 15 + rng() * 140;
      const dir = rng() * TAU;
      const len = 45 + rng() * 40;
      const ax = Math.sin(a) * d;
      const az = Math.cos(a) * d;
      const bx = ax + Math.sin(dir) * len;
      const bz = az + Math.cos(dir) * len;
      const height = 2.5 + rng() * 2;
      const ok = [0, 0.5, 1].every((t) => free(ax + (bx - ax) * t, az + (bz - az) * t, 8) && Math.hypot(ax + (bx - ax) * t, az + (bz - az) * t) > flatRadius + 6);
      if (ok) set.ridges.push({ ax, az, bx, bz, height, width: 6, seed: hashString(`${planet}:ridge:${i}`) });
    }
  }
  return set;
}

/** A river leaving the lake and running round the plaza at about the same distance, wandering and narrowing to a marsh. */
function planRiver(set: FeatureSet, lake: Lake, spot: { x: number; z: number }, turn: number, input: PlanInput, baseHeight: (x: number, z: number) => number): void {
  const out = headingTo(0, 0, spot.x, spot.z);
  const STEP = 18;
  const START_HALF = 3.4;
  const seed = hashString(`${input.planet}:river`);

  const trace = (side: number, nudge: number): RiverPoint[] => {
    const points: RiverPoint[] = [];
    let heading = out + side * 1.2 + nudge;
    let x = spot.x + Math.sin(heading) * lakeRadiusAt(lake, heading) * 1.08;
    let z = spot.z + Math.cos(heading) * lakeRadiusAt(lake, heading) * 1.08;
    for (let i = 0; i < 18; i++) {
      const dn = Math.hypot(x, z);
      if (i > 0 && (dn > input.mountainStart + 20 || dn < input.flatRadius + 12)) break;
      const t = i / 17;
      // The surface follows the ground down and never rises; the first point sits at the lake's own level.
      const ground = applyFeatures(set, x, z, baseHeight(x, z));
      const y = i === 0 ? lake.level : Math.min(points[i - 1]!.y, ground - 0.5);
      points.push({ x, z, y, half: START_HALF * (1 - 0.65 * t) });
      // Wander, but keep circling the plaza (blend as vectors so angles wrap safely).
      const wander = (noise3(i * 0.7, 3, 0, seed) - 0.5) * 0.9 + turn * 0.2;
      const lean = headingTo(0, 0, x, z) + side * (Math.PI / 2 - 0.1) + wander;
      heading = Math.atan2(Math.sin(heading) * 0.55 + Math.sin(lean) * 0.45, Math.cos(heading) * 0.55 + Math.cos(lean) * 0.45);
      x += Math.sin(heading) * STEP;
      z += Math.cos(heading) * STEP;
    }
    return points;
  };
  /** How many of a river's points sit on top of something else (the lake itself aside). */
  const clashes = (pts: RiverPoint[]) => pts.filter((p) => set.footprints.some((f) => f.x !== lake.x && Math.hypot(p.x - f.x, p.z - f.z) < f.r + 6)).length;

  // Try both ways round and a few nudges; keep the one that clashes least (and runs longest).
  let best: RiverPoint[] = [];
  let bestScore = Infinity;
  for (const side of [1, -1]) {
    for (const nudge of [0, 0.3, -0.3]) {
      const pts = trace(side, nudge);
      const score = clashes(pts) * 100 - pts.length;
      if (pts.length >= 6 && score < bestScore) {
        bestScore = score;
        best = pts;
      }
    }
  }
  if (best.length >= 6) set.rivers.push({ id: 'river:0', points: best, depth: 1.8 });
}
