import { lakeRadiusAt } from './terrain-features';
import type { Lake, River } from './terrain-features';

/** Triangles (three numbers per vertex, three vertices per triangle) for a lake's water surface: a fan out to a little past the shore. */
export function lakeSurface(lake: Lake, segments = 48): Float32Array {
  const y = lake.level + (lake.frozen ? 0.12 : 0);
  const out = new Float32Array(segments * 9);
  const edge = (i: number): [number, number] => {
    const a = (i / segments) * Math.PI * 2;
    const r = lakeRadiusAt(lake, a) * 1.12;
    return [lake.x + Math.sin(a) * r, lake.z + Math.cos(a) * r];
  };
  for (let i = 0; i < segments; i++) {
    const [ax, az] = edge(i);
    const [bx, bz] = edge(i + 1);
    // Counter-clockwise seen from above, so the surface faces up.
    out.set([lake.x, y, lake.z, ax, y, az, bx, y, bz], i * 9);
  }
  return out;
}

/** Triangles for a river's water: a strip along the centreline, as wide as the channel. */
export function riverSurface(river: River): Float32Array {
  const pts = river.points;
  const out = new Float32Array((pts.length - 1) * 18);
  const side = (i: number): [[number, number], [number, number]] => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    // Sideways unit vector (perpendicular to the flow).
    const nx = (b.z - a.z) / len;
    const nz = -(b.x - a.x) / len;
    const p = pts[i]!;
    return [[p.x + nx * p.half, p.z + nz * p.half], [p.x - nx * p.half, p.z - nz * p.half]];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [l0, r0] = side(i);
    const [l1, r1] = side(i + 1);
    const y0 = pts[i]!.y;
    const y1 = pts[i + 1]!.y;
    out.set([l0[0], y0, l0[1], r0[0], y0, r0[1], l1[0], y1, l1[1], r0[0], y0, r0[1], r1[0], y1, r1[1], l1[0], y1, l1[1]], i * 18);
  }
  return out;
}
