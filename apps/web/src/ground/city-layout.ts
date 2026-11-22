import { hashString } from '../scene/planet-look';
import { clamp, distToSegment, makeRng } from './rng';

/** Sizes in metres. The plaza is at the origin; roads run out from it like spokes. */
export const PLAZA_RADIUS = 9;
export const ROAD_WIDTH = 7;
export const SIDEWALK_WIDTH = 1.6;
/** Buildings stand inside this distance from the plaza. */
export const CITY_RADIUS = 58;
/** Roads run a little past the last building, out to open ground. */
export const ROAD_LENGTH = CITY_RADIUS + 14;
/** Terrain stays flat out to here, so the city and road ends sit on level ground. */
export const CITY_FLAT_RADIUS = 100;
/** Gap between building rings (and between slots round a ring). A ring street runs down the middle of each gap. */
const RING_STEP = 12;
/** Radius of the innermost building ring. */
const INNER_RING = PLAZA_RADIUS + 9;
/** Spacing of slots round a ring, metres. */
const SLOT_STEP = 11;
/** Ring streets: a narrow road with a sidewalk each side, so 5 m across all told. */
export const RING_STREET_ROAD = 3.4;
export const RING_STREET_SIDEWALK = 0.8;
const RING_STREET_HALF = RING_STREET_ROAD / 2 + RING_STREET_SIDEWALK;
/** Roughly how many building floors fit in a height, for window rows (Phase 12). */
export const FLOOR_HEIGHT = 3.2;
/** Tiers over which the city fills in: below `GROWTH_START` it is a hamlet, from `GROWTH_FULL` up every ring is built. */
export const GROWTH_START = 2;
export const GROWTH_FULL = 10;
/** Each ring out starts to fill this many tiers after the one inside it (a tier is about 1.8 times the people). */
const RING_TIER_STEP = 3;

export interface CityOptions {
  planet: string;
  /** Goods the planet makes. Not used yet; Phase 8 picks industry buildings from it. */
  goods?: string[];
  /** Population. Sets how tall the buildings are (through a coarse tier, so the layout does not churn every cycle). */
  population?: number;
}

export interface Road {
  index: number;
  /** Heading in the ground plane, radians; `dir` is (sin, cos) of it. */
  angle: number;
  /** Unit direction out from the plaza, (x, z). */
  dir: [number, number];
  /** Unit sideways direction, (x, z). */
  side: [number, number];
  width: number;
  length: number;
  /** The far end, (x, z). */
  end: [number, number];
}

export type BuildingKind = 'residential' | 'commercial' | 'industrial';

export interface Building {
  /** Stable for a given planet, so later phases can add buildings without moving existing ones. */
  id: string;
  x: number;
  z: number;
  /** Footprint: width across, depth along the radial direction. */
  w: number;
  d: number;
  h: number;
  /** Turn about the vertical axis. */
  rotY: number;
  kind: BuildingKind;
  /** Which colour from the planet's building palette. */
  paletteIndex: number;
  /** Which ring round the plaza (0 is innermost). */
  ring: number;
  /** The building exists once the population tier reaches this. Fixed for the building, so growth only ever adds. */
  tierMin: number;
}

/** A street running right round the plaza at one radius. */
export interface RingStreet {
  index: number;
  radius: number;
  /** Road width; the sidewalks add `sidewalk` on each side. */
  width: number;
  sidewalk: number;
  /** The street exists once the population tier reaches this. */
  tierMin: number;
}

/** A closed path people walk round. */
export interface Loop {
  points: [number, number][];
  /** Total length, metres. */
  length: number;
  /** Distance along the loop at each point (the last entry is `length`). */
  cumulative: number[];
}

export interface CityLayout {
  options: CityOptions;
  /** The coarse population step the layout was built for. */
  tier: number;
  plazaRadius: number;
  /** Buildings stand inside this. */
  radius: number;
  /** Terrain should be flat out to this. */
  flatRadius: number;
  roads: Road[];
  /** Ring streets built so far at this tier. */
  ringStreets: RingStreet[];
  /** Buildings standing at this tier (more people, more buildings; never fewer). */
  buildings: Building[];
  /** How many buildings the full-grown city has, so renderers can size their instance buffers once. */
  capacity: number;
  /** Walkways: for each road, a loop out one sidewalk and back the other. */
  loops: Loop[];
  /** Where the crowd gathers and walks: closed paths the aliens use. Here, rings across the plaza between the fountain and the market stalls. */
  gatherLoops: Loop[];
  /** Distance from the point to the nearest radial road centreline (ring streets not counted). */
  distanceToRoad: (x: number, z: number) => number;
  /** Space between the point and the nearest road edge (sidewalk included, ring streets too); negative on a road. */
  roadClearance: (x: number, z: number) => number;
  /** True when the point is on the plaza, a road or a sidewalk, grown by `margin`. */
  onStreet: (x: number, z: number, margin?: number) => boolean;
}

/** A coarse step for population (about four per tenfold change), so small changes do not rebuild the city. */
export function populationTier(population: number | undefined): number {
  return Math.round(Math.log10(Math.max(1, population ?? 100_000)) * 4);
}

/** Closed loop through the points. */
export function makeLoop(points: [number, number][]): Loop {
  const cumulative = [0];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cumulative.push(total);
  }
  return { points, length: total, cumulative };
}

/** Where you are, and which way you face, `dist` metres along the loop (wraps round). */
export function sampleLoop(loop: Loop, dist: number): { x: number; z: number; dx: number; dz: number } {
  const t = ((dist % loop.length) + loop.length) % loop.length;
  let i = 0;
  while (i < loop.points.length - 1 && loop.cumulative[i + 1]! <= t) i++;
  const a = loop.points[i]!;
  const b = loop.points[(i + 1) % loop.points.length]!;
  const seg = loop.cumulative[i + 1]! - loop.cumulative[i]!;
  const k = seg === 0 ? 0 : (t - loop.cumulative[i]!) / seg;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { x: a[0] + (b[0] - a[0]) * k, z: a[1] + (b[1] - a[1]) * k, dx: (b[0] - a[0]) / len, dz: (b[1] - a[1]) / len };
}

const ring = (r: number, n: number) => Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * Math.PI * 2), r * Math.sin((i / n) * Math.PI * 2)] as [number, number]);

/** Three rings across the plaza (96 points each, so they read as smooth circles), between the fountain (about 3 m out) and the market stalls (about 7.5 m out). */
function buildGatherLoops(): Loop[] {
  return [PLAZA_RADIUS * 0.48, PLAZA_RADIUS * 0.59, PLAZA_RADIUS * 0.7].map((r) => makeLoop(ring(r, 96)));
}

/** Walkways: for each road, a loop out one sidewalk and back the other. */
function buildLoops(roads: Road[]): Loop[] {
  const loops: Loop[] = [];
  const off = ROAD_WIDTH / 2 + SIDEWALK_WIDTH / 2;
  for (const r of roads) {
    const near = PLAZA_RADIUS + 0.6;
    const far = r.length - 4;
    const p = (dist: number, s: number): [number, number] => [r.dir[0] * dist + r.side[0] * off * s, r.dir[1] * dist + r.side[1] * off * s];
    loops.push(makeLoop([p(near, 1), p(far, 1), p(far, -1), p(near, -1)]));
  }
  return loops;
}

/**
 * Lays out a city: a plaza at the origin, 4 to 6 roads out from it, and rings of buildings between the roads. The same
 * planet and population tier always give the same city.
 */
export function layoutCity(options: CityOptions): CityLayout {
  const tier = populationTier(options.population);
  const rng = makeRng(hashString(`${options.planet}:city`));

  const count = 4 + Math.floor(rng() * 3);
  const base = rng() * Math.PI * 2;
  const spacing = (Math.PI * 2) / count;
  const roads: Road[] = Array.from({ length: count }, (_, index) => {
    const angle = base + index * spacing + (rng() - 0.5) * spacing * 0.3;
    const dir: [number, number] = [Math.sin(angle), Math.cos(angle)];
    return { index, angle, dir, side: [dir[1], -dir[0]], width: ROAD_WIDTH, length: ROAD_LENGTH, end: [dir[0] * ROAD_LENGTH, dir[1] * ROAD_LENGTH] };
  });

  const distanceToRoad = (x: number, z: number) => {
    let best = Infinity;
    for (const r of roads) best = Math.min(best, distToSegment(x, z, 0, 0, r.end[0], r.end[1]));
    return best;
  };
  const edge = ROAD_WIDTH / 2 + SIDEWALK_WIDTH;
  const roadClearance = (x: number, z: number) => distanceToRoad(x, z) - edge;

  const ringClearance = (x: number, z: number, streets: RingStreet[]) => {
    const r = Math.hypot(x, z);
    let best = Infinity;
    for (const st of streets) best = Math.min(best, Math.abs(r - st.radius) - (st.width / 2 + st.sidewalk));
    return best;
  };

  // The full-grown city. Every number is drawn for every slot, whatever the population, so a building's size, spot and
  // appear-tier never depend on how many people there are; the population only picks which of them stand.
  const industrialAt = rng() * Math.PI * 2;
  const all: Building[] = [];
  const ringCount = Math.floor((CITY_RADIUS - INNER_RING) / RING_STEP) + 1;
  for (let ring = 0; ring < ringCount; ring++) {
    const r = INNER_RING + ring * RING_STEP;
    const t = ringCount === 1 ? 0 : ring / (ringCount - 1);
    const slots = Math.floor((Math.PI * 2 * r) / SLOT_STEP);
    for (let slot = 0; slot < slots; slot++) {
      const jitterA = (rng() - 0.5) * 0.25;
      const w = 5 + rng() * 3.5;
      const d = 4.5 + rng() * 1.5;
      const hRand = rng();
      const skip = rng() < 0.1;
      const pal = Math.floor(rng() * 4);
      const grow = Math.floor(rng() * 3);
      const angle = ((slot + jitterA) / slots) * Math.PI * 2;
      const x = r * Math.sin(angle);
      const z = r * Math.cos(angle);
      if (skip || roadClearance(x, z) < Math.hypot(w, d) / 2 + 0.8) continue;
      const wedge = Math.abs(Math.atan2(Math.sin(angle - industrialAt), Math.cos(angle - industrialAt)));
      const kind: BuildingKind = ring === ringCount - 1 && wedge < 0.85 ? 'industrial' : t < 0.45 ? 'commercial' : 'residential';
      all.push({
        id: `${ring}:${slot}`, x, z, w: kind === 'industrial' ? w * 1.3 : w, d, h: hRand, rotY: angle, kind, paletteIndex: pal, ring,
        tierMin: ring === 0 ? 0 : ring * RING_TIER_STEP + grow - 1,
      });
    }
  }
  const streetCount = ringCount - 1;
  const allStreets: RingStreet[] = Array.from({ length: streetCount }, (_, index) => ({
    index, radius: INNER_RING + (index + 0.5) * RING_STEP, width: RING_STREET_ROAD, sidewalk: RING_STREET_SIDEWALK,
    tierMin: (index + 1) * RING_TIER_STEP - 1,
  }));

  // Pick what stands at this tier, and how tall it is.
  const ringStreets = allStreets.filter((st) => tier >= st.tierMin);
  const buildings = all.filter((b) => tier >= b.tierMin).map((b) => ({ ...b, h: buildingHeight(b, ringCount, tier) }));
  const roadAndRingClearance = (x: number, z: number) => Math.min(roadClearance(x, z), ringClearance(x, z, ringStreets));
  const onStreetNow = (x: number, z: number, margin = 0) => Math.hypot(x, z) <= PLAZA_RADIUS + margin || roadAndRingClearance(x, z) <= margin;

  return {
    options, tier, plazaRadius: PLAZA_RADIUS, radius: CITY_RADIUS, flatRadius: CITY_FLAT_RADIUS,
    roads, ringStreets, buildings, capacity: all.length, loops: buildLoops(roads), gatherLoops: buildGatherLoops(), distanceToRoad,
    roadClearance: roadAndRingClearance, onStreet: onStreetNow,
  };
}

/**
 * How tall a building stands at a population tier. Never falls as the tier rises: every ingredient is a non-decreasing
 * function of the tier, and `b.h` holds only the building's own random roll (0 to 1).
 */
function buildingHeight(b: Building, ringCount: number, tier: number): number {
  const t = ringCount === 1 ? 0 : b.ring / (ringCount - 1);
  const boost = 0.65 + 0.45 * clamp((tier - GROWTH_START) / (GROWTH_FULL - GROWTH_START), 0, 1) + 0.35 * clamp((tier - GROWTH_FULL) / 16, 0, 1);
  if (b.kind === 'industrial') return (4 + b.h * 3) * boost;
  const base = (b.kind === 'commercial' ? 12 + b.h * 18 : 5 + b.h * 7) * (1.25 - 0.45 * t) * boost;
  // Towers rise in the core as the city matures.
  const tower = b.kind === 'commercial' ? (1 - t) * 10 * clamp((tier - 6) / 10, 0, 1) : 0;
  return base + tower;
}

/** How many floors fit in a building of this height (for window rows). */
export function floorsOf(height: number): number {
  return Math.max(1, Math.floor(height / FLOOR_HEIGHT));
}
