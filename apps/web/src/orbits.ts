import { DEFAULT_WORLD } from '@orbital/contracts';
import type { PlanetSnapshot, Shipment } from '@orbital/contracts';

export interface Orbit {
  radius: number;
  periodCycles: number;
}

/** Orbit of a planet: from DEFAULT_WORLD when known, else a made-up one by index (the snapshot carries no radii). */
export function orbitOf(planet: string, index: number): Orbit {
  const known = DEFAULT_WORLD.planets.find((p) => p.id === planet);
  return known ? { radius: known.orbit.radius, periodCycles: known.orbit.periodCycles } : { radius: 100 + 60 * index, periodCycles: 20 + 12 * index };
}

/** Position on the orbital plane. `orbitPhaseCycles` is the phase at `nowCycle`; `atCycle` extrapolates from it. */
export function planetXY(p: PlanetSnapshot, index: number, nowCycle: number, atCycle: number): { x: number; y: number } {
  const { radius, periodCycles } = orbitOf(p.planet, index);
  const angle = (2 * Math.PI * (p.orbitPhaseCycles + (atCycle - nowCycle))) / periodCycles;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/** Shipment position: from the origin where it departed toward the destination where it arrives, by cycle progress. */
export function shipmentXY(s: Shipment, planets: PlanetSnapshot[], nowCycle: number): { x: number; y: number } | null {
  const fi = planets.findIndex((p) => p.planet === s.from);
  const ti = planets.findIndex((p) => p.planet === s.to);
  const from = planets[fi];
  const to = planets[ti];
  if (!from || !to) return null;
  const a = planetXY(from, fi, nowCycle, s.departCycle);
  const b = planetXY(to, ti, nowCycle, s.arriveCycle);
  const span = Math.max(1, s.arriveCycle - s.departCycle);
  const t = Math.min(1, Math.max(0, (nowCycle - s.departCycle) / span));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
