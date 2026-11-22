import { PLATEAU_TOP } from './city';
import type { V3 } from './curve';

/**
 * Planets you can click to fly in to. For now just one; add ids here to turn on more.
 * (Verdan: the green-and-blue world, home of the first little city.)
 */
export const ZOOMABLE_PLANETS: readonly string[] = ['verdan'];

export const isZoomable = (planetId: string): boolean => ZOOMABLE_PLANETS.includes(planetId);

/** The map view the camera starts in, and returns to if there is nothing better saved. */
export const HOME_POSE: { position: V3; target: V3 } = { position: { x: 0, y: 7.5, z: 10.5 }, target: { x: 0, y: 0, z: 0 } };

/** Camera distance limits on the map, in scene units. */
export const MAP_LIMITS = { min: 2.5, max: 32 };
/** Camera distance limits when zoomed in on a planet, as multiples of its radius (measured from the city). */
export const FOCUS_LIMITS = { minRadii: 0.2, maxRadii: 8 };

/** How far above the equator the city sits, on the side facing the sun (radians). */
export const SURFACE_LATITUDE = 0.9;
/** How far from straight-down the camera looks at the city (radians), so you see it at an angle. */
const VIEW_TILT = 0.85;
/** The camera's distance from the city when it lands, as a multiple of the planet radius. */
export const LANDING_RADII = 1.55;

export interface SurfaceSite {
  /** Unit vector pointing straight up out of the planet at the city. */
  normal: V3;
  /** Unit vector along the ground at the city, pointing toward the equator (away from the north pole). */
  south: V3;
  /** The middle of the city floor, in world coordinates. */
  point: V3;
}

/** Where the city stands on a planet: on the sun-facing side, so it is always in daylight. `radius` is the planet's radius. */
export function surfaceSite(planet: V3, radius: number): SurfaceSite {
  const len = Math.hypot(planet.x, planet.z) || 1;
  const toward = { x: -planet.x / len, z: -planet.z / len }; // horizontally, from the planet toward the sun
  const [c, s] = [Math.cos(SURFACE_LATITUDE), Math.sin(SURFACE_LATITUDE)];
  const normal = { x: toward.x * c, y: s, z: toward.z * c };
  const south = { x: toward.x * s, y: -c, z: toward.z * s };
  const up = radius + PLATEAU_TOP;
  return { normal, south, point: { x: planet.x + normal.x * up, y: planet.y + normal.y * up, z: planet.z + normal.z * up } };
}

/**
 * Where the camera should land to look at a planet's city: a little way out from it, on the equator side, tilted so the
 * city is seen at an angle, looking at the middle of the city floor.
 */
export function focusPose(planet: V3, radius: number): { position: V3; target: V3; minDistance: number; maxDistance: number } {
  const site = surfaceSite(planet, radius);
  const away = radius * LANDING_RADII;
  const [up, along] = [Math.cos(VIEW_TILT), Math.sin(VIEW_TILT)];
  const position = {
    x: site.point.x + (site.normal.x * up + site.south.x * along) * away,
    y: site.point.y + (site.normal.y * up + site.south.y * along) * away,
    z: site.point.z + (site.normal.z * up + site.south.z * along) * away,
  };
  return { position, target: site.point, minDistance: radius * FOCUS_LIMITS.minRadii, maxDistance: radius * FOCUS_LIMITS.maxRadii };
}
