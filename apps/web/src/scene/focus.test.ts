import { describe, expect, it } from 'vitest';
import { PLATEAU_TOP } from './city';
import { FOCUS_LIMITS, focusPose, HOME_POSE, isZoomable, LANDING_RADII, SURFACE_LATITUDE, surfaceSite, ZOOMABLE_PLANETS } from './focus';

type V = { x: number; y: number; z: number };
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V) => Math.hypot(a.x, a.y, a.z);

describe('focus', () => {
  it('lets only the chosen planets be zoomed for now', () => {
    expect(ZOOMABLE_PLANETS).toEqual(['verdan']);
    expect(isZoomable('verdan')).toBe(true);
    expect(isZoomable('helion')).toBe(false);
    expect(isZoomable('')).toBe(false);
  });

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
    expect(dist(site.point, planet)).toBeCloseTo(radius + PLATEAU_TOP, 9);
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
    expect(dist(pose.position, planet)).toBeGreaterThan(radius + PLATEAU_TOP); // outside the planet, not inside it
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
