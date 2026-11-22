import { hashString } from '../scene/planet-look';
import { PLAZA_RADIUS } from './city-layout';
import type { Road } from './city-layout';
import type { Piece } from './industry';
import { makeRng } from './rng';

/** Market stalls ringed round the plaza edge (Phase 10). Pure: where they stand, which are open, and what they are made of. */

/** Distance of a stall's centre from the plaza middle. */
export const STALL_RADIUS = PLAZA_RADIUS - 0.8;
const SLOTS = 14;
/** Stalls keep this far (radians) from the middle of a road's mouth. */
const ROAD_GAP = 0.3;
const AWNINGS = ['#e8624f', '#e8b04f', '#4fb0e8', '#8fd46a', '#d46ad0', '#f2f2f2'];

export interface Stall {
  id: number;
  x: number;
  z: number;
  /** The counter faces the plaza middle. */
  rotY: number;
  awning: string;
  /** Position in the order stalls open: low numbers open first, so a rising share only ever opens more. */
  openRank: number;
}

/** Stalls round the plaza, leaving gaps where roads come in. Seeded by planet. */
export function layoutStalls(planet: string, roads: Pick<Road, 'angle'>[]): Stall[] {
  const rng = makeRng(hashString(`${planet}:market`));
  const ranks = Array.from({ length: SLOTS }, (_, i) => ({ i, r: rng() })).sort((a, b) => a.r - b.r);
  const stalls: Stall[] = [];
  const offset = rng() * (Math.PI * 2 / SLOTS);
  for (let k = 0; k < SLOTS; k++) {
    const a = offset + (k / SLOTS) * Math.PI * 2;
    const nearRoad = roads.some((r) => Math.abs(Math.atan2(Math.sin(a - r.angle), Math.cos(a - r.angle))) < ROAD_GAP);
    const awning = AWNINGS[Math.floor(rng() * AWNINGS.length)]!;
    if (nearRoad) continue;
    stalls.push({ id: k, x: STALL_RADIUS * Math.sin(a), z: STALL_RADIUS * Math.cos(a), rotY: a + Math.PI, awning, openRank: ranks.findIndex((r) => r.i === k) });
  }
  // Re-rank among the stalls that exist (0 to n - 1).
  const sorted = [...stalls].sort((a, b) => a.openRank - b.openRank);
  sorted.forEach((s, i) => (s.openRank = i));
  return stalls;
}

/** How many of `total` stalls are open at an open share of 0 to 1 (rounded up, so any life at all opens one). */
export function openCount(total: number, share: number): number {
  return share <= 0 ? 0 : Math.min(total, Math.ceil(share * total - 1e-9));
}

/** A stall as pieces, standing on `y`. Open: bright awning and wares on the counter. Closed: dull awning, a shutter, no wares. */
export function stallPieces(s: Stall, open: boolean, y: number): Piece[] {
  const awning = open ? s.awning : '#6b6f78';
  const base = { x: s.x, z: s.z, rotY: s.rotY };
  const out: Piece[] = [
    { shape: 'box', ...base, y, size: [2.4, 0.95, 1.1], color: '#8a6a48' },
    { shape: 'box', ...base, y: y + 2.1, size: [2.8, 0.14, 1.9], color: awning, pitch: -0.12 },
  ];
  // Posts at the front corners (the front is the local +z side, towards the plaza middle).
  for (const sx of [-1.15, 1.15]) {
    const px = s.x + Math.cos(s.rotY) * sx + Math.sin(s.rotY) * 0.75;
    const pz = s.z - Math.sin(s.rotY) * sx + Math.cos(s.rotY) * 0.75;
    out.push({ shape: 'cyl', x: px, z: pz, rotY: 0, y, size: [0.12, 2.1, 0.12], color: '#5a4a38' });
  }
  if (open) {
    out.push({ shape: 'box', ...base, y: y + 0.95, size: [1.9, 0.3, 0.7], color: s.awning });
  } else {
    out.push({ shape: 'box', x: s.x + Math.sin(s.rotY) * 0.5, z: s.z + Math.cos(s.rotY) * 0.5, rotY: s.rotY, y, size: [2.3, 1.9, 0.08], color: '#454851' });
  }
  return out;
}

/** All stalls as pieces, with the first `open` (by rank) open. */
export function marketPieces(stalls: Stall[], open: number, y = 0): Piece[] {
  return stalls.flatMap((s) => stallPieces(s, s.openRank < open, y));
}
