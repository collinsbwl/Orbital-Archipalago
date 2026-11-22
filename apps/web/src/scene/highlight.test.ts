import { describe, expect, it } from 'vitest';
import { HALO_OPACITY, highlightedPlanet, LANE_STYLE, planetEmphasis, routeEmphasis, SHIP_SIZE, SHIP_TRAIL } from './highlight';

describe('the spotlight', () => {
  it('prefers the focused planet over the hovered one, and is off when neither is set', () => {
    expect(highlightedPlanet('verdan', 'helion')).toBe('verdan');
    expect(highlightedPlanet(null, 'helion')).toBe('helion');
    expect(highlightedPlanet(null, null)).toBeNull();
  });

  it('leaves everything normal while nothing is spotlighted', () => {
    expect(planetEmphasis('verdan', null)).toBe('normal');
    expect(routeEmphasis({ from: 'verdan', to: 'helion' }, null)).toBe('normal');
  });

  it('lights up the spotlighted planet and dims the others', () => {
    expect(planetEmphasis('verdan', 'verdan')).toBe('involved');
    expect(planetEmphasis('helion', 'verdan')).toBe('dimmed');
  });

  it('lights up routes that touch the spotlighted planet, from either end, and dims the rest', () => {
    expect(routeEmphasis({ from: 'verdan', to: 'helion' }, 'verdan')).toBe('involved');
    expect(routeEmphasis({ from: 'helion', to: 'verdan' }, 'verdan')).toBe('involved');
    expect(routeEmphasis({ from: 'helion', to: 'tethys' }, 'verdan')).toBe('dimmed');
  });

  it('makes the three looks clearly different', () => {
    expect(LANE_STYLE.involved.opacity).toBeGreaterThan(LANE_STYLE.normal.opacity);
    expect(LANE_STYLE.normal.opacity).toBeGreaterThan(LANE_STYLE.dimmed.opacity);
    expect(LANE_STYLE.involved.color).not.toBe(LANE_STYLE.normal.color); // highlighted lanes change colour, not just brightness
    expect(HALO_OPACITY.involved).toBeGreaterThan(0);
    expect(HALO_OPACITY.dimmed).toBe(0);
    expect(SHIP_TRAIL.dimmed).toBeLessThan(SHIP_TRAIL.normal);
    expect(SHIP_SIZE.dimmed).toBeLessThan(SHIP_SIZE.normal);
    expect(SHIP_SIZE.involved).toBeGreaterThan(SHIP_SIZE.normal);
  });
});
