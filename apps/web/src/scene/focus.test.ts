import { describe, expect, it } from 'vitest';
import { DIVE_TRIGGER_RADII, FOCUS_LIMITS, focusPose, HOME_POSE, LANDING_RADII, shouldDive, SITE_RISE, SURFACE_LATITUDE, surfaceSite } from './focus';

type V = { x: number; y: number; z: number };
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V) => Math.hypot(a.x, a.y, a.z);

describe('focus', () => {
  it('has a home view looking at the sun from above and in front', () => {
    expect(HOME_POSE.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(HOME_POSE.position.y).toBeGreaterThan(0);
  });
});

describe('the city site', () => {
  const planet = { x: 4, y: 0, z: 3 }; // 5 units from the sun
  const radius = 0.56;

  it('stands on the sun-facing side, up out of the planet, at the right latitude', () => {
    const site = surfaceSite(planet, radius);
    expect(len(site.normal)).toBeCloseTo(1, 9);
    expect(len(site.south)).toBeCloseTo(1, 9);
    expect(dot(site.normal, site.south)).toBeCloseTo(0, 9); // along the ground, not out of it
    const towardSun = { x: -4 / 5, y: 0, z: -3 / 5 };
    expect(dot(site.normal, towardSun)).toBeCloseTo(Math.cos(SURFACE_LATITUDE), 9); // lit by the sun
    expect(dot(site.normal, towardSun)).toBeGreaterThan(0);
    expect(site.normal.y).toBeCloseTo(Math.sin(SURFACE_LATITUDE), 9);
    expect(site.south.y).toBeLessThan(0); // south points down toward the equator
  });

  it('puts the city floor just above the planet surface', () => {
    const site = surfaceSite(planet, radius);
    expect(dist(site.point, planet)).toBeCloseTo(radius + SITE_RISE, 9);
  });

  it('does not break for a planet at the sun', () => {
    const site = surfaceSite({ x: 0, y: 0, z: 0 }, radius);
    expect(Number.isFinite(site.point.x) && Number.isFinite(site.point.y) && Number.isFinite(site.point.z)).toBe(true);
  });
});

describe('landing pose', () => {
  const planet = { x: 4, y: 0, z: 3 };
  const radius = 0.56;

  it('looks at the middle of the city floor from a little way out, above the ground', () => {
    const pose = focusPose(planet, radius);
    const site = surfaceSite(planet, radius);
    expect(pose.target).toEqual(site.point);
    expect(dist(pose.position, pose.target)).toBeCloseTo(radius * LANDING_RADII, 9);
    expect(dist(pose.position, planet)).toBeGreaterThan(radius + SITE_RISE); // outside the planet, not inside it
    // seen at an angle: tilted away from straight down, but still looking down onto the city
    const view = { x: pose.position.x - pose.target.x, y: pose.position.y - pose.target.y, z: pose.position.z - pose.target.z };
    const cosFromVertical = dot(view, site.normal) / len(view);
    expect(cosFromVertical).toBeGreaterThan(0.3);
    expect(cosFromVertical).toBeLessThan(0.95);
  });

  it('scales the camera limits with the planet and starts inside them', () => {
    const a = focusPose(planet, 0.5);
    const b = focusPose(planet, 1);
    expect(a.minDistance).toBeCloseTo(0.5 * FOCUS_LIMITS.minRadii, 9);
    expect(b.maxDistance).toBeCloseTo(FOCUS_LIMITS.maxRadii, 9);
    const d = dist(a.position, a.target);
    expect(a.minDistance).toBeLessThan(d);
    expect(a.maxDistance).toBeGreaterThan(d);
  });
});

describe('dive trigger', () => {
  it('dives only when close, and never while the camera is flying', () => {
    expect(shouldDive(0.5 * DIVE_TRIGGER_RADII * 0.9, 0.5, false)).toBe(true);
    expect(shouldDive(0.5 * DIVE_TRIGGER_RADII * 1.1, 0.5, false)).toBe(false);
    expect(shouldDive(0.1, 0.5, true)).toBe(false);
  });

  it('the landing view of the focus flight is outside the trigger, so you scroll in to land', () => {
    const planet = { x: 4, y: 0, z: 3 };
    const pose = focusPose(planet, 0.5);
    expect(dist(pose.position, planet)).toBeGreaterThan(0.5 * DIVE_TRIGGER_RADII);
    // ...and the closest you can zoom (the min distance from the city point) is inside it.
    const closest = dist(surfaceSite(planet, 0.5).point, planet) - pose.minDistance;
    expect(closest).toBeLessThan(0.5 * DIVE_TRIGGER_RADII);
  });
});
