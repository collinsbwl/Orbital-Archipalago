import { hashString } from '../scene/planet-look';
import { PLAZA_RADIUS } from './city-layout';
import type { CityLayout } from './city-layout';
import type { Piece } from './industry';
import { makeRng } from './rng';
import type { Stall } from './market';

/**
 * A primitive settlement (Helion's hides and mud, Tethys's frost-white tents): a campfire in the middle of a packed-earth clearing, log seats, hide tents and mud
 * huts, worn dirt trails where the city's roads would run, torches along them and drying racks round the edge. It reuses
 * the city layout for its positions (so the camera landing, the spaceport and the walking aliens all still line up) but
 * draws none of the city. Pure: the same layout gives the same camp.
 */

/** Planets that get the camp in place of the city. */
export const CAMP_PLANETS: readonly string[] = ['helion', 'tethys'];
export const isCampPlanet = (planet: string): boolean => CAMP_PLANETS.includes(planet);

/** Mines, fields and lakes are placed out from here on a camp planet (the city's are out from 100). */
export const CAMP_SITE_RADIUS = 45;
export const CLEARING_TOP = 0.1;
/** Fire ring radius, metres. */
export const FIRE_RING = 1.3;
/** Trails are this wide (the city's roads are 7). */
export const TRAIL_WIDTH = 2.4;
/** Huts stand on the inner rings only: a camp, not a metropolis. */
const MAX_HUT_RING = 1;
interface CampTheme {
  hides: string[];
  mud: string[];
  thatch: string;
  trim: string;
  stone: string[];
  clearing: [string, string];
  trails: [string, string];
  racks: string[];
  /** Dwellings are igloos (a snow dome with a tunnel entrance) instead of tipis, towers and lodges. */
  igloos?: boolean;
}

/** Helion's dusty hide-and-mud camp, and Tethys's frosty one: pale insulated tents on ice-block platforms, snow-capped. */
const THEMES: Record<string, CampTheme> = {
  helion: {
    hides: ['#8a6a4a', '#a8845a', '#7a5a40', '#b89a70', '#6f523a'],
    mud: ['#9a6e48', '#a87a50', '#8c6340'],
    thatch: '#c9a85a',
    trim: '#d8b070',
    stone: ['#7d7468', '#6a6258', '#8a8176'],
    clearing: ['#8c5c36', '#7a4e2e'],
    trails: ['#8a5c36', '#7e5230'],
    racks: ['#a8845a', '#8a6a4a', '#c9a27c'],
  },
  tethys: {
    hides: ['#dfe8f0', '#c8d8e6', '#b4c8dc', '#e8eef4', '#a9bfd4'],
    mud: ['#8fa6bd', '#9db3c8', '#7f97ae'],
    thatch: '#f1f6fb',
    trim: '#7fa8c8',
    stone: ['#bcd4e6', '#a6c2d8', '#cfe2ef'],
    clearing: ['#c9d6e0', '#b5c5d3'],
    trails: ['#aebccb', '#9fb0c1'],
    racks: ['#d7e2ec', '#b9cbdb', '#e9f0f6'],
    igloos: true,
  },
};
const themeOf = (planet: string): CampTheme => THEMES[planet] ?? THEMES.helion!;
const WOOD = '#5a3d28';

/** A log lying on the ground: centre (cx, cz), resting at height y, `len` long, heading `rotY`. */
function log(cx: number, cz: number, y: number, len: number, radius: number, rotY: number, color = WOOD): Piece {
  // A cylinder pitched a quarter turn points along (sin rotY, cos rotY) from its base, so start half a length back.
  const dx = Math.sin(rotY);
  const dz = Math.cos(rotY);
  return { shape: 'cyl', x: cx - (dx * len) / 2, y: y + radius, z: cz - (dz * len) / 2, rotY, pitch: Math.PI / 2, size: [radius * 2, len, radius * 2], color };
}

const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** The clearing, fire ring, firewood and seat logs. Seats leave gaps where trails come in. */
export function clearingPieces(layout: CityLayout, planet: string): Piece[] {
  const { stone: STONE, clearing } = themeOf(planet);
  const rng = makeRng(hashString(`${planet}:camp-clearing`));
  const out: Piece[] = [
    { shape: 'cyl', x: 0, y: 0, z: 0, rotY: 0, size: [PLAZA_RADIUS * 2, CLEARING_TOP, PLAZA_RADIUS * 2], color: clearing[0] },
    { shape: 'cyl', x: 0, y: CLEARING_TOP, z: 0, rotY: 0, size: [PLAZA_RADIUS * 1.15, 0.02, PLAZA_RADIUS * 1.15], color: clearing[1] },
    { shape: 'cyl', x: 0, y: CLEARING_TOP, z: 0, rotY: 0, size: [FIRE_RING * 2.6, 0.04, FIRE_RING * 2.6], color: '#2e2622' },
  ];
  // Fire ring of stones.
  const stones = 11;
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2;
    const s = 0.42 + rng() * 0.2;
    out.push({ shape: 'box', x: FIRE_RING * Math.sin(a), y: CLEARING_TOP, z: FIRE_RING * Math.cos(a), rotY: a + rng(), size: [s, 0.3 + rng() * 0.2, s], color: STONE[i % STONE.length]! });
  }
  // Logs piled in the fire, crossed.
  for (let i = 0; i < 4; i++) {
    out.push(log(0, 0, CLEARING_TOP + (i > 2 ? 0.28 : 0), 1.7, 0.14, (i / 4) * Math.PI + 0.3, i % 2 ? '#3a2a1e' : '#4a3424'));
  }
  // Seat logs round the fire, with gaps where trails arrive.
  const seats = 9;
  const off = rng() * 0.6;
  for (let i = 0; i < seats; i++) {
    const a = off + (i / seats) * Math.PI * 2;
    if (layout.roads.some((r) => gap(a, r.angle) < 0.25)) continue;
    const r = 3.3 + rng() * 0.3;
    out.push(log(r * Math.sin(a), r * Math.cos(a), CLEARING_TOP, 1.9 + rng() * 0.6, 0.24, a + Math.PI / 2, i % 2 ? '#6b4a2f' : '#5a3d28'));
  }
  // A stack of firewood by the edge, and a few stones about.
  const wood = off + 1.1;
  for (let i = 0; i < 3; i++) {
    out.push(log(7 * Math.sin(wood) + (i - 1) * 0.5 * Math.cos(wood), 7 * Math.cos(wood) - (i - 1) * 0.5 * Math.sin(wood), CLEARING_TOP, 1.5, 0.18, wood + Math.PI / 2));
  }
  out.push(log(7 * Math.sin(wood), 7 * Math.cos(wood), CLEARING_TOP + 0.36, 1.5, 0.18, wood + Math.PI / 2, '#6b4a2f'));
  return out;
}

/** Teal glow used for crystals and door lights on the huts: the "future" in futuristic-primitive. */
export const CRYSTAL = '#6ff0dc';

/** Round pieces are 10-sided, so a face is 36 degrees wide, and its flat middle is this fraction of the corner radius out. */
const APOTHEM = Math.cos(Math.PI / 10);
/** Turn that puts a flat face (not a corner) in the direction the piece is rotated to. */
const FACE = Math.PI / 10;

/**
 * Bigger, more elaborate dwellings that look hand-made but a little alien: each stands on a stone platform, has banded
 * walls, a glowing doorway and a crystal on a pole (the glow dims by day, brightens after dark). Doors face the fire.
 * Which ones stand follows the city's population tier. Every part sits inside or on top of the one under it (round parts
 * are turned so a flat face points at the door), so no corners poke through a neighbour's surface.
 */
export function hutPieces(layout: CityLayout, planet: string): Piece[] {
  const { hides: HIDES, mud: MUD, thatch: THATCH, stone: STONE, trim, igloos } = themeOf(planet);
  const out: Piece[] = [];
  for (const b of layout.buildings) {
    if (b.ring > MAX_HUT_RING) continue;
    const h = hashString(`${planet}:${b.id}`);
    if (h % 7 === 0) continue; // gaps, so it does not read as a grid
    const r = Math.min(3.6, Math.max(2.6, Math.min(b.w, b.d) * 0.6));
    const hide = HIDES[(h >>> 3) % HIDES.length]!;
    const mud = MUD[(h >>> 5) % MUD.length]!;
    const yaw = Math.atan2(-b.x, -b.z); // door faces the fire
    const at = (dist: number, turn = 0, cx = b.x, cz = b.z) => ({ x: cx + Math.sin(yaw + turn) * dist, z: cz + Math.cos(yaw + turn) * dist });
    const base = { x: b.x, z: b.z, rotY: yaw };
    /** A round part of the hut, turned so a flat face points at the door. */
    const drum = (y: number, height: number, diameter: number, color: string, cx = b.x, cz = b.z): Piece => ({
      shape: 'cyl', x: cx, z: cz, rotY: yaw + FACE, y, size: [diameter, height, diameter], color,
    });
    /** A door set into the face of a drum of the given diameter: a dark slab with a glowing lintel just above it. */
    const door = (drumDiameter: number, y: number, dw: number, dh: number, cx = b.x, cz = b.z) => {
      const dist = (drumDiameter / 2) * APOTHEM;
      out.push({ shape: 'box', ...at(dist + 0.04, 0, cx, cz), y, rotY: yaw, size: [dw, dh, 0.16], color: '#2a1e16' });
      out.push({ shape: 'box', ...at(dist + 0.06, 0, cx, cz), y: y + dh, rotY: yaw, size: [dw * 1.1, 0.14, 0.22], color: CRYSTAL, glow: true, lamp: true });
    };
    const crystal = (y: number, height: number, cx = b.x, cz = b.z) => {
      out.push({ shape: 'cyl', x: cx, z: cz, rotY: 0, y, size: [0.12, height, 0.12], color: WOOD });
      out.push({ shape: 'cone', x: cx, z: cz, rotY: 0, y: y + height, size: [0.42, 0.9, 0.42], color: CRYSTAL, glow: true, lamp: true });
    };
    // Stone platform under every dwelling.
    out.push(drum(0, 0.15, r * 2.7, STONE[(h >>> 7) % STONE.length]!));
    if (igloos) {
      // Igloo: a low ice-block wall, a snow dome, a tunnel entrance with its own platform, a glowing door and a crystal.
      const d = r * 2.4;
      const reach = r * 1.3; // tunnel centre, out from the dome's centre
      const td = r * 1.1;
      out.push(drum(0.15, 0.5, d, STONE[(h >>> 9) % STONE.length]!));
      out.push(drum(0.65, 0.12, d * 1.06, trim));
      out.push({ shape: 'dome', ...base, y: 0.77, size: [d * 0.95, r * 1.45, d * 0.95], color: hide });
      const mouth = at(reach);
      out.push(drum(0, 0.15, td * 1.5, STONE[(h >>> 11) % STONE.length]!, mouth.x, mouth.z));
      out.push({ shape: 'dome', x: mouth.x, z: mouth.z, rotY: yaw + FACE, y: 0.15, size: [td, r * 0.85, td], color: hide });
      door(td, 0.15, r * 0.5, 0.75, mouth.x, mouth.z);
      if (h % 3 === 1) {
        // A smaller second dome joined on the side.
        const side = at(r * 1.7, Math.PI / 2);
        out.push(drum(0, 0.15, r * 2.2, STONE[(h >>> 13) % STONE.length]!, side.x, side.z));
        out.push({ shape: 'dome', x: side.x, z: side.z, rotY: yaw + FACE, y: 0.15, size: [r * 1.7, r * 1.1, r * 1.7], color: hide });
      }
      crystal(0.77 + r * 1.45 - 0.1, 0.6);
      continue;
    }
    switch (h % 3) {
      case 0: {
        // Grand tipi: a mud drum with a gold band, a tall hide cone on top, and a crystal at the crown.
        const d = r * 2.2;
        const cone = r * 2.6;
        out.push(drum(0.15, 1.3, d, mud));
        out.push(drum(1.3, 0.14, d * 1.08, trim));
        out.push({ shape: 'cone', ...base, y: 1.44, size: [cone * 0.95, r * 2.3, cone * 0.95], color: hide });
        for (const k of [-1, 1]) out.push({ shape: 'cyl', ...base, y: 1.44 + r * 2.3 - 0.4, pitch: k * 0.3, size: [0.13, 1.8, 0.13], color: WOOD });
        crystal(1.44 + r * 2.3 + 0.9, 0.5);
        door(d, 0.15, r * 0.55, 1.0);
        break;
      }
      case 1: {
        // Stepped mud tower: three tapering drums with glowing slit windows, a thatch cap and a crystal mast.
        const tiers: [number, number][] = [[r * 2.2, 1.7], [r * 1.7, 1.4], [r * 1.25, 1.2]];
        let y = 0.15;
        tiers.forEach(([d, th], i) => {
          out.push(drum(y, th, d, mud));
          out.push(drum(y + th - 0.14, 0.14, d * 1.1, trim));
          // Slit windows on the faces either side of the door's.
          for (const turn of [-Math.PI / 5, Math.PI / 5]) {
            out.push({ shape: 'box', ...at((d / 2) * APOTHEM + 0.03, turn), y: y + th * 0.3, rotY: yaw + turn, size: [0.22, th * 0.4, 0.1], color: CRYSTAL, glow: true, lamp: true });
          }
          if (i === 0) door(d, y, r * 0.55, 1.4);
          y += th;
        });
        out.push({ shape: 'cone', ...base, y, size: [r * 1.5, 1.3, r * 1.5], color: THATCH });
        crystal(y + 1.1, 1.0);
        break;
      }
      default: {
        // Dome lodge: a wide dome set inside a stone drum's rim, with a gold ring, and a thatched side wing.
        const d = r * 2.3;
        out.push(drum(0.15, 1.6, d, mud));
        out.push(drum(1.65, 0.14, d * 1.08, trim));
        out.push({ shape: 'dome', ...base, y: 1.79, size: [d * 0.9, r * 1.2, d * 0.9], color: hide });
        const wing = at(r * 1.75, Math.PI / 2);
        const wd = r * 1.1;
        out.push(drum(0, 1.75, wd, mud, wing.x, wing.z));
        out.push({ shape: 'cone', x: wing.x, z: wing.z, rotY: yaw, y: 1.75, size: [wd * 1.3, 1.1, wd * 1.3], color: THATCH });
        crystal(1.79 + r * 1.2 - 0.1, 0.7);
        door(d, 0.15, r * 0.55, 1.3);
      }
    }
  }
  return out;
}

/** Worn dirt trails where the roads run, with the odd stone beside them. */
export function trailPieces(layout: CityLayout, planet: string): Piece[] {
  const { stone: STONE, trails } = themeOf(planet);
  const rng = makeRng(hashString(`${planet}:camp-trails`));
  const out: Piece[] = [];
  const step = 6;
  for (const r of layout.roads) {
    for (let d = PLAZA_RADIUS - 1; d < r.length - 1; d += step) {
      const wobble = Math.sin(d * 0.21 + r.index * 2.1) * 0.35;
      const mid = d + step / 2;
      const w = TRAIL_WIDTH * (0.85 + rng() * 0.35);
      out.push({
        shape: 'box', x: r.dir[0] * mid + r.side[0] * wobble, y: 0, z: r.dir[1] * mid + r.side[1] * wobble, rotY: r.angle + (rng() - 0.5) * 0.05,
        size: [w, 0.07, step + 0.6], color: rng() < 0.5 ? trails[0] : trails[1],
      });
      if (rng() < 0.3) {
        const side = rng() < 0.5 ? 1 : -1;
        const s = 0.3 + rng() * 0.35;
        const lateral = TRAIL_WIDTH * 0.8 + rng() * 0.8;
        out.push({ shape: 'box', x: r.dir[0] * mid + r.side[0] * lateral * side, y: 0, z: r.dir[1] * mid + r.side[1] * lateral * side, rotY: rng() * 3, size: [s, s * 0.7, s], color: STONE[Math.floor(rng() * STONE.length)]! });
      }
    }
  }
  return out;
}

/** Torches on posts along the trails: a flame that is dim by day and bright after dark. */
export function torchPieces(layout: CityLayout): Piece[] {
  const out: Piece[] = [];
  for (const r of layout.roads) {
    for (let d = PLAZA_RADIUS + 5; d < 52; d += 14) {
      for (const side of [1, -1]) {
        const x = r.dir[0] * d + r.side[0] * (TRAIL_WIDTH / 2 + 0.7) * side;
        const z = r.dir[1] * d + r.side[1] * (TRAIL_WIDTH / 2 + 0.7) * side;
        out.push({ shape: 'cyl', x, y: 0, z, rotY: 0, size: [0.12, 1.8, 0.12], color: WOOD });
        out.push({ shape: 'cone', x, y: 1.8, z, rotY: 0, size: [0.26, 0.42, 0.26], color: '#ffb040', glow: true, lamp: true });
      }
    }
  }
  return out;
}

/** A hide-drying rack: two posts, a crossbar and hides hung from it (more of them when the stall is "open"). */
export function rackPieces(s: Stall, open: boolean, planet = 'helion'): Piece[] {
  const base = { x: s.x, z: s.z, rotY: s.rotY };
  const out: Piece[] = [{ shape: 'box', ...base, y: 1.7, size: [2.6, 0.12, 0.12], color: WOOD }];
  for (const sx of [-1.3, 1.3]) {
    out.push({ shape: 'cyl', x: s.x + Math.cos(s.rotY) * sx, z: s.z - Math.sin(s.rotY) * sx, y: CLEARING_TOP, rotY: 0, size: [0.14, 1.75, 0.14], color: WOOD });
  }
  if (open) {
    const hides = themeOf(planet).racks;
    [-0.8, 0, 0.8].forEach((k, i) => {
      out.push({
        shape: 'box', x: s.x + Math.cos(s.rotY) * k, z: s.z - Math.sin(s.rotY) * k, y: 0.75, rotY: s.rotY, size: [0.6, 0.95, 0.06], color: hides[i]!,
      });
    });
  }
  return out;
}
