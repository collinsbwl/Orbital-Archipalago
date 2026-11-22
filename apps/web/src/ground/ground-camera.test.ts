import { describe, expect, it } from 'vitest';
import { layoutCity } from './city-layout';
import { clampAboveTerrain, clampCameraY, clampPanTarget, clampTargetY, EYE_HEIGHT, GROUND_LIMITS, landingPose, MIN_CAMERA_HEIGHT, polarAngle, TARGET_LIMITS } from './ground-camera';

describe('clampCameraY', () => {
  it('lifts a camera that is too low', () => {
    expect(clampCameraY(-2)).toBe(MIN_CAMERA_HEIGHT);
    expect(clampCameraY(0.1)).toBe(MIN_CAMERA_HEIGHT);
  });
  it('leaves a high enough camera alone', () => {
    expect(clampCameraY(MIN_CAMERA_HEIGHT)).toBe(MIN_CAMERA_HEIGHT);
    expect(clampCameraY(1.7)).toBe(1.7);
  });
});

describe('clampAboveTerrain', () => {
  const hill = { heightAt: (x: number) => (x > 10 ? 20 : 0) };
  it('keeps the camera above the ground under it', () => {
    expect(clampAboveTerrain(hill, 50, 5, 0)).toBe(20 + MIN_CAMERA_HEIGHT);
    expect(clampAboveTerrain(hill, 0, -3, 0)).toBe(MIN_CAMERA_HEIGHT);
  });
  it('leaves a high camera alone', () => {
    expect(clampAboveTerrain(hill, 50, 100, 0)).toBe(100);
  });
  it('honours a custom margin', () => {
    expect(clampAboveTerrain(hill, 0, 0, 0, 2)).toBe(2);
  });
});

describe('water and the target height', () => {
  const lake = { heightAt: () => 2, waterDepthAt: (x: number) => (x > 0 ? 3 : 0) };
  it('keeps the camera above the water surface, not just the lake bed', () => {
    expect(clampAboveTerrain(lake, 5, 3, 0)).toBe(5 + MIN_CAMERA_HEIGHT);
    expect(clampAboveTerrain(lake, -5, 3, 0)).toBe(3);
  });
  it('keeps the orbit target between the limits above the surface', () => {
    expect(clampTargetY(lake, -5, -10, 0)).toBe(2 + TARGET_LIMITS.min);
    expect(clampTargetY(lake, -5, 1000, 0)).toBe(2 + TARGET_LIMITS.max);
    expect(clampTargetY(lake, 5, 6, 0)).toBe(6);
  });
});

describe('landingPose', () => {
  it('lands inside the polar cap, so the controls do not lift the camera', () => {
    for (const planet of ['verdan', 'helion', 'tethys']) {
      const l = layoutCity({ planet });
      for (const h of [0, 3, -4]) {
        const pose = landingPose(l, { heightAt: (x: number, z: number) => (Math.hypot(x, z) < 5 ? 0 : h) });
        expect(polarAngle(pose)).toBeLessThanOrEqual(GROUND_LIMITS.maxPolarAngle);
        expect(pose.position[1]).toBeCloseTo(h + EYE_HEIGHT); // still at eye height
      }
    }
  });
  it('still looks along the road toward the plaza from eye level', () => {
    const l = layoutCity({ planet: 'verdan' });
    const pose = landingPose(l, { heightAt: () => 0 });
    expect(pose.target[1]).toBeGreaterThan(0);
    expect(pose.target[1]).toBeLessThan(EYE_HEIGHT);
  });
  const layout = layoutCity({ planet: 'verdan' });
  const flat = { heightAt: () => 0 };
  it('lands at eye height at a road end, looking at the plaza', () => {
    const pose = landingPose(layout, flat);
    const road = layout.roads[0]!;
    expect(pose.position[1]).toBeCloseTo(EYE_HEIGHT);
    expect(layout.distanceToRoad(pose.position[0], pose.position[2])).toBeCloseTo(0, 5);
    expect(Math.hypot(pose.position[0], pose.position[2])).toBeGreaterThan(road.length - 4);
    expect(pose.target[0]).toBe(0);
    expect(pose.target[2]).toBe(0);
  });
  it('starts inside the zoom range', () => {
    const pose = landingPose(layout, flat);
    const dist = Math.hypot(pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2]);
    expect(dist).toBeLessThan(GROUND_LIMITS.maxDistance);
    expect(dist).toBeGreaterThan(GROUND_LIMITS.minDistance);
  });
  it('rides the ground height', () => {
    expect(landingPose(layout, { heightAt: () => 3 }).position[1]).toBeCloseTo(3 + EYE_HEIGHT);
  });
});

describe('clampPanTarget', () => {
  it('leaves a target inside the city alone', () => {
    expect(clampPanTarget(10, -20, 58)).toEqual({ x: 10, z: -20 });
  });
  it('pulls a far target back onto the limit, keeping its direction', () => {
    const p = clampPanTarget(300, 400, 58, 12);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(70);
    expect(p.x / p.z).toBeCloseTo(0.75);
  });
});
