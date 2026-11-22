import { hashString, lookFor } from '../scene/planet-look';

/**
 * The sky as seen from a planet's surface (Phase 13). Pure. Everything is worked out in the map's "celestial" frame
 * (the sun is at the map origin, the other planets at their map positions) and then turned into the ground's local
 * frame (x east, y up, z south) by the planet's spin. Day and night are that spin: the sun, the planets and the stars
 * all turn together, so the sun in the sky is always the real direction to the map's sun.
 */

export type Vec3 = [number, number, number];

/** Cycles in one day. Configurable per call; each planet starts its day at its own offset. */
export const DAY_LENGTH_CYCLES = 24;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Where a planet sits in the map, any object with x, y, z. */
export type MapPoint = { x: number; y: number; z: number };
const pt = (p: MapPoint): Vec3 => [p.x, p.y, p.z];

/** A planet's own start-of-day offset, 0 to 1. */
export const dayOffset = (planetId: string): number => (hashString(`day:${planetId}`) % 1000) / 1000;

/** Time of day, 0 to 1 from the cycle: 0.5 is noon (the sun highest), 0 and 1 midnight. */
export function timeOfDay(cycle: number, planetId: string, dayLength = DAY_LENGTH_CYCLES): number {
  const t = cycle / Math.max(1e-6, dayLength) + dayOffset(planetId);
  return t - Math.floor(t);
}

/**
 * Unit vector from the planet to the sun in the map frame. The sun is the map origin. With no position for the planet
 * (a still frame with no map) it falls back to a fixed direction from the planet id, so the sky still works.
 */
export function sunCelestial(planetId: string, planets: Record<string, MapPoint> | undefined): Vec3 {
  const p = planets?.[planetId];
  if (p && len(pt(p)) > 1e-6) return unit([-p.x, -p.y, -p.z]);
  const az = ((hashString(planetId) >>> 3) % 360) * (Math.PI / 180);
  return [Math.sin(az), 0, Math.cos(az)];
}

/** The ground's three axes written in the map frame. */
export interface SkyBasis {
  east: Vec3;
  up: Vec3;
  south: Vec3;
}

/**
 * The observer's axes at a time of day. The observer stands at `latitude` on a planet spinning about the map's vertical
 * axis. At noon (t = 0.5) the sun is on the meridian, so its height then is 90 degrees minus the latitude (a look's
 * `sunElevation` sets that); at midnight it is as far below.
 */
export function skyBasis(sun: Vec3, latitude: number, t: number): SkyBasis {
  // `th` turns counterclockwise seen from above the north pole (the way a planet spins), which in this frame
  // (x right, z toward the viewer) takes the horizontal direction (cos th, -sin th). That keeps east x up = south.
  const noon = Math.hypot(sun[0], sun[2]) > 1e-6 ? Math.atan2(-sun[2], sun[0]) : 0;
  const th = noon + Math.PI * 2 * (t - 0.5);
  const sl = Math.sin(latitude);
  const cl = Math.cos(latitude);
  return {
    east: [-Math.sin(th), 0, -Math.cos(th)],
    up: [cl * Math.cos(th), sl, -cl * Math.sin(th)],
    south: [sl * Math.cos(th), -cl, -sl * Math.sin(th)],
  };
}

/** Latitude that puts the noon sun at the look's `sunElevation`. */
export const latitudeFor = (sunElevation: number): number => Math.PI / 2 - Math.min(1.45, Math.max(0.05, sunElevation));

/** A map-frame vector in the ground's frame: [east, up, south]. */
export function toLocal(b: SkyBasis, v: Vec3): Vec3 {
  return [dot(v, b.east), dot(v, b.up), dot(v, b.south)];
}

/** A neighbouring planet as a disc in the sky. All directions are in the ground frame. */
export interface SkyBody {
  id: string;
  /** Unit vector from the observer to the body. */
  dir: Vec3;
  /** Half the width of the disc, radians. */
  angularRadius: number;
  /** The disc's own axes: right and up across its face, toward the observer. */
  right: Vec3;
  up: Vec3;
  toward: Vec3;
  /** Unit vector from the body to the sun, written in the disc's own axes (right, up, toward). The lit side faces it. */
  light: Vec3;
  /** Distance in map units. */
  distance: number;
  /** False when the whole disc is below the horizon. */
  visible: boolean;
}

/** Discs are drawn this fraction of their true angular size, so a close planet does not fill the sky. */
export const BODY_SIZE = 0.7;
const MIN_ANGLE = 0.014;
const MAX_ANGLE = 0.09;

/** The other planets in the sky from `planetId`, in id order, drawn from their map positions. */
export function skyBodies(planetId: string, planets: Record<string, MapPoint>, basis: SkyBasis): SkyBody[] {
  const me = planets[planetId];
  if (!me) return [];
  const out: SkyBody[] = [];
  for (const id of Object.keys(planets).sort()) {
    if (id === planetId) continue;
    const other = pt(planets[id]!);
    const rel = sub(other, pt(me));
    const distance = len(rel);
    if (distance < 1e-6) continue;
    const dir = toLocal(basis, unit(rel));
    const angularRadius = Math.min(MAX_ANGLE, Math.max(MIN_ANGLE, Math.atan2(lookFor(id).radius, distance) * BODY_SIZE));
    const toward: Vec3 = [-dir[0], -dir[1], -dir[2]];
    let right = cross([0, 1, 0], toward);
    right = len(right) < 1e-4 ? [1, 0, 0] : unit(right);
    const up = cross(toward, right);
    const sun = toLocal(basis, len(other) > 1e-6 ? unit([-other[0], -other[1], -other[2]]) : [0, 1, 0]);
    out.push({ id, dir, angularRadius, right, up, toward, light: [dot(sun, right), dot(sun, up), dot(sun, toward)], distance, visible: dir[1] > -angularRadius });
  }
  return out;
}

/** Everything about the sky for one planet at one moment. */
export interface SkyView {
  /** Time of day, 0 to 1 (0.5 noon). */
  timeOfDay: number;
  basis: SkyBasis;
  /** Unit vector to the sun in the ground frame; its y is the sine of the sun's height. */
  sun: Vec3;
  bodies: SkyBody[];
}

/** The whole sky: the sun, the neighbouring planets and the spin, from the map positions, the cycle and the planet's look. */
export function skyView(args: { planetId: string; sunElevation: number; cycle: number; planets: Record<string, MapPoint> | undefined; dayLength?: number; fixedTime?: number }): SkyView {
  const { planetId, sunElevation, cycle, planets, dayLength, fixedTime } = args;
  const t = fixedTime ?? timeOfDay(cycle, planetId, dayLength);
  const celestial = sunCelestial(planetId, planets);
  const basis = skyBasis(celestial, latitudeFor(sunElevation), t);
  const sun = toLocal(basis, celestial);
  return { timeOfDay: t, basis, sun, bodies: planets ? skyBodies(planetId, planets, basis) : [] };
}
