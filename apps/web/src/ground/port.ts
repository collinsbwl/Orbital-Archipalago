import { CITY_FLAT_RADIUS, PLAZA_RADIUS } from './city-layout';
import type { CityLayout, Road } from './city-layout';
import type { Piece } from './industry';
import { distToSegment } from './rng';
import type { HeightField } from './terrain';

/**
 * The spaceport (Phase 9): a concrete apron with four landing pads, a control tower and edge lights, just outside the
 * city, joined to one road by a short spur. Pure: the same city always gives the same port.
 */

/** Distance of the port centre from the plaza: just past the outermost buildings. */
export const PORT_DISTANCE = 79;
export const APRON_RADIUS = 17;
export const PAD_RADIUS = 5;
/** Pads sit in a square this far either side of the apron centre. */
const PAD_OFFSET = 6;
/** How far round from the road the port sits, radians. */
const PORT_SWING = 0.3;
/** The spur leaves the road this far from the plaza. */
const SPUR_START = 62;
export const SPUR_WIDTH = 5;

export interface PortPad {
  x: number;
  y: number;
  z: number;
}

export interface Port {
  /** Which road the port hangs off, and on which side (+1 or -1). */
  road: number;
  side: 1 | -1;
  x: number;
  z: number;
  y: number;
  /** Direction ships come in from: the compass heading (direction vector (sin, cos)) pointing away from the plaza. */
  heading: number;
  pads: PortPad[];
  tower: [number, number];
  /** Where the spur meets the road, and where it meets the apron. */
  junction: [number, number];
  gate: [number, number];
}

const polar = (angle: number, r: number): [number, number] => [r * Math.sin(angle), r * Math.cos(angle)];

/**
 * Chooses where the port goes: off any road but the landing road, on either side, picking the spot with the most room
 * from the terrain's features (pits, fields, lakes, rivers). `clearance` is `terrain.siteClearance` when you have one.
 */
export function layoutPort(layout: CityLayout, field: HeightField & { siteClearance?: (x: number, z: number) => number }): Port {
  let best: { road: Road; side: 1 | -1; score: number } | null = null;
  for (const road of layout.roads.slice(1)) {
    for (const side of [1, -1] as const) {
      const [x, z] = polar(road.angle + side * PORT_SWING, PORT_DISTANCE);
      const room = field.siteClearance ? field.siteClearance(x, z) - APRON_RADIUS : 0;
      const score = Math.min(room, CITY_FLAT_RADIUS - Math.hypot(x, z) - APRON_RADIUS);
      if (!best || score > best.score + 1e-6) best = { road, side, score };
    }
  }
  const { road, side } = best!;
  const angle = road.angle + side * PORT_SWING;
  const [x, z] = polar(angle, PORT_DISTANCE);
  const o: [number, number] = [Math.sin(angle), Math.cos(angle)];
  const t: [number, number] = [o[1], -o[0]];
  const junction: [number, number] = [road.dir[0] * SPUR_START, road.dir[1] * SPUR_START];
  const toPort = [x - junction[0], z - junction[1]];
  const len = Math.hypot(toPort[0]!, toPort[1]!) || 1;
  const gate: [number, number] = [x - (toPort[0]! / len) * APRON_RADIUS, z - (toPort[1]! / len) * APRON_RADIUS];
  const y = field.heightAt(x, z);
  const pads: PortPad[] = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      const px = x + o[0] * a * PAD_OFFSET + t[0] * b * PAD_OFFSET;
      const pz = z + o[1] * a * PAD_OFFSET + t[1] * b * PAD_OFFSET;
      pads.push({ x: px, y: field.heightAt(px, pz), z: pz });
    }
  }
  // The tower stands on the apron's edge, on the tangent side farthest from the gate.
  const towerSide = Math.hypot(x + t[0] * 14.5 - gate[0], z + t[1] * 14.5 - gate[1]) >= Math.hypot(x - t[0] * 14.5 - gate[0], z - t[1] * 14.5 - gate[1]) ? 1 : -1;
  const tower: [number, number] = [x + t[0] * 14.5 * towerSide, z + t[1] * 14.5 * towerSide];
  return { road: road.index, side, x, z, y, heading: Math.atan2(o[0], o[1]), pads, tower, junction, gate };
}

/** Space between a point and the port's apron or spur (negative inside). Trees and other props stay off it. */
export function portClearance(port: Port, x: number, z: number): number {
  return Math.min(Math.hypot(x - port.x, z - port.z) - APRON_RADIUS, distToSegment(x, z, port.junction[0], port.junction[1], port.x, port.z) - SPUR_WIDTH / 2 - 1);
}

const CONCRETE = '#6f7075';
const PAD = '#9a9ca1';
const PAD_MARK = '#55575c';
const LIGHT_GREEN = '#7dffb0';
const LIGHT_WARM = '#fff3c4';

/** The port as solid pieces: apron, spur, pads, tower, edge lights. Pads' corner lights, windows and the beacon glow. */
export function portPieces(port: Port): Piece[] {
  const out: Piece[] = [];
  const d = 2 * APRON_RADIUS;
  out.push({ shape: 'cyl', x: port.x, y: port.y, z: port.z, rotY: 0, size: [d, 0.3, d], color: CONCRETE });
  // Spur road, from the road to the apron edge.
  const dx = port.gate[0] - port.junction[0];
  const dz = port.gate[1] - port.junction[1];
  const spurLen = Math.hypot(dx, dz);
  const mx = (port.junction[0] + port.gate[0]) / 2;
  const mz = (port.junction[1] + port.gate[1]) / 2;
  out.push({ shape: 'box', x: mx, y: 0, z: mz, rotY: Math.atan2(dx, dz), size: [SPUR_WIDTH, 0.1, spurLen + 1], color: '#3a3d44' });
  port.pads.forEach((p) => {
    out.push({ shape: 'cyl', x: p.x, y: p.y + 0.3, z: p.z, rotY: 0, size: [PAD_RADIUS * 2, 0.12, PAD_RADIUS * 2], color: PAD });
    out.push({ shape: 'cyl', x: p.x, y: p.y + 0.42, z: p.z, rotY: 0, size: [PAD_RADIUS * 1.2, 0.04, PAD_RADIUS * 1.2], color: PAD_MARK });
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      out.push({ shape: 'box', x: p.x + Math.sin(a) * (PAD_RADIUS - 0.4), y: p.y + 0.42, z: p.z + Math.cos(a) * (PAD_RADIUS - 0.4), rotY: a, size: [0.5, 0.2, 0.5], color: LIGHT_GREEN, glow: true });
    }
  });
  // Control tower: shaft, glazed cab, roof, mast and a red beacon.
  const [tx, tz] = port.tower;
  const ty = port.y + 0.3;
  out.push({ shape: 'cyl', x: tx, y: ty, z: tz, rotY: 0, size: [2.6, 15, 2.6], color: '#b9bec6' });
  out.push({ shape: 'box', x: tx, y: ty + 15, z: tz, rotY: 0, size: [6, 2.4, 6], color: '#7d8794' });
  out.push({ shape: 'box', x: tx, y: ty + 15.5, z: tz, rotY: 0, size: [6.2, 0.9, 6.2], color: '#ffe9a8', glow: true });
  out.push({ shape: 'box', x: tx, y: ty + 17.4, z: tz, rotY: 0, size: [7, 0.4, 7], color: '#5c636e' });
  out.push({ shape: 'cyl', x: tx, y: ty + 17.8, z: tz, rotY: 0, size: [0.5, 2.5, 0.5], color: '#999da5' });
  out.push({ shape: 'box', x: tx, y: ty + 20.1, z: tz, rotY: 0, size: [0.9, 0.9, 0.9], color: '#ff3b3b', glow: true });
  // Edge lights round the apron, leaving a gap at the gate.
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const x = port.x + Math.sin(a) * (APRON_RADIUS - 0.8);
    const z = port.z + Math.cos(a) * (APRON_RADIUS - 0.8);
    if (Math.hypot(x - port.gate[0], z - port.gate[1]) < 4.5) continue;
    out.push({ shape: 'cyl', x, y: port.y + 0.3, z, rotY: 0, size: [0.35, 2.2, 0.35], color: '#4a4f57' });
    out.push({ shape: 'box', x, y: port.y + 2.5, z, rotY: 0, size: [0.8, 0.5, 0.8], color: LIGHT_WARM, glow: true });
  }
  return out;
}

/** The way haulers drive between the port gate and the plaza: gate, then the spur's road junction, then the plaza edge. */
export function haulPath(port: Port, layout: CityLayout): [number, number][] {
  const road = layout.roads[port.road]!;
  const near = PLAZA_RADIUS + 2.5;
  return [port.gate, port.junction, [road.dir[0] * near, road.dir[1] * near]];
}
