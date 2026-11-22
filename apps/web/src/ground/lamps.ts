import { PLAZA_RADIUS, ROAD_WIDTH, SIDEWALK_WIDTH } from './city-layout';
import type { CityLayout } from './city-layout';
import type { Piece } from './industry';

/** Street lamps (Phase 12): posts down both sidewalks of every road, with lamp heads that light up after dark. Pure. */

const SIDEWALK_TOP = 0.2;
export const LAMP_SPACING = 12;
const POST_HEIGHT = 4.2;
export const LAMP_WARM = '#ffe2a0';

export function streetLampPieces(layout: CityLayout): Piece[] {
  const out: Piece[] = [];
  const off = ROAD_WIDTH / 2 + SIDEWALK_WIDTH - 0.4;
  for (const r of layout.roads) {
    for (let d = PLAZA_RADIUS + 5; d < r.length - 4; d += LAMP_SPACING) {
      for (const side of [1, -1]) {
        const x = r.dir[0] * d + r.side[0] * off * side;
        const z = r.dir[1] * d + r.side[1] * off * side;
        out.push({ shape: 'cyl', x, y: SIDEWALK_TOP, z, rotY: 0, size: [0.25, POST_HEIGHT, 0.25], color: '#4a4f57' });
        out.push({ shape: 'box', x, y: SIDEWALK_TOP + POST_HEIGHT, z, rotY: r.angle, size: [0.7, 0.35, 0.7], color: LAMP_WARM, glow: true, lamp: true });
      }
    }
  }
  return out;
}
