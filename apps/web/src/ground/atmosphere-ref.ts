import type { Atmosphere } from './atmosphere';
import { computeAtmosphere } from './atmosphere';
import type { GroundLook } from './ground-look';
import type { MoodState } from './mood';
import type { SkyBody } from './sky-bodies';

/**
 * What the sky rig shares with the rest of the scene every frame: the current atmosphere, the mood it was made from
 * and the neighbouring planets in the sky. Components read `.current` in their own frame loop.
 */
export interface AtmosphereState {
  atmosphere: Atmosphere;
  mood: MoodState;
  /** The ground's axes written in map axes (see sky-bodies.ts). Stars are fixed in the map frame, so the sky shader needs this to turn them. */
  basis: { east: [number, number, number]; up: [number, number, number]; south: [number, number, number] };
  bodies: SkyBody[];
}

export type AtmosphereRef = { current: AtmosphereState };

/** A starting state (noon, calm) so components can read the ref before the first frame. */
export function initialAtmosphere(look: GroundLook): AtmosphereState {
  const mood: MoodState = { kind: 'calm', storm: 0, gloom: 0, cheer: 0 };
  return {
    atmosphere: computeAtmosphere({ look, mood, timeOfDay: 0.5, sunDir: [0, Math.sin(look.sunElevation), Math.cos(look.sunElevation)] }),
    mood,
    basis: { east: [1, 0, 0], up: [0, 1, 0], south: [0, 0, 1] },
    bodies: [],
  };
}
