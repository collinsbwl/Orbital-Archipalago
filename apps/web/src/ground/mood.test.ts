import { describe, expect, it } from 'vitest';
import { busynessOf, CALM, confidenceOf, moodScores, nextKind, settledMood, stepBusyness, stepMood } from './mood';
import type { MoodScores } from './mood';

const metrics = (c: number, b = c) => ({ consumerConfidence: c, businessConfidence: b });
const none: MoodScores = { storm: 0, gloom: 0, cheer: 0 };

describe('moodScores', () => {
  it('is calm for middling confidence and no news', () => {
    expect(moodScores({ metrics: metrics(60), events: [], planet: 'verdan', cycle: 10 })).toEqual({ storm: 0, gloom: 0, cheer: 0 });
  });

  it('makes a fresh crisis or shock on the planet a storm, fading with age', () => {
    const ev = (cycle: number) => [{ cycle, kind: 'crisis' as const, planet: 'verdan', text: 'Bank run' }];
    expect(moodScores({ metrics: metrics(60), events: ev(10), planet: 'verdan', cycle: 10 }).storm).toBe(1);
    const mid = moodScores({ metrics: metrics(60), events: ev(10), planet: 'verdan', cycle: 15 }).storm;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(moodScores({ metrics: metrics(60), events: ev(10), planet: 'verdan', cycle: 30 }).storm).toBe(0);
  });

  it('matches events to a planet by text when the planet field is missing, and ignores other planets', () => {
    const shock = [{ cycle: 5, kind: 'shock' as const, text: '[god mode] drought on Verdan' }];
    expect(moodScores({ metrics: undefined, events: shock, planet: 'verdan', cycle: 5 }).storm).toBe(1);
    expect(moodScores({ metrics: undefined, events: shock, planet: 'helion', cycle: 5 }).storm).toBe(0);
  });

  it('treats a bad headline as a milder storm than a crisis, and policy news as nothing', () => {
    const bad = [{ cycle: 5, kind: 'headline' as const, planet: 'helion', text: 'Market crash on Helion' }];
    const s = moodScores({ metrics: metrics(60), events: bad, planet: 'helion', cycle: 5 }).storm;
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(1);
    const policy = [{ cycle: 5, kind: 'policy' as const, planet: 'helion', text: 'Rate crisis response' }];
    expect(moodScores({ metrics: metrics(60), events: policy, planet: 'helion', cycle: 5 }).storm).toBe(0);
  });

  it('turns low confidence into gloom and high confidence or good news into cheer', () => {
    expect(moodScores({ metrics: metrics(15), events: [], planet: 'p', cycle: 0 }).gloom).toBe(1);
    expect(moodScores({ metrics: metrics(95), events: [], planet: 'p', cycle: 0 }).cheer).toBe(1);
    const good = [{ cycle: 0, kind: 'headline' as const, planet: 'p', text: 'Record harvest sparks festival' }];
    expect(moodScores({ metrics: metrics(60), events: good, planet: 'p', cycle: 1 }).cheer).toBeGreaterThan(0.8);
  });

  it('never cheers in a storm', () => {
    const crisis = [{ cycle: 0, kind: 'crisis' as const, planet: 'p', text: 'x' }];
    expect(moodScores({ metrics: metrics(99), events: crisis, planet: 'p', cycle: 0 }).cheer).toBe(0);
  });

  it('counts missing readings as middling', () => {
    expect(confidenceOf(undefined)).toBeCloseTo(0.65);
  });
});

describe('nextKind (hysteresis)', () => {
  it('needs a higher score to enter a mood than to stay in it', () => {
    expect(nextKind('calm', { ...none, storm: 0.45 })).toBe('calm');
    expect(nextKind('storm', { ...none, storm: 0.45 })).toBe('storm');
    expect(nextKind('storm', { ...none, storm: 0.2 })).toBe('calm');
    expect(nextKind('calm', { ...none, gloom: 0.4 })).toBe('calm');
    expect(nextKind('gloomy', { ...none, gloom: 0.4 })).toBe('gloomy');
    expect(nextKind('calm', { ...none, cheer: 0.5 })).toBe('calm');
    expect(nextKind('festive', { ...none, cheer: 0.5 })).toBe('festive');
  });

  it('ranks storm over gloom over festival', () => {
    expect(nextKind('calm', { storm: 0.8, gloom: 1, cheer: 1 })).toBe('storm');
    expect(nextKind('calm', { storm: 0, gloom: 0.8, cheer: 1 })).toBe('gloomy');
  });
});

describe('stepMood', () => {
  it('eases toward the new mood instead of jumping', () => {
    let m = CALM;
    m = stepMood(m, { ...none, storm: 1 }, 0.1);
    expect(m.kind).toBe('storm');
    expect(m.storm).toBeGreaterThan(0);
    expect(m.storm).toBeLessThan(0.2);
    for (let i = 0; i < 400; i++) m = stepMood(m, { ...none, storm: 1 }, 0.1);
    expect(m.storm).toBeCloseTo(1, 2);
    expect(settledMood({ ...none, storm: 1 }).storm).toBeCloseTo(m.storm, 2);
  });

  it('does not flicker when a score hovers between the thresholds', () => {
    let m = settledMood({ ...none, storm: 0.9 });
    const kinds = new Set<string>();
    for (let i = 0; i < 40; i++) {
      m = stepMood(m, { ...none, storm: i % 2 ? 0.5 : 0.4 }, 0.1);
      kinds.add(m.kind);
    }
    expect([...kinds]).toEqual(['storm']);
  });
});

describe('busynessOf', () => {
  it('empties the streets in a storm, thins them when gloomy, fills them for a festival', () => {
    const storm = busynessOf(settledMood({ ...none, storm: 1 }));
    const gloomy = busynessOf(settledMood({ ...none, gloom: 1 }));
    const calm = busynessOf(CALM);
    const fest = busynessOf(settledMood({ ...none, cheer: 1 }));
    expect(storm).toBeLessThan(gloomy);
    expect(gloomy).toBeLessThan(calm);
    expect(calm).toBeLessThan(fest);
    expect(fest).toBeLessThanOrEqual(1);
    expect(storm).toBeGreaterThanOrEqual(0.1);
  });

  it('steps in twentieths', () => {
    expect(stepBusyness(0.5123)).toBe(0.5);
    expect(stepBusyness(0.53)).toBe(0.55);
  });
});
