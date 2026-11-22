import { PLAZA_RADIUS, ROAD_WIDTH, SIDEWALK_WIDTH } from './city-layout';
import type { CityLayout } from './city-layout';
import type { Piece } from './industry';

/** Festival decorations (Phase 11), shown in a festive mood: banners on poles along the roads and lanterns round the plaza. Pure. */

const FLAGS = ['#e8563f', '#f2b134', '#3fa7d6', '#6fbf73', '#c76bd1'];
const LANTERNS = ['#ff8a5c', '#ffd36b', '#ff6b9a', '#7bd3ff'];
const SIDEWALK_TOP = 0.2;
const PLAZA_TOP = 0.22;
const POLE = 6;
/** Banner poles stand this far apart along a road, starting just outside the plaza. */
export const BANNER_SPACING = 9;
export const BANNERS_PER_SIDE = 3;
export const LANTERN_COUNT = 16;

export function festivalPieces(layout: CityLayout): Piece[] {
  const out: Piece[] = [];
  const off = ROAD_WIDTH / 2 + SIDEWALK_WIDTH - 0.3;
  let n = 0;
  for (const r of layout.roads) {
    for (let k = 0; k < BANNERS_PER_SIDE; k++) {
      const d = PLAZA_RADIUS + 7 + k * BANNER_SPACING;
      for (const side of [1, -1]) {
        const x = r.dir[0] * d + r.side[0] * off * side;
        const z = r.dir[1] * d + r.side[1] * off * side;
        out.push({ shape: 'cyl', x, y: SIDEWALK_TOP, z, rotY: 0, size: [0.18, POLE, 0.18], color: '#6b4b2a' });
        // The flag hangs from the top of the pole, in a plane along the road, drifting out from the pole.
        out.push({ shape: 'box', x: x + r.dir[0] * 0.55, y: SIDEWALK_TOP + POLE - 2, z: z + r.dir[1] * 0.55, rotY: r.angle, size: [0.06, 1.9, 1.05], color: FLAGS[n++ % FLAGS.length]! });
      }
    }
  }
  // Lanterns on short posts round the plaza rim.
  for (let i = 0; i < LANTERN_COUNT; i++) {
    const a = (i / LANTERN_COUNT) * Math.PI * 2 + 0.2;
    const x = Math.sin(a) * (PLAZA_RADIUS - 1.2);
    const z = Math.cos(a) * (PLAZA_RADIUS - 1.2);
    out.push({ shape: 'cyl', x, y: PLAZA_TOP, z, rotY: 0, size: [0.12, 2.2, 0.12], color: '#5a5e66' });
    out.push({ shape: 'dome', x, y: PLAZA_TOP + 2.2, z, rotY: 0, size: [0.8, 0.8, 0.8], color: LANTERNS[i % LANTERNS.length]!, glow: true });
  }
  return out;
}
