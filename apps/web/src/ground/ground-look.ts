import * as THREE from 'three';
import { hashString } from '../scene/planet-look';

/** What a storm drops on a planet. */
export type PrecipKind = 'rain' | 'dust' | 'snow';

/** Colors and mood for one planet's surface scene. Swapping in real art later means changing this file. */
export interface GroundLook {
  /** Colour at the horizon. The fog uses the same colour so distant ground melts into the sky. */
  sky: string;
  /** Colour straight overhead. */
  skyTop: string;
  sunColor: string;
  /** Sun height above the horizon, radians. */
  sunElevation: number;
  /** Main ground colour (also the colour of the light bounced up from the ground). */
  ground: string;
  /** Ground patches: faces pick among these by noise. */
  palette: string[];
  /** Steep slopes and bare mountain flanks. */
  rock: string;
  /** High mountain tops (snow, pale dust). */
  peak: string;
  fogNear: number;
  fogFar: number;
  /** What falls in a storm: rain, blowing dust or snow. */
  precip: PrecipKind;
  /** Building colours for the city. */
  buildings: string[];
  /** How wild the land is: rolling hills near the city and a mountain ring far out, in metres. */
  relief: { hills: number; hillScale: number; mountains: number; mountainStart: number };
}

const KNOWN: Record<string, GroundLook> = {
  // Verdan: blue sky, green land.
  verdan: {
    sky: '#8cc8ff', skyTop: '#2f78d0', sunColor: '#fff4d8', sunElevation: 0.9,
    ground: '#5a9a4a', palette: ['#5a9a4a', '#4b8a40', '#6aae52', '#7ab85c'], rock: '#7d7a70', peak: '#f2f6f8',
    fogNear: 70, fogFar: 430, precip: 'rain',
    buildings: ['#e8e2d4', '#d9c2a4', '#c9d6dc', '#b9604a'],
    relief: { hills: 4.5, hillScale: 110, mountains: 85, mountainStart: 250 },
  },
  // Helion: dusty orange, rusty rock.
  helion: {
    sky: '#d99a5b', skyTop: '#9a5a3c', sunColor: '#ffd9a0', sunElevation: 0.5,
    ground: '#b0683a', palette: ['#b0683a', '#9c5a30', '#c27d48', '#8a4c2c'], rock: '#6e4130', peak: '#d8a878',
    fogNear: 45, fogFar: 360, precip: 'dust',
    buildings: ['#c9a27c', '#a8794f', '#8c8a86', '#d9b48c'],
    relief: { hills: 3.5, hillScale: 90, mountains: 70, mountainStart: 220 },
  },
  // Tethys: pale ice.
  tethys: {
    sky: '#dfeef6', skyTop: '#8cb8de', sunColor: '#eef8ff', sunElevation: 0.42,
    ground: '#e8f4fa', palette: ['#e8f4fa', '#d4ebf5', '#f4fafd', '#c2e0ee'], rock: '#8fa6b8', peak: '#ffffff',
    fogNear: 55, fogFar: 400, precip: 'snow',
    buildings: ['#cfe3ee', '#9fc4da', '#eef6fa', '#7fa6c0'],
    relief: { hills: 2.5, hillScale: 120, mountains: 120, mountainStart: 160 },
  },
};

const cache = new Map<string, GroundLook>();

function hex(h: number, s: number, l: number): string {
  return `#${new THREE.Color().setHSL(((h % 1) + 1) % 1, s, l).getHexString()}`;
}

/** A look for a planet we know nothing about, made from its id so it is the same every time. */
function generatedLook(id: string): GroundLook {
  const h = hashString(id);
  const hue = (h % 360) / 360;
  const skyHue = ((h >>> 9) % 360) / 360;
  return {
    sky: hex(skyHue, 0.45, 0.72), skyTop: hex(skyHue + 0.02, 0.5, 0.48), sunColor: '#fff0d8', sunElevation: 0.45 + ((h >>> 5) % 40) / 100,
    ground: hex(hue, 0.35, 0.45), palette: [hex(hue, 0.35, 0.45), hex(hue + 0.03, 0.32, 0.4), hex(hue - 0.03, 0.38, 0.5), hex(hue + 0.06, 0.3, 0.36)],
    rock: hex(hue, 0.12, 0.42), peak: hex(hue, 0.1, 0.9), fogNear: 60, fogFar: 400, precip: (['rain', 'rain', 'dust', 'snow'] as const)[(h >>> 11) % 4]!,
    buildings: [hex(hue, 0.15, 0.78), hex(hue + 0.08, 0.25, 0.62), hex(hue - 0.08, 0.2, 0.7), hex(hue + 0.5, 0.3, 0.55)],
    relief: { hills: 3 + (h % 30) / 10, hillScale: 100, mountains: 60 + (h % 40), mountainStart: 230 },
  };
}

/** The look for a planet: hand-made for the default planets, generated from the id for any other. */
export function groundLookFor(planetId: string): GroundLook {
  let look = KNOWN[planetId] ?? cache.get(planetId);
  if (!look) {
    look = generatedLook(planetId);
    cache.set(planetId, look);
  }
  return look;
}

/** The goods each default planet makes. Other planets get two goods picked from their id. */
const GOODS: Record<string, string[]> = {
  helion: ['iron', 'fuel'],
  verdan: ['grain', 'water'],
  tethys: ['water', 'tools'],
};
const ALL_GOODS = ['iron', 'fuel', 'grain', 'water', 'tools'];

/** Goods a planet produces. Later phases use this to shape terrain and pick industry buildings. */
export function goodsOf(planetId: string): string[] {
  const known = GOODS[planetId];
  if (known) return known;
  const h = hashString(planetId);
  const a = h % ALL_GOODS.length;
  const b = (a + 1 + ((h >>> 8) % (ALL_GOODS.length - 1))) % ALL_GOODS.length;
  return [ALL_GOODS[a]!, ALL_GOODS[b]!];
}

/**
 * A fixed unit vector pointing at the sun, used only when the map gives no planet position (see sky-bodies.ts for the
 * real sun direction). The azimuth comes from the planet id, the height from the look. */
export function sunDirection(planetId: string, look: GroundLook): [number, number, number] {
  const az = ((hashString(planetId) >>> 3) % 360) * (Math.PI / 180);
  const c = Math.cos(look.sunElevation);
  return [c * Math.sin(az), Math.sin(look.sunElevation), c * Math.cos(az)];
}
