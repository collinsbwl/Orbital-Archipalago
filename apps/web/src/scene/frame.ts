import type { Shipment, Snapshot } from '@orbital/contracts';
import { orbitOf, planetXY } from '../orbits';
import { pointOnLane } from './curve';
import type { V3 } from './curve';

/** World distance units (what the engine uses) to scene units. */
export const SCALE = 1 / 40;

/** What every part of the scene reads each frame: the smooth cycle and where each planet is at that moment. */
export interface FrameState {
  cycle: number;
  planets: Record<string, V3>;
}

/**
 * Whether planets travel around their orbits. Off: each planet stays at a fixed spot on its orbit ring, so the map holds
 * still and the lanes between planets stay put. Turn it on to see them circle the sun with the cycle count.
 */
export const PLANETS_ORBIT = false;

/** Where the first planet sits when planets are stationary, in radians. The others are spread evenly around the sun from here. */
const STATIONARY_START_ANGLE = 0.6;

/** Planets at a (fractional) cycle. The orbital plane (x, y) becomes the scene's floor (x, z). */
export function planetPositions(snapshot: Snapshot, cycle: number): Record<string, V3> {
  const out: Record<string, V3> = {};
  const n = snapshot.planets.length;
  snapshot.planets.forEach((p, i) => {
    let xy: { x: number; y: number };
    if (PLANETS_ORBIT) {
      xy = planetXY(p, i, snapshot.cycle, cycle);
    } else {
      const angle = STATIONARY_START_ANGLE + (i / Math.max(1, n)) * 2 * Math.PI;
      const { radius } = orbitOf(p.planet, i);
      xy = { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    }
    out[p.planet] = { x: xy.x * SCALE, y: 0, z: xy.y * SCALE };
  });
  return out;
}

/** How far along its trip a shipment is, 0 to 1. */
export function shipProgress(s: Pick<Shipment, 'departCycle' | 'arriveCycle'>, cycle: number): number {
  const span = Math.max(1, s.arriveCycle - s.departCycle);
  return Math.min(1, Math.max(0, (cycle - s.departCycle) / span));
}

/**
 * Where a shipment is: on the lane between its two planets as they are right now, `progress` of the way along.
 * (If planets orbit, the lane follows them and the ship rides it.)
 */
export function shipPosition(s: Shipment, planets: Record<string, V3>, cycle: number): V3 | null {
  const a = planets[s.from];
  const b = planets[s.to];
  if (!a || !b) return null;
  return pointOnLane(a, b, shipProgress(s, cycle));
}

/** The lines shown when you hover a ship. */
export function shipTooltip(s: Shipment, cycle: number): string[] {
  const cargo = s.cargo.map((c) => `${c.good} x${c.qty}`).join(', ');
  const left = Math.max(0, s.arriveCycle - Math.floor(cycle));
  return [
    s.owner,
    `${s.from} to ${s.to}`,
    cargo,
    left === 0 ? `arriving (cycle ${s.arriveCycle})` : `arrives cycle ${s.arriveCycle} (in ${left})`,
  ];
}
