import { hashString } from '../scene/planet-look';
import { PLAZA_RADIUS, ROAD_WIDTH, makeLoop, sampleLoop } from './city-layout';
import type { CityLayout, Loop } from './city-layout';
import { makeRng } from './rng';

/** Vehicles driving the roads (Phase 10). Pure: lane loops, who drives where, and where each one is at a given time. */

/** How far from the road's centreline each lane runs. */
export const LANE_OFFSET = ROAD_WIDTH / 4;
/** Most cars and haulers the road network shows; the real number is a share of this. */
export const MAX_CARS = 18;
export const MAX_HAULERS = 3;

function unit(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

/**
 * A closed loop that goes out along a path in one lane and back in the other (right-hand traffic). The lane offset at
 * a bend follows the bend's average sideways direction.
 */
export function lanePolygon(path: [number, number][], offset: number): [number, number][] {
  const side = (i: number): [number, number] => {
    const legs: [number, number][] = [];
    if (i > 0) legs.push(unit(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
    if (i < path.length - 1) legs.push(unit(path[i + 1]![0] - path[i]![0], path[i + 1]![1] - path[i]![1]));
    const [ux, uz] = unit(legs.reduce((s, l) => s + l[0], 0), legs.reduce((s, l) => s + l[1], 0));
    return [uz, -ux]; // to the right of the direction of travel
  };
  const out = path.map((p, i): [number, number] => {
    const s = side(i);
    return [p[0] + s[0] * offset, p[1] + s[1] * offset];
  });
  const back = path
    .map((p, i): [number, number] => {
      const s = side(i);
      return [p[0] - s[0] * offset, p[1] - s[1] * offset];
    })
    .reverse();
  return [...out, ...back];
}

/** One lane loop per road: out to the road's far end and back. */
export function roadLoops(layout: CityLayout): Loop[] {
  const at = (r: CityLayout['roads'][number], d: number): [number, number] => [r.dir[0] * d, r.dir[1] * d];
  return layout.roads.map((r) => makeLoop(lanePolygon([at(r, PLAZA_RADIUS + 1.5), at(r, r.length - 4)], LANE_OFFSET)));
}

export interface VehicleSpec {
  loop: number;
  /** Starting distance along the loop, metres. */
  offset: number;
  /** Metres per second. */
  speed: number;
  /** Shade, 0 to 1, picks a colour. */
  tint: number;
  /** Size multiplier. */
  scale: number;
}

/** `count` vehicles spread over the loops. The same planet always gives the same list, and a shorter list is a prefix of a longer one. */
export function makeVehicles(loops: Loop[], count: number, planet: string, kind: 'car' | 'hauler'): VehicleSpec[] {
  const rng = makeRng(hashString(`${planet}:vehicles:${kind}`));
  const out: VehicleSpec[] = [];
  for (let i = 0; i < count; i++) {
    const loop = Math.floor(rng() * loops.length);
    out.push({
      loop,
      offset: rng() * loops[loop]!.length,
      speed: kind === 'car' ? 5 + rng() * 4 : 3 + rng() * 1.5,
      tint: rng(),
      scale: kind === 'car' ? 0.9 + rng() * 0.25 : 1.3,
    });
  }
  return out;
}

export interface VehiclePose {
  x: number;
  z: number;
  /** Turn about the vertical axis (the vehicle faces +z at 0). */
  heading: number;
}

/** Where a vehicle is `time` seconds in. */
export function vehiclePose(loops: Loop[], spec: VehicleSpec, time: number): VehiclePose {
  const s = sampleLoop(loops[spec.loop]!, spec.offset + spec.speed * time);
  return { x: s.x, z: s.z, heading: Math.atan2(s.dx, s.dz) };
}

/** How many of `max` vehicles are out at a traffic level of 0 to 1. */
export function vehicleCount(max: number, traffic: number): number {
  return Math.round(max * Math.min(1, Math.max(0, traffic)));
}

/** How many haulers run between port and market: at least one at any traffic, more when ships are in. */
export function haulerCount(portShips: number, traffic: number): number {
  if (traffic <= 0) return 0;
  return Math.min(MAX_HAULERS, Math.max(1, Math.round((1 + portShips) * Math.min(1, traffic))));
}
