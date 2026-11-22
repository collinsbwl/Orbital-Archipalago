import type { Pit, TerrainSite } from './terrain-features';
import type { HeightField } from './terrain';

/**
 * Industry buildings on the terrain's sites (Phase 8). Pure: each site becomes a list of simple solid pieces (boxes,
 * cylinders, cones, domes) in world coordinates, plus the points where smoke, flame and furnace glow come from (for
 * Phase 10). `Industry.tsx` draws the pieces as instanced meshes.
 */

export type PieceShape = 'box' | 'cyl' | 'cone' | 'dome';

/** One solid. `size` is width, height, depth (for round shapes, diameter, height, diameter). It stands on (x, y, z). */
export interface Piece {
  shape: PieceShape;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Tilt about the piece's own sideways axis, radians (conveyors lean, cylinders lie down). */
  pitch?: number;
  size: [number, number, number];
  color: string;
  /** Drawn bright, unaffected by light (furnaces, flames). */
  glow?: boolean;
  /** A light that follows the time of day: dim by day, bright after dark (street lamps, port lights). Furnaces and flames glow always. */
  lamp?: boolean;
}

export type EmitterKind = 'chimney' | 'flare' | 'forge';

/** A point something comes out of: smoke from a chimney, flame from a flare stack, heat from a furnace mouth. */
export interface Emitter {
  kind: EmitterKind;
  siteId: string;
  x: number;
  y: number;
  z: number;
}

export interface IndustryModel {
  site: TerrainSite;
  pieces: Piece[];
  emitters: Emitter[];
}

const STEEL = '#8d949c';
const DARK_STEEL = '#4a4f57';
const CONCRETE = '#a9a8a2';
const FLAME = '#ff9a3a';
const FURNACE = '#ff6a1f';

/** Places pieces in a site's own frame: +z is the way the site faces, +x is to its right. */
class Builder {
  readonly pieces: Piece[] = [];
  readonly emitters: Emitter[] = [];
  private s: number;
  private c: number;

  constructor(readonly site: TerrainSite) {
    this.s = Math.sin(site.facing);
    this.c = Math.cos(site.facing);
  }

  /** World (x, z) of a point in the site's frame. */
  at(lx: number, lz: number): [number, number] {
    return [this.site.x + lx * this.c + lz * this.s, this.site.z - lx * this.s + lz * this.c];
  }

  add(shape: PieceShape, lx: number, ly: number, lz: number, size: [number, number, number], color: string, opts: { turn?: number; pitch?: number; glow?: boolean; ground?: number } = {}): void {
    const [x, z] = this.at(lx, lz);
    this.pieces.push({ shape, x, z, y: (opts.ground ?? this.site.y) + ly, rotY: this.site.facing + (opts.turn ?? 0), pitch: opts.pitch, size, color, glow: opts.glow });
  }

  emit(kind: EmitterKind, lx: number, ly: number, lz: number): void {
    const [x, z] = this.at(lx, lz);
    this.emitters.push({ kind, siteId: this.site.id, x, y: this.site.y + ly, z });
  }

  /** A storage tank: a cylinder with a lid. */
  tank(lx: number, lz: number, dia: number, h: number, color: string): void {
    this.add('cyl', lx, 0, lz, [dia, h, dia], color);
    this.add('dome', lx, h, lz, [dia, dia * 0.2, dia], STEEL);
  }

  /** A chimney or stack with an emitter at its top. */
  chimney(lx: number, lz: number, dia: number, h: number, color: string): void {
    this.add('cyl', lx, 0, lz, [dia, h, dia], color);
    this.add('cyl', lx, h, lz, [dia * 1.2, 0.5, dia * 1.2], DARK_STEEL);
    this.emit('chimney', lx, h + 0.5, lz);
  }

  /** A roof: a flat-topped pyramid over a box footprint. */
  roof(lx: number, ly: number, lz: number, w: number, d: number, h: number, color: string): void {
    this.add('cone', lx, ly, lz, [w * 1.42, h, d * 1.42], color, { turn: Math.PI / 4 });
  }
}

/** Open-cast mine: a headframe tower with a winding wheel, a shed, and a raised conveyor up the pit wall to an ore pile. */
function mine(b: Builder, pit: Pit | undefined, field: HeightField): void {
  b.add('box', 0, 0, 0, [9, 0.3, 9], CONCRETE);
  for (const sx of [-1.8, 1.8]) b.add('box', sx, 0.3, 0, [0.7, 10, 0.7], DARK_STEEL);
  b.add('box', 0, 10, 0, [4.4, 0.7, 0.7], DARK_STEEL);
  // The winding wheel: a cylinder lying with its axis across the frame (along the site's sideways axis).
  b.add('cyl', -0.3, 8.6, 0, [3.4, 0.6, 3.4], '#c2a03a', { turn: Math.PI / 2, pitch: Math.PI / 2 });
  b.add('box', 5.5, 0.3, -3.5, [4.5, 3.2, 5], '#8a6a4a');
  b.add('box', 5.5, 3.5, -3.5, [5, 0.4, 5.5], '#5a4a3a');
  if (!pit) return;
  // Conveyor on trestles: from the headframe up and out over the rim, clear of the terraces.
  const run = pit.radius + 4 - 2;
  const y0 = 6;
  const y1 = pit.depth + 1.5;
  const len = Math.hypot(run, y1 - y0);
  const pitch = -Math.atan2(y1 - y0, run);
  b.add('box', 0, y0 + (y1 - y0) / 2 - 0.4, 2 + run / 2, [1.3, 0.8, len], '#4a4f57', { pitch });
  for (const f of [0.3, 0.6, 0.88]) {
    const lz = 2 + run * f;
    const top = y0 + (y1 - y0) * f;
    const [wx, wz] = b.at(0, lz);
    const ground = field.heightAt(wx, wz);
    const base = Math.min(ground, b.site.y + top);
    b.add('box', 0, base - b.site.y, lz, [0.5, b.site.y + top - base - 0.4, 0.5], DARK_STEEL, { ground: b.site.y });
  }
  const pileZ = pit.radius + 7;
  const [px, pz] = b.at(0, pileZ);
  b.add('cone', 0, field.heightAt(px, pz) - b.site.y, pileZ, [8, 4.6, 8], '#5a3a2c');
  void pz;
}

/** Refinery: storage tanks, a distillation column, pipe rack, chimney and a tall flare stack with a flame. */
function refinery(b: Builder): void {
  b.add('box', 0, 0, 0, [34, 0.25, 30], CONCRETE);
  b.tank(-11, -5, 8.5, 6.5, '#dcd8d0');
  b.tank(-11, 6, 8.5, 6, '#d6d2ca');
  b.tank(-2, -11, 7, 5.5, '#dcd8d0');
  b.tank(8, -11, 7, 5.5, '#e0dcd4');
  b.add('cyl', 6, 0, 0, [3.2, 18, 3.2], STEEL);
  b.add('cyl', 6, 18, 0, [2.2, 1.2, 2.2], DARK_STEEL);
  b.add('cyl', 1, 0, 3, [2, 12, 2], STEEL);
  b.add('box', 3.5, 5, 1.5, [8, 0.5, 0.5], DARK_STEEL);
  b.add('box', -4, 2.2, 2, [14, 0.5, 0.5], DARK_STEEL);
  b.add('box', 0, 0.3, 11, [9, 4, 5.5], '#8c8e92');
  b.chimney(12, 6, 1.7, 14, '#7a6a62');
  // Flare stack with a flame on top.
  b.add('cyl', 14, 0, -9, [0.9, 22, 0.9], '#777c84');
  b.add('cone', 14, 22, -9, [1.5, 3, 1.5], FLAME, { glow: true });
  b.emit('flare', 14, 23.5, -9);
}

/** Farmstead: house, barn, two silos. */
function farm(b: Builder): void {
  b.add('box', -3, 0, 2, [6, 3.4, 5], '#d8c8a8');
  b.roof(-3, 3.4, 2, 6, 5, 2.6, '#a8483a');
  b.add('box', 4, 0, -3, [8, 4.4, 6], '#a8483a');
  b.roof(4, 4.4, -3, 8, 6, 3, '#6a4034');
  b.add('cyl', -4, 0, -5, [3.2, 9, 3.2], '#c8ccd0');
  b.add('dome', -4, 9, -5, [3.2, 1.4, 3.2], '#9aa0a8');
  b.add('cyl', -0.6, 0, -5.4, [3, 8, 3], '#cfd3d6');
  b.add('dome', -0.6, 8, -5.4, [3, 1.3, 3], '#9aa0a8');
}

/** Pump station on the shore: a pump house, an intake pipe running to the water, and a water tower. */
function pump(b: Builder): void {
  b.add('box', -2.6, 0, -0.5, [4, 3, 4], '#7f8a92');
  b.add('box', -2.6, 3, -0.5, [4.5, 0.4, 4.5], '#4f5860');
  b.add('box', 0, 0.5, 5, [0.7, 0.7, 9], DARK_STEEL);
  for (const [lx, lz] of [[1.4, -3.4], [4.6, -3.4], [1.4, -6.6], [4.6, -6.6]] as const) b.add('box', lx, 0, lz, [0.4, 7, 0.4], DARK_STEEL);
  b.add('box', 3, 3.4, -5, [3.4, 0.25, 0.25], DARK_STEEL, { turn: 0 });
  b.add('cyl', 3, 7, -5, [5, 3.6, 5], '#c8ccd0');
  b.add('cone', 3, 10.6, -5, [5.6, 1.8, 5.6], '#6a7480');
}

/** Forge: a long shed with two chimneys, glowing furnace mouths on the front, ingot stacks and a coal heap. */
function forge(b: Builder): void {
  b.add('box', 0, 0, -3, [13, 6, 10], '#6f5a4a');
  b.add('box', 0, 6, -3, [14, 0.6, 11], '#3f3631');
  b.chimney(-4, -6, 1.4, 11, '#4a403a');
  b.chimney(2.5, -6, 1.4, 11, '#4a403a');
  for (const lx of [-3.5, 0, 3.5]) b.add('box', lx, 0.6, 2.1, [2.4, 2.2, 0.5], FURNACE, { glow: true });
  b.emit('forge', -3.5, 1.7, 2.6);
  b.emit('forge', 0, 1.7, 2.6);
  b.emit('forge', 3.5, 1.7, 2.6);
  b.add('box', 8, 0, 3, [3, 1.2, 1.2], STEEL);
  b.add('box', 8, 1.2, 3, [2.4, 1, 1.1], '#9aa4ac');
  b.add('cone', -9, 0, 3, [4.5, 2.6, 4.5], '#2a2a2e');
}

/** Turns the terrain's sites into drawable industry. `pits` and `field` come from the terrain. */
export function buildIndustry(sites: TerrainSite[], pits: Pit[], field: HeightField): IndustryModel[] {
  return sites.map((site) => {
    const b = new Builder(site);
    switch (site.kind) {
      case 'mine':
        mine(b, pits.find((p) => Math.hypot(p.x - site.x, p.z - site.z) < 1), field);
        break;
      case 'refinery':
        refinery(b);
        break;
      case 'farm':
        farm(b);
        break;
      case 'pump':
        pump(b);
        break;
      case 'forge':
        forge(b);
        break;
    }
    return { site, pieces: b.pieces, emitters: b.emitters };
  });
}

/** Every chimney, flare and furnace mouth on the planet (Phase 10 puts smoke and flame there). */
export function industryEmitters(models: IndustryModel[]): Emitter[] {
  return models.flatMap((m) => m.emitters);
}
