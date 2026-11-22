import type { SimEvent } from '@orbital/contracts';
import { hashString } from '../scene/planet-look';
import { fieldLocal } from './terrain-features';
import type { FieldPatch } from './terrain-features';
import { clamp, makeRng, smoothstep } from './rng';

/**
 * Crops on the terrain's fields (Phase 10). Pure: where each plant stands, how tall it is at a cycle (it grows from
 * sowing to harvest, then the field is cut and sown again), and how brown a drought or blight has turned it.
 */

/** Cycles from sowing to harvest. */
export const CROP_PERIOD = 48;
/** Share of the period the crop is still growing; after that it stands ripe until the harvest. */
const RIPE_AT = 0.8;
/** Most plants over all fields. */
export const MAX_PLANTS = 1500;
const MIN_SPACING = 2.6;
const EDGE = 1.6;
/** A blight or drought stays in the crops this many cycles, fading over the second half. */
export const BLIGHT_CYCLES = 24;

/**
 * How grown a crop is at a cycle, 0 (just sown, a seedling) to 1 (ripe). Each field has its own phase (0 to 1), so the
 * fields are not all cut on the same day. At the harvest it drops back to 0.
 */
export function cropGrowth(cycle: number, phase: number): number {
  const t = (((cycle / CROP_PERIOD + phase) % 1) + 1) % 1;
  return smoothstep(0, RIPE_AT, t);
}

/** A field's own phase, from its id. */
export const fieldPhase = (fieldId: string): number => (hashString(`crop:${fieldId}`) % 1000) / 1000;

/** Words in a headline that mean the crops have failed. */
const FAILURE = /drought|blight|famine|crop fail|harvest fail/i;

/** True when an event is about a planet: it names it in its `planet` field or its text (fixture events often lack the field). */
export function eventAboutPlanet(e: Pick<SimEvent, 'planet' | 'text'>, planet: string): boolean {
  const name = planet.toLowerCase();
  return (e.planet ?? '').toLowerCase() === name || e.text.toLowerCase().includes(name);
}

/**
 * How badly crops on a planet are hit, 0 to 1: the strongest recent drought or blight event that names the planet
 * (in its `planet` field or its text). Full for the first half of `BLIGHT_CYCLES`, then easing off to nothing.
 */
export function blightLevel(events: Pick<SimEvent, 'cycle' | 'kind' | 'planet' | 'text'>[], planet: string, cycle: number): number {
  let worst = 0;
  for (const e of events) {
    if (e.kind === 'policy') continue;
    if (!FAILURE.test(e.text)) continue;
    if (!eventAboutPlanet(e, planet)) continue;
    const age = cycle - e.cycle;
    if (age < 0 || age > BLIGHT_CYCLES) continue;
    worst = Math.max(worst, 1 - smoothstep(BLIGHT_CYCLES / 2, BLIGHT_CYCLES, age));
  }
  return worst;
}

const SPROUT: [number, number, number] = [0.45, 0.76, 0.28];
const RIPE: [number, number, number] = [0.85, 0.73, 0.29];
const BROWN: [number, number, number] = [0.43, 0.29, 0.17];

/** Plant colour (r, g, b in 0..1): green sprout to golden ripe, browned by blight. `tint` (0 to 1) varies it a little per plant. */
export function cropColor(growth: number, blight: number, tint = 0.5): [number, number, number] {
  const ripe = smoothstep(0.55, 1, growth);
  const shade = 0.9 + tint * 0.2;
  return [0, 1, 2].map((i) => {
    const base = SPROUT[i]! + (RIPE[i]! - SPROUT[i]!) * ripe;
    return clamp((base + (BROWN[i]! - base) * clamp(blight, 0, 1)) * shade, 0, 1);
  }) as [number, number, number];
}

/** Plant height, metres, at a growth stage: a low sprout to a full crop. A blight stunts it a little. */
export function cropHeight(growth: number, blight: number): number {
  return (0.18 + 0.95 * growth) * (1 - 0.3 * clamp(blight, 0, 1));
}

export interface Plant {
  x: number;
  y: number;
  z: number;
  /** Index of the field in the list given. */
  field: number;
  /** The field's growth phase, 0 to 1. */
  phase: number;
  /** 0 to 1, varies colour and size a little. */
  tint: number;
  rotY: number;
}

/** Plants in rows across every field, at most `max` over all of them (the spacing widens to fit). Same fields, same plants. */
export function cropPlants(fields: FieldPatch[], max = MAX_PLANTS): Plant[] {
  if (fields.length === 0) return [];
  const area = fields.reduce((s, f) => s + 4 * (f.halfW - EDGE) * (f.halfD - EDGE), 0);
  const spacing = Math.max(MIN_SPACING, Math.sqrt(area / max) * 1.02);
  const out: Plant[] = [];
  fields.forEach((f, index) => {
    const rng = makeRng(hashString(`crop-plants:${f.id}`));
    const phase = fieldPhase(f.id);
    const c = Math.cos(f.rotY);
    const s = Math.sin(f.rotY);
    const cols = Math.max(1, Math.floor((2 * (f.halfW - EDGE)) / spacing) + 1);
    const rows = Math.max(1, Math.floor((2 * (f.halfD - EDGE)) / spacing) + 1);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const u = (i - (cols - 1) / 2) * spacing + (rng() - 0.5) * 0.5;
        const v = (j - (rows - 1) / 2) * spacing + (rng() - 0.5) * 0.5;
        const tint = rng();
        const rotY = rng() * Math.PI * 2;
        if (out.length >= max) continue;
        // Inverse of `fieldLocal`: (u, v) back to world.
        out.push({ x: f.x + u * c + v * s, y: f.y, z: f.z - u * s + v * c, field: index, phase, tint, rotY });
      }
    }
  });
  return out;
}

/** True when a world point is inside a field (used by tests and by anything that must stay out of crops). */
export function insideField(f: FieldPatch, x: number, z: number): boolean {
  const { u, v } = fieldLocal(f, x, z);
  return Math.abs(u) <= f.halfW && Math.abs(v) <= f.halfD;
}
