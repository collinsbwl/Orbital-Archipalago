import type { PlanetConfig, PlanetId, WorldConfig } from '@orbital/contracts';

/** Position in the orbit cycle, in [0, periodCycles). */
export const orbitPhase = (planet: PlanetConfig, cycle: number): number => (cycle + planet.orbit.phaseCycles) % planet.orbit.periodCycles;

/** Planet position at `cycle` on a circle of `orbit.radius` around the origin. Pure and deterministic. */
export function planetPosition(planet: PlanetConfig, cycle: number): { x: number; y: number } {
  const angle = (2 * Math.PI * orbitPhase(planet, cycle)) / planet.orbit.periodCycles;
  return { x: planet.orbit.radius * Math.cos(angle), y: planet.orbit.radius * Math.sin(angle) };
}

export function planetDistance(a: PlanetConfig, b: PlanetConfig, cycle: number): number {
  const pa = planetPosition(a, cycle);
  const pb = planetPosition(b, cycle);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** Cycles a freighter leaving `from` for `to` at `cycle` needs: distance at departure / speed, at least `travel.minCycles`. */
export function travelCycles(world: WorldConfig, from: PlanetId, to: PlanetId, cycle: number): number {
  const find = (id: PlanetId) => {
    const p = world.planets.find((q) => q.id === id);
    if (!p) throw new Error(`unknown planet ${id}`);
    return p;
  };
  return Math.max(world.travel.minCycles, Math.ceil(planetDistance(find(from), find(to), cycle) / world.travel.speedUnitsPerCycle));
}
