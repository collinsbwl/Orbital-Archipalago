import type { Shipment } from '@orbital/contracts';
import { hashString } from '../scene/planet-look';
import { clamp, smoothstep } from './rng';

/**
 * Which freighters are at a planet's spaceport right now, and where each one is (pure). Everything is driven by the
 * smooth cycle, so ships come in and go out in step with the map.
 */

/** A ship lands over the last cycle before it arrives, and takes off over the first cycle after it departs. */
export const LANDING_CYCLES = 1;
export const TAKEOFF_CYCLES = 1;
/** A departing ship sits on its pad this many cycles before it lifts off, so it never pops into view at takeoff. */
export const PRE_DEPART_CYCLES = 1;
/** After landing a ship sits on its pad this many cycles. */
export const PARKED_CYCLES = 3;
/** How many ships the port can show at once (one per pad). */
export const DEFAULT_PADS = 4;

export type PortPhase = 'landing' | 'takeoff' | 'parked';

export interface PhaseAt {
  phase: PortPhase;
  /** Progress through the phase, 0 to 1 (parked: how far through its stay). */
  t: number;
}

/** What a shipment is doing at this planet at this (fractional) cycle, or null if it is not at the port. */
export function shipPhase(s: Pick<Shipment, 'from' | 'to' | 'departCycle' | 'arriveCycle'>, planet: string, cycle: number): PhaseAt | null {
  if (s.from === s.to) return null;
  if (s.to === planet) {
    const landStart = s.arriveCycle - LANDING_CYCLES;
    if (cycle >= landStart && cycle < s.arriveCycle) return { phase: 'landing', t: (cycle - landStart) / LANDING_CYCLES };
    if (cycle >= s.arriveCycle && cycle < s.arriveCycle + PARKED_CYCLES) return { phase: 'parked', t: (cycle - s.arriveCycle) / PARKED_CYCLES };
  }
  if (s.from === planet) {
    const readyAt = s.departCycle - PRE_DEPART_CYCLES;
    if (cycle >= readyAt && cycle < s.departCycle) return { phase: 'parked', t: (cycle - readyAt) / PRE_DEPART_CYCLES };
    if (cycle >= s.departCycle && cycle < s.departCycle + TAKEOFF_CYCLES) return { phase: 'takeoff', t: (cycle - s.departCycle) / TAKEOFF_CYCLES };
  }
  return null;
}

/** The pad a ship would like: fixed by its id. */
export function padFor(id: string, padCount: number): number {
  return hashString(`pad:${id}`) % Math.max(1, padCount);
}

export interface PortShip {
  shipment: Shipment;
  pad: number;
}

/** When a shipment first shows at this planet's port and when it is gone again (cycles), or null if it never touches it. */
export function presence(s: Pick<Shipment, 'from' | 'to' | 'departCycle' | 'arriveCycle'>, planet: string): { since: number; until: number } | null {
  if (s.from === s.to) return null;
  if (s.to === planet) return { since: s.arriveCycle - LANDING_CYCLES, until: s.arriveCycle + PARKED_CYCLES };
  if (s.from === planet) return { since: s.departCycle - PRE_DEPART_CYCLES, until: s.departCycle + TAKEOFF_CYCLES };
  return null;
}

/** Every shipment that touches the port, with its pad, in order of arrival. Built once per snapshot, not per frame. */
export interface PortPlan {
  ships: { shipment: Shipment; pad: number; since: number; until: number }[];
}

/**
 * Gives every shipment that touches the port a pad, in order of arrival (then id). Each ship takes its hashed pad, or the
 * next one not held by a ship that is still there when it shows up; if every pad is held it gets none. A ship's pad
 * depends only on ships that came before it, so it never changes while it sits there, and a departure never shuffles the rest.
 */
export function planPort(shipments: Shipment[], planet: string, padCount = DEFAULT_PADS): PortPlan {
  const pads = Math.max(1, padCount);
  const all = shipments
    .map((shipment) => ({ shipment, at: presence(shipment, planet) }))
    .filter((x): x is { shipment: Shipment; at: { since: number; until: number } } => x.at !== null)
    .sort((a, b) => a.at.since - b.at.since || (a.shipment.id < b.shipment.id ? -1 : a.shipment.id > b.shipment.id ? 1 : 0));
  const placed: PortPlan['ships'] = [];
  for (const { shipment, at } of all) {
    const held = new Set(placed.filter((p) => p.until > at.since).map((p) => p.pad));
    if (held.size >= pads) continue;
    let pad = padFor(shipment.id, pads);
    while (held.has(pad)) pad = (pad + 1) % pads;
    placed.push({ shipment, pad, since: at.since, until: at.until });
  }
  return { ships: placed };
}

/** The ships at the port at this cycle, from a plan. Cheap enough to call every frame. */
export function shipsAt(plan: PortPlan, planet: string, cycle: number): PortShip[] {
  const out: PortShip[] = [];
  for (const p of plan.ships) if (cycle >= p.since && cycle < p.until && shipPhase(p.shipment, planet, cycle)) out.push({ shipment: p.shipment, pad: p.pad });
  return out;
}

/** Every shipment at the port right now, each on its own pad (see `planPort`). Never more ships than pads. */
export function portTraffic(shipments: Shipment[], planet: string, cycle: number, padCount = DEFAULT_PADS): PortShip[] {
  return shipsAt(planPort(shipments, planet, padCount), planet, cycle);
}

/** Height of the ship's centre above its pad when parked, metres (it stands on its tail, nose up). */
export const REST_HEIGHT = 7.5;
/** Where a ship starts its descent (and ends its climb): this high and this far out along the approach heading. */
export const APPROACH_ALTITUDE = 220;
export const APPROACH_DISTANCE = 380;

export interface ShipPose {
  /** Offset from the pad centre, metres. */
  x: number;
  y: number;
  z: number;
  /** Unit vector the nose points along. */
  nose: [number, number, number];
  /** 0 to 1: shrinks to nothing at the far end of the approach, so ships never pop in or out. */
  fade: number;
  /** True while the engine is lit (not when parked). */
  burning: boolean;
}

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Where a ship is relative to its pad. Landing: glides in from far out and high up, slowing to a soft touchdown and
 * swinging its nose up. Takeoff is the same path run backwards, with the nose starting up. `heading` is the compass
 * direction (direction vector (sin, cos)) the ships come in from.
 */
export function shipPose(at: PhaseAt, heading: number): ShipPose {
  const out = [Math.sin(heading), 0, Math.cos(heading)] as const;
  if (at.phase === 'parked') return { x: 0, y: REST_HEIGHT, z: 0, nose: [0, 1, 0], fade: 1, burning: false };
  // `s` is how much of the approach is left: 1 far out, 0 on the pad. It eases, so the ship is slow near the ground.
  const landing = at.phase === 'landing';
  const t = clamp(at.t, 0, 1);
  const s = landing ? (1 - t) ** 2 : t ** 2;
  const horizontal = APPROACH_DISTANCE * s * s;
  const y = REST_HEIGHT + APPROACH_ALTITUDE * s;
  // Heading of travel along the ground: towards the pad when landing, away when taking off.
  const sign = landing ? -1 : 1;
  const flat: [number, number, number] = [out[0] * sign, 0.12 * sign, out[2] * sign]; // nose down while descending, up while climbing
  const up = landing ? smoothstep(0.45, 0.92, t) : 1 - smoothstep(0.08, 0.55, t);
  const nose = norm([flat[0] * (1 - up), flat[1] * (1 - up) + up, flat[2] * (1 - up)]);
  return { x: out[0] * horizontal, y, z: out[2] * horizontal, nose, fade: 1 - smoothstep(0.82, 1, s), burning: true };
}
