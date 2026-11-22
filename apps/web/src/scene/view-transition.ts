/**
 * The map <-> planet-ground view switch as a small state machine. No three or react in here: callers pass in the time.
 *
 * Going down:  idle(map) -> diving -> swap -> clearing -> idle(ground)
 * Coming back: idle(ground) -> leaving -> swap -> clearing -> idle(map)
 *
 * The scene shown (`view`) flips at the start of 'swap', while the canvas is fully blurred, so the player never sees the cut.
 * Input that arrives mid-transition (a second click, or Esc or Back during the dive) is ignored, not queued.
 */

export type View = { kind: 'map' } | { kind: 'ground'; planet: string };
export type Phase = 'idle' | 'diving' | 'swap' | 'clearing' | 'leaving';

export interface TransitionState {
  /** Which scene is shown right now. */
  view: View;
  phase: Phase;
  /** When the current phase began, in ms. */
  since: number;
  /** Where the transition is heading; null while idle. */
  next: View | null;
}

/** How long each timed phase lasts, in ms. */
export const DURATIONS = { diving: 900, swap: 250, clearing: 600, leaving: 600 } as const;
/** The most the canvas is blurred, in px. */
export const MAX_BLUR = 12;

export const MAP_VIEW: View = { kind: 'map' };

/** Starts on the map, with nothing in motion. */
export function initialState(): TransitionState {
  return { view: MAP_VIEW, phase: 'idle', since: 0, next: null };
}

/** Whether a "back to map" request would be accepted now: on the ground and not mid-transition. */
export function canBack(state: TransitionState): boolean {
  return state.phase === 'idle' && state.view.kind === 'ground';
}

/** Begins diving to a planet. Ignored unless we are idle on the map. */
export function start(state: TransitionState, planet: string, now: number): TransitionState {
  if (state.phase !== 'idle' || state.view.kind !== 'map') return state;
  return { view: state.view, phase: 'diving', since: now, next: { kind: 'ground', planet } };
}

/** Begins the trip back to the map. Ignored unless we are idle on the ground. */
export function back(state: TransitionState, now: number): TransitionState {
  if (!canBack(state)) return state;
  return { view: state.view, phase: 'leaving', since: now, next: MAP_VIEW };
}

/** The phase that follows a timed phase. 'swap' and 'clearing' are shared by both directions. */
function after(phase: Phase): Phase {
  return phase === 'diving' || phase === 'leaving' ? 'swap' : phase === 'swap' ? 'clearing' : 'idle';
}

/**
 * Moves the machine forward to `now`. Phases advance from their exact end times, so a long gap (a stalled tab) walks
 * through every phase it skipped and the result does not depend on how often this is called.
 */
export function tick(state: TransitionState, now: number): TransitionState {
  let s = state;
  while (s.phase !== 'idle') {
    const length = DURATIONS[s.phase];
    if (now - s.since < length) break;
    const phase = after(s.phase);
    const since = s.since + length;
    if (phase === 'swap') s = { view: s.next ?? s.view, phase, since, next: s.next };
    else if (phase === 'idle') s = { view: s.view, phase, since, next: null };
    else s = { ...s, phase, since };
  }
  return s;
}

/** Starts slow and speeds up: the feel of falling toward a planet. Input and output are 0 to 1. */
export function easeInCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x;
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** How far through the current phase we are, 0 to 1. Idle counts as done. */
export function progress(state: TransitionState, now: number): number {
  if (state.phase === 'idle') return 1;
  return Math.min(1, Math.max(0, (now - state.since) / DURATIONS[state.phase]));
}

/** Canvas blur in px (0 to MAX_BLUR), eased: rises while diving or leaving, holds through the swap, falls while clearing. */
export function blurAt(state: TransitionState, now: number): number {
  switch (state.phase) {
    case 'idle':
      return 0;
    case 'diving':
    case 'leaving':
      return MAX_BLUR * smooth(progress(state, now));
    case 'swap':
      return MAX_BLUR;
    case 'clearing':
      return MAX_BLUR * (1 - smooth(progress(state, now)));
  }
}
