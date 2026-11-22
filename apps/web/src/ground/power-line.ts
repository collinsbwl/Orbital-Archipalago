import type { CityLayout } from './city-layout';
import { PLAZA_RADIUS, ROAD_WIDTH, SIDEWALK_WIDTH } from './city-layout';
import type { Piece } from './industry';
import type { HeightField } from './terrain';

/** A line of power pylons beside one road, with sagging wires between them (Phase 10). Pure. */

/** Metres between pylons. */
export const PYLON_SPACING = 20;
/** Closest the pylons stand to the road's centreline: clear of the sidewalk. They move out from here until no building is in the way. */
export const MIN_PYLON_OFFSET = ROAD_WIDTH / 2 + SIDEWALK_WIDTH + 3.5;
const MAX_PYLON_OFFSET = 40;
/** Space left between a pylon and the nearest building's corner. */
const BUILDING_MARGIN = 1.5;
export const PYLON_HEIGHT = 11;
/** The crossarm is this wide; a wire hangs from each end. */
export const ARM_WIDTH = 4.4;
/** How far a wire drops at the middle of a span. */
export const SAG = 1.1;
const ARM_Y = PYLON_HEIGHT - 0.8;
/** Points along each wire. */
export const WIRE_STEPS = 10;

export interface Pylon {
  x: number;
  y: number;
  z: number;
  /** Turn about the vertical so the crossarm lies across the line. */
  rotY: number;
}

/** Roads other than `skip`, in index order, with the one whose far end is nearest a point first. */
export function pickRoad(layout: CityLayout, near: [number, number] | null, skip: number[]): number {
  const candidates = layout.roads.filter((r) => !skip.includes(r.index));
  if (candidates.length === 0) return layout.roads[layout.roads.length - 1]!.index;
  if (!near) return candidates[0]!.index;
  let best = candidates[0]!;
  for (const r of candidates) {
    if (Math.hypot(r.end[0] - near[0], r.end[1] - near[1]) < Math.hypot(best.end[0] - near[0], best.end[1] - near[1])) best = r;
  }
  return best.index;
}

/**
 * Pylons along one road, from just outside the plaza to the road's far end, on whichever side lets them stand closest to
 * the road without touching a building (they step out in half-metre steps). `layout` should be the full-grown city so
 * no pylon is ever in a building that grows later.
 */
export function layoutPylons(layout: CityLayout, roadIndex: number, field: HeightField): Pylon[] {
  const road = layout.roads[roadIndex]!;
  const spots = (side: number, offset: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let d = PLAZA_RADIUS + 8; d <= road.length + 1e-6; d += PYLON_SPACING) {
      out.push([road.dir[0] * d + road.side[0] * side * offset, road.dir[1] * d + road.side[1] * side * offset]);
    }
    return out;
  };
  const room = (points: [number, number][]) => {
    let worst = Infinity;
    for (const [x, z] of points) for (const b of layout.buildings) worst = Math.min(worst, Math.hypot(b.x - x, b.z - z) - Math.hypot(b.w, b.d) / 2);
    return worst;
  };
  let chosen: { side: number; offset: number } | null = null;
  let fallback = { side: 1, offset: MIN_PYLON_OFFSET, room: -Infinity };
  search: for (let offset = MIN_PYLON_OFFSET; offset <= MAX_PYLON_OFFSET; offset += 0.5) {
    for (const side of [1, -1]) {
      const r = room(spots(side, offset));
      if (r >= BUILDING_MARGIN) {
        chosen = { side, offset };
        break search;
      }
      if (r > fallback.room) fallback = { side, offset, room: r };
    }
  }
  const { side, offset } = chosen ?? fallback;
  // The arm lies across the road direction: local x must point along `road.side`.
  const rotY = Math.atan2(-road.side[1], road.side[0]);
  return spots(side, offset).map(([x, z]) => ({ x, y: field.heightAt(x, z), z, rotY }));
}

/** Each pylon as a tapered mast (two stacked cylinders), a crossarm and insulators, in solid pieces. */
export function pylonPieces(pylons: Pylon[]): Piece[] {
  return pylons.flatMap((p) => [
    { shape: 'cyl' as const, x: p.x, y: p.y, z: p.z, rotY: 0, size: [0.9, PYLON_HEIGHT * 0.45, 0.9] as [number, number, number], color: '#7c828b' },
    { shape: 'cyl' as const, x: p.x, y: p.y + PYLON_HEIGHT * 0.45, z: p.z, rotY: 0, size: [0.55, PYLON_HEIGHT * 0.55, 0.55] as [number, number, number], color: '#8d949c' },
    { shape: 'box' as const, x: p.x, y: p.y + ARM_Y, z: p.z, rotY: p.rotY, size: [ARM_WIDTH, 0.3, 0.3] as [number, number, number], color: '#5a5f67' },
  ]);
}

/** The two wire ends on a pylon, in world space (the crossarm's tips, a little below it). */
export function wireAnchors(p: Pylon): [[number, number, number], [number, number, number]] {
  // Local +x turned by rotY about the vertical points along (cos, -sin).
  const ax = Math.cos(p.rotY) * (ARM_WIDTH / 2);
  const az = -Math.sin(p.rotY) * (ARM_WIDTH / 2);
  const y = p.y + ARM_Y - 0.2;
  return [[p.x + ax, y, p.z + az], [p.x - ax, y, p.z - az]];
}

/** One sagging wire between two points: `steps` + 1 points along a parabola that drops `sag` metres at the middle. */
export function wireCurve(a: [number, number, number], b: [number, number, number], sag = SAG, steps = WIRE_STEPS): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** Wires for a whole line as line-segment vertex pairs (x, y, z each), two wires per span. */
export function wireSegments(pylons: Pylon[]): Float32Array {
  const spans = Math.max(0, pylons.length - 1);
  const out = new Float32Array(spans * 2 * WIRE_STEPS * 2 * 3);
  let o = 0;
  for (let i = 0; i < spans; i++) {
    const a = wireAnchors(pylons[i]!);
    const b = wireAnchors(pylons[i + 1]!);
    for (let w = 0; w < 2; w++) {
      const pts = wireCurve(a[w]!, b[w]!);
      for (let k = 0; k < pts.length - 1; k++) {
        out.set(pts[k]!, o);
        out.set(pts[k + 1]!, o + 3);
        o += 6;
      }
    }
  }
  return out;
}
