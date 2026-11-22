import type { PlanetSnapshot } from '@orbital/contracts';
import { mulberry32 } from './rng';

/** The little city sits on a round plateau. Distances are scene units; the planet itself is about half a unit across. */
export const CITY_RADIUS = 0.16;
/** How high the plateau's top sits above the planet's surface. */
export const PLATEAU_TOP = 0.035;
export const ROAD_HALF_WIDTH = 0.011;
/** Roads run through the middle in a cross, this far each way from the center. */
export const ROAD_HALF_LENGTH = 0.148;

export interface House {
  x: number;
  z: number;
  w: number;
  d: number;
  /** Height of the walls. */
  h: number;
  /** Index into the house and roof colour lists. */
  look: number;
}

export interface CityLayout {
  /** Every spot a house could go, in a fixed order; the city shows the first few for a small population. */
  houses: House[];
  plaza: { x: number; z: number; r: number };
  pad: { x: number; z: number; r: number };
  barn: { x: number; z: number };
  silo: { x: number; z: number };
  fields: { x: number; z: number; w: number; d: number }[];
}

const MAX_HOUSES = 24;
const HOUSE_GAP = 0.04;

const rectDistance = (px: number, pz: number, r: { x: number; z: number; w: number; d: number }) =>
  Math.max(Math.abs(px - r.x) - r.w / 2, Math.abs(pz - r.z) - r.d / 2);

/** The same seed always gives the same city, so it does not change shape from one visit to the next. */
export function cityLayout(seed: number): CityLayout {
  const rand = mulberry32(seed ^ 0x5bd1e995);
  const plaza = { x: 0, z: 0, r: 0.03 };
  const pad = { x: -0.098, z: -0.088, r: 0.032 };
  const barn = { x: 0.098, z: -0.092 };
  const silo = { x: 0.128, z: -0.084 };
  const fields = [{ x: 0.092, z: 0.092, w: 0.07, d: 0.052 }, { x: 0.04, z: 0.108, w: 0.05, d: 0.04 }];

  const clear = (x: number, z: number, margin: number): boolean => {
    if (Math.hypot(x, z) > CITY_RADIUS - 0.02) return false; // stay on the plateau
    if (Math.abs(x) < ROAD_HALF_WIDTH + margin || Math.abs(z) < ROAD_HALF_WIDTH + margin) return false; // keep the roads clear
    if (Math.hypot(x - plaza.x, z - plaza.z) < plaza.r + margin) return false;
    if (Math.hypot(x - pad.x, z - pad.z) < pad.r + margin) return false;
    if (Math.hypot(x - barn.x, z - barn.z) < 0.04 + margin || Math.hypot(x - silo.x, z - silo.z) < 0.02 + margin) return false;
    return fields.every((f) => rectDistance(x, z, f) > margin);
  };

  const houses: House[] = [];
  for (let tries = 0; tries < 4000 && houses.length < MAX_HOUSES; tries++) {
    const a = rand() * Math.PI * 2;
    const r = 0.045 + rand() * (CITY_RADIUS - 0.065);
    const [x, z] = [Math.cos(a) * r, Math.sin(a) * r];
    const house: House = { x, z, w: 0.02 + rand() * 0.008, d: 0.02 + rand() * 0.008, h: 0.018 + rand() * 0.014, look: Math.floor(rand() * 5) };
    if (!clear(x, z, house.w * 0.55)) continue;
    if (houses.some((o) => Math.hypot(o.x - x, o.z - z) < HOUSE_GAP)) continue;
    houses.push(house);
  }
  return { houses, plaza, pad, barn, silo, fields };
}

export interface CityCounts {
  houses: number;
  aliens: number;
  /** Walking speed in scene units per second. */
  walkSpeed: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How big and busy the city is, from the planet's numbers: population sets the houses and aliens, confidence sets the pace. */
export function cityCounts(p: PlanetSnapshot): CityCounts {
  const pop = Math.max(0, p.metrics.population);
  const confidence = clamp(p.metrics.consumerConfidence, 0, 100);
  return {
    houses: clamp(Math.round(pop * 0.45), 5, MAX_HOUSES),
    aliens: clamp(Math.round(pop * 0.5), 6, 24),
    walkSpeed: 0.012 + (confidence / 100) * 0.025,
  };
}

// ---- Aliens walking the roads ---------------------------------------------------------------------

/** One alien on the cross-shaped road: which road, how far along it, which way, and a little sideways offset so they do not stack. */
export interface Walker {
  axis: 'x' | 'z';
  /** Position along the road, from -ROAD_HALF_LENGTH to ROAD_HALF_LENGTH; 0 is the crossing in the middle. */
  t: number;
  dir: 1 | -1;
  lane: number;
  /** For the walking bob. */
  phase: number;
}

export function makeWalkers(count: number, seed: number): Walker[] {
  const rand = mulberry32(seed ^ 0x1b873593);
  return Array.from({ length: count }, () => ({
    axis: rand() < 0.5 ? 'x' : 'z',
    t: (rand() * 2 - 1) * ROAD_HALF_LENGTH,
    dir: rand() < 0.5 ? 1 : -1,
    lane: (rand() * 2 - 1) * (ROAD_HALF_WIDTH * 0.6),
    phase: rand() * Math.PI * 2,
  }));
}

/** Moves a walker along its road. At either end it turns round; at the crossing it may turn onto the other road. */
export function stepWalker(w: Walker, dt: number, speed: number, rand: () => number): void {
  const before = w.t;
  w.t += w.dir * speed * dt;
  w.phase += dt * speed * 90;
  if (w.t > ROAD_HALF_LENGTH || w.t < -ROAD_HALF_LENGTH) {
    w.t = clamp(w.t, -ROAD_HALF_LENGTH, ROAD_HALF_LENGTH);
    w.dir = w.dir === 1 ? -1 : 1;
  } else if (before !== 0 && Math.sign(before) !== Math.sign(w.t) && rand() < 0.5) {
    w.axis = w.axis === 'x' ? 'z' : 'x'; // reached the crossing: take the other road
    w.t = Math.abs(w.t) * w.dir;
  }
}

/** Where a walker stands on the plateau, and which way it faces (a rotation about the vertical, 0 = facing +z). */
export function walkerPose(w: Walker): { x: number; z: number; heading: number } {
  return w.axis === 'x'
    ? { x: w.t, z: w.lane, heading: w.dir === 1 ? Math.PI / 2 : -Math.PI / 2 }
    : { x: w.lane, z: w.t, heading: w.dir === 1 ? 0 : Math.PI };
}
