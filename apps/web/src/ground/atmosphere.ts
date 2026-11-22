import type { GroundLook, PrecipKind } from './ground-look';
import type { MoodState } from './mood';
import { clamp, smoothstep } from './rng';
import type { Vec3 } from './sky-bodies';

/**
 * The one controller for the ground scene's sky and light (Phases 11 and 12). Pure: give it the planet's look, the mood,
 * the time of day and the direction to the sun, and it returns every sky colour, the fog, the light colours and
 * strengths, the precipitation and how lit the windows and lamps are. The sky dome, fog, lights, weather and city
 * all read this one result, so mood and day/night never fight over the same colour.
 *
 * Colours are sRGB triples with channels 0 to 1.
 */

export type Rgb = [number, number, number];

export interface Atmosphere {
  timeOfDay: number;
  /** Rough part of the day, for labels. */
  phase: 'night' | 'dawn' | 'day' | 'dusk';
  /** Unit vector to the sun, ground frame (x east, y up, z south). */
  sunDir: Vec3;
  /** Sine of the sun's height: 1 overhead, 0 on the horizon, negative below it. */
  sunHeight: number;
  /** 0 night to 1 full day. */
  daylight: number;
  /** 0 by day to 1 in deep night. */
  night: number;
  /** 1 at sunrise and sunset, falling away from them. */
  twilight: number;
  /** How much cloud covers the sky: 0 clear to 1 dark overcast. */
  overcast: number;
  skyTop: Rgb;
  skyHorizon: Rgb;
  fogColor: Rgb;
  fogNear: number;
  fogFar: number;
  /** The sun's own colour (the disc and the direct light). */
  sunColor: Rgb;
  /** How visible the sun disc is, 0 to 1 (clouds hide it). */
  sunVisible: number;
  /** Direct light from the sun. Zero once it is below the horizon. */
  sunLight: { dir: Vec3; color: Rgb; intensity: number };
  /** A dim cool light from the opposite side of the sky at night. */
  moonLight: { dir: Vec3; color: Rgb; intensity: number };
  hemi: { sky: Rgb; ground: Rgb; intensity: number };
  /** Stars, 0 to 1. */
  stars: number;
  precipitation: { kind: PrecipKind; amount: number };
  /** How lit the windows are, 0 to 1. */
  windows: number;
  /** Street lamps and port lights, 0 to 1. */
  lamps: number;
}

export interface AtmosphereInput {
  look: GroundLook;
  mood: Pick<MoodState, 'storm' | 'gloom' | 'cheer'>;
  /** 0 to 1, 0.5 noon (see sky-bodies.ts). */
  timeOfDay: number;
  /** Unit vector to the sun in the ground frame. */
  sunDir: Vec3;
}

const hexCache = new Map<string, Rgb>();
/** A `#rrggbb` colour as an sRGB triple. */
export function rgb(hex: string): Rgb {
  let c = hexCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    hexCache.set(hex, c);
  }
  return c;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

const NIGHT_HORIZON = rgb('#0a1226');
const NIGHT_TOP = rgb('#02050f');
const SUNSET_HORIZON = rgb('#ff9650');
const SUNSET_TOP = rgb('#5a3a66');
const STORM_GREY = rgb('#6d7480');
const SUN_LOW = rgb('#ff9a58');
const MOON = rgb('#8fa4ff');

/** Peak strength of the direct sun at midday in clear weather. */
const SUN_INTENSITY = 1.5;

export function computeAtmosphere({ look, mood, timeOfDay, sunDir }: AtmosphereInput): Atmosphere {
  const h = clamp(sunDir[1], -1, 1);
  const daylight = smoothstep(-0.08, 0.3, h);
  const night = 1 - smoothstep(-0.25, 0, h);
  const overcast = clamp(Math.max(mood.storm * 0.95, mood.gloom * 0.6), 0, 1);
  const twilight = Math.exp(-((h / 0.16) ** 2)) * (1 - 0.6 * overcast);

  const dayHorizon = rgb(look.sky);
  const dayTop = rgb(look.skyTop);
  // Clear sky: night to day, with the warm sunset band at the horizon around sunrise and sunset.
  let horizon = mix(mix(mix(NIGHT_HORIZON, scale(dayHorizon, 0.12), 0.3), dayHorizon, daylight), mix(SUNSET_HORIZON, rgb(look.sunColor), 0.25), twilight * 0.85);
  let top = mix(mix(NIGHT_TOP, scale(dayTop, 0.08), 0.3), dayTop, daylight);
  top = mix(top, mix(scale(dayTop, 0.6), SUNSET_TOP, 0.35), twilight * 0.6);
  // Cloud: pull both toward a grey that is dark at night and darker in a storm.
  const grey = scale(mix(STORM_GREY, dayHorizon, 0.22), (0.12 + 0.88 * daylight) * (1 - 0.3 * mood.storm));
  horizon = mix(horizon, grey, overcast);
  top = mix(top, scale(grey, 0.78), overcast);
  // A festive mood lifts the sky a touch.
  horizon = mix(horizon, [1, 0.92, 0.85], 0.06 * mood.cheer * daylight);

  const fogScale = 1 - 0.55 * mood.storm - 0.2 * mood.gloom - 0.12 * night;
  const fogNear = look.fogNear * (1 - 0.65 * mood.storm - 0.15 * night);
  const fogFar = Math.max(fogNear + 40, look.fogFar * fogScale);

  const sunStrength = smoothstep(-0.02, 0.3, h) * (1 - 0.85 * overcast) * (1 + 0.08 * mood.cheer);
  const sunColor = mix(rgb(look.sunColor), SUN_LOW, twilight * 0.9);
  const moonStrength = 0.38 * night * smoothstep(0, 0.12, -h) * (1 - 0.5 * overcast);

  const hemiSky = mix(mix(scale(MOON, 0.55), mix(top, horizon, 0.3), daylight), grey, overcast * 0.5);
  const hemiGround = scale(rgb(look.ground), 0.3 + 0.7 * daylight);
  const hemiIntensity = (0.2 + 0.65 * daylight) * (1 - 0.3 * overcast) + 0.04 * mood.cheer;

  // Windows and lamps come on around sunset and stay on all night; a dark storm brings them on early.
  // There is no night now, so the lights do not switch: a fixed level keeps the same windows lit and the same ones dark.
  const windows = 0.5;
  const lamps = 1;

  const amount = smoothstep(0.35, 0.9, mood.storm);
  const phase: Atmosphere['phase'] = night > 0.85 ? 'night' : daylight > 0.85 ? 'day' : timeOfDay < 0.5 ? 'dawn' : 'dusk';

  return {
    timeOfDay,
    phase,
    sunDir,
    sunHeight: h,
    daylight,
    night,
    twilight,
    overcast,
    skyTop: top,
    skyHorizon: horizon,
    fogColor: horizon,
    fogNear,
    fogFar,
    sunColor,
    sunVisible: clamp(1 - overcast * 0.95, 0, 1),
    sunLight: { dir: sunDir, color: sunColor, intensity: SUN_INTENSITY * sunStrength },
    moonLight: { dir: [-sunDir[0], -sunDir[1], -sunDir[2]], color: MOON, intensity: moonStrength },
    hemi: { sky: hemiSky, ground: hemiGround, intensity: hemiIntensity },
    stars: clamp(night * night * (1 - overcast), 0, 1),
    precipitation: { kind: look.precip, amount },
    windows,
    lamps,
  };
}
