/**
 * The spotlight: when a planet is focused (or just hovered on the map), it and everything that touches it stands out, and
 * the rest of the scene steps back. These are the rules, kept as plain functions so the scene components stay simple.
 */
export type Emphasis = 'normal' | 'involved' | 'dimmed';

/** The planet being spotlighted: the focused one, else the one under the mouse, else none. */
export const highlightedPlanet = (focused: string | null, hovered: string | null): string | null => focused ?? hovered;

export function planetEmphasis(planetId: string, highlight: string | null): Emphasis {
  if (highlight === null) return 'normal';
  return planetId === highlight ? 'involved' : 'dimmed';
}

/** A lane or a ship between two planets: bright if it touches the spotlighted planet, dim if it does not. */
export function routeEmphasis(route: { from: string; to: string }, highlight: string | null): Emphasis {
  if (highlight === null) return 'normal';
  return route.from === highlight || route.to === highlight ? 'involved' : 'dimmed';
}

export const LANE_STYLE: Record<Emphasis, { opacity: number; color: string }> = {
  normal: { opacity: 0.42, color: '#7fa2ff' },
  involved: { opacity: 0.9, color: '#ffd36a' },
  dimmed: { opacity: 0.05, color: '#7fa2ff' },
};

/** Multiplies a planet's surface colours: white leaves them alone, grey-blue darkens a planet that is stepping back. */
export const PLANET_TINT: Record<Emphasis, string> = { normal: '#ffffff', involved: '#ffffff', dimmed: '#7a82a2' };

/** How strong the soft glow around a planet is. */
export const HALO_OPACITY: Record<Emphasis, number> = { normal: 0, involved: 0.6, dimmed: 0 };

/** How visible a ship's engine trail is, and how big the ship is drawn, relative to normal. */
export const SHIP_TRAIL: Record<Emphasis, number> = { normal: 1, involved: 1, dimmed: 0.2 };
export const SHIP_SIZE: Record<Emphasis, number> = { normal: 1, involved: 1.15, dimmed: 0.7 };
