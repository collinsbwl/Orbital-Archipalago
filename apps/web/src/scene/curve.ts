export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Trade lanes are quadratic curves that bow upward between two planets, so they read as arcs and clear the orbit rings. */
export const DEFAULT_LIFT = 0.3;

const mid = (a: V3, b: V3): V3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const dist = (a: V3, b: V3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** The curve's control point: halfway between the planets, raised in proportion to how far apart they are. */
export function laneControl(a: V3, b: V3, lift = DEFAULT_LIFT): V3 {
  const m = mid(a, b);
  return { x: m.x, y: m.y + dist(a, b) * lift, z: m.z };
}

/** Point at t (0 at `a`, 1 at `b`). The same curve is traced from either end, so a lane has one shape both ways. */
export function pointOnLane(a: V3, b: V3, t: number, lift = DEFAULT_LIFT): V3 {
  const c = laneControl(a, b, lift);
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  };
}

/** Direction of travel at t (not normalised), for pointing a ship along its lane. */
export function tangentOnLane(a: V3, b: V3, t: number, lift = DEFAULT_LIFT): V3 {
  const c = laneControl(a, b, lift);
  const u = 1 - t;
  return {
    x: 2 * u * (c.x - a.x) + 2 * t * (b.x - c.x),
    y: 2 * u * (c.y - a.y) + 2 * t * (b.y - c.y),
    z: 2 * u * (c.z - a.z) + 2 * t * (b.z - c.z),
  };
}

/** `segments + 1` points along the lane, for drawing it. */
export function lanePoints(a: V3, b: V3, segments: number, lift = DEFAULT_LIFT): V3[] {
  return Array.from({ length: segments + 1 }, (_, i) => pointOnLane(a, b, i / segments, lift));
}
