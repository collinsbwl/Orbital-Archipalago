import { describe, expect, it } from 'vitest';
import { laneControl, lanePoints, pointOnLane, tangentOnLane } from './curve';

const a = { x: 0, y: 0, z: 0 };
const b = { x: 4, y: 0, z: 0 };

describe('lane curves', () => {
  it('start and end on the planets', () => {
    expect(pointOnLane(a, b, 0)).toEqual(a);
    expect(pointOnLane(a, b, 1)).toEqual(b);
  });

  it('bow upward, more for planets that are further apart', () => {
    const mid = pointOnLane(a, b, 0.5);
    expect(mid.x).toBeCloseTo(2, 5);
    expect(mid.y).toBeGreaterThan(0);
    const far = pointOnLane(a, { x: 8, y: 0, z: 0 }, 0.5);
    expect(far.y).toBeGreaterThan(mid.y);
    expect(laneControl(a, b).y).toBeCloseTo(4 * 0.3, 5);
  });

  it('are the same curve from either end', () => {
    const forward = pointOnLane(a, b, 0.3);
    const backward = pointOnLane(b, a, 0.7);
    expect(backward.x).toBeCloseTo(forward.x, 9);
    expect(backward.y).toBeCloseTo(forward.y, 9);
    expect(backward.z).toBeCloseTo(forward.z, 9);
  });

  it('give a direction of travel that points from a toward b', () => {
    const t = tangentOnLane(a, b, 0.5);
    expect(t.x).toBeGreaterThan(0);
    expect(tangentOnLane(a, b, 0).y).toBeGreaterThan(0); // climbing at the start
    expect(tangentOnLane(a, b, 1).y).toBeLessThan(0); // descending at the end
  });

  it('are drawn as segments + 1 points', () => {
    expect(lanePoints(a, b, 16)).toHaveLength(17);
  });
});
