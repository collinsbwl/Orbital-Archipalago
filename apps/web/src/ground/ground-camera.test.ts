import { describe, expect, it } from 'vitest';
import { layoutCity } from './city-layout';
import { clampAboveTerrain, clampCameraY, clampPanTarget, EYE_HEIGHT, GROUND_LIMITS, landingPose, MIN_CAMERA_HEIGHT } from './ground-camera';

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

describe('landingPose', () => {
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
