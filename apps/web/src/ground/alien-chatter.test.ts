import { describe, expect, it } from 'vitest';
import {
  CHAT_FAR,
  CHAT_NEAR,
  CHATTER_LINES,
  PLANET_CHATTER,
  chatterLine,
  chatterPool,
  distanceFade,
  stopIndex,
  turnFade,
  turnIndex,
} from './alien-chatter';
import { ALIEN_COUNT, TURN_RATE, alienPose, isConversing, makeAliens } from './aliens';
import { layoutCity } from './city-layout';

describe('chatter lines', () => {
  const all = [...CHATTER_LINES, ...Object.values(PLANET_CHATTER).flat()];

  it('are lowercase letters and single spaces only, so every character has a glyph', () => {
    for (const line of all) expect(line).toMatch(/^[a-z]+( [a-z]+)*$/);
  });

  it('are short enough for a small bubble', () => {
    for (const line of all) expect(line.length).toBeLessThanOrEqual(30);
  });

  it('mix a planet’s own lines into the shared pool, and fall back to the shared pool elsewhere', () => {
    expect(chatterPool('tethys')).toEqual([...CHATTER_LINES, ...PLANET_CHATTER.tethys!]);
    expect(chatterPool('nowhere')).toEqual(CHATTER_LINES);
  });
});

describe('chatterLine', () => {
  it('is deterministic', () => {
    expect(chatterLine('helion', 3, 7, 12)).toBe(chatterLine('helion', 3, 7, 12));
  });

  it('always picks from the planet’s pool', () => {
    const pool = chatterPool('verdan');
    for (let turn = 0; turn < 50; turn++) expect(pool).toContain(chatterLine('verdan', 2, 4, turn));
  });

  it('never repeats the line just said', () => {
    for (const planet of ['helion', 'verdan', 'tethys', 'nowhere']) {
      for (let pair = 0; pair < 10; pair++) {
        for (let stop = 0; stop < 20; stop++) {
          for (let turn = 0; turn < 12; turn++) {
            expect(chatterLine(planet, pair, stop, turn + 1)).not.toBe(chatterLine(planet, pair, stop, turn));
          }
        }
      }
    }
  });

  it('gives different pairs and stops different openers', () => {
    const openers = new Set<string>();
    for (let pair = 0; pair < 10; pair++) for (let stop = 0; stop < 5; stop++) openers.add(chatterLine('helion', pair, stop, 0));
    expect(openers.size).toBeGreaterThan(15);
  });
});

describe('talking pairs', () => {
  const loops = layoutCity({ planet: 'helion' }).gatherLoops;
  const specs = makeAliens(loops, ALIEN_COUNT, 'helion');
  const first = specs.find((s) => s.role === 1)!;
  const times =Array.from({ length: 4000 }, (_, i) => i * 0.05);

  it('give even turns to the first member and odd turns to its partner, matching who the pose says is speaking', () => {
    for (const t of times) {
      const speak = alienPose(loops, first, t).speak;
      // Away from the swap itself, the turn's owner is plainly the one speaking.
      if (Math.abs(speak - 0.5) < 0.2) continue;
      expect(speak > 0.5).toBe(turnIndex(t, first) % 2 === 0);
    }
  });

  it('count turns up by one at each swap', () => {
    let prev = turnIndex(0, first);
    for (const t of times) {
      const turn = turnIndex(t, first);
      expect(turn - prev === 0 || turn - prev === 1).toBe(true);
      prev = turn;
    }
    expect(prev).toBeGreaterThan(turnIndex(0, first));
  });

  it('count a new stop for each walk-then-talk cycle', () => {
    const cycle = first.walkSpan + first.talkSpan;
    expect(stopIndex(cycle * 3 - first.cycleOffset + 0.01, first)).toBe(3);
    expect(stopIndex(cycle * 3 - first.cycleOffset - 0.01, first)).toBe(2);
  });

  it('fade the bubble out right at a swap and keep it mid-turn', () => {
    // The k-th swap is where the speaking angle reaches kπ; mid-turn is π/2 past it.
    const at = (angle: number) => (angle - first.pairPhase) / TURN_RATE;
    for (let k = 3; k < 20; k++) {
      const swap = at(k * Math.PI);
      expect(alienPose(loops, first, swap).speak).toBeCloseTo(0.5, 5);
      expect(turnFade(swap, first)).toBe(0);
      expect(turnFade(at(k * Math.PI + Math.PI / 2), first)).toBeCloseTo(1, 5);
    }
  });
});

describe('isConversing', () => {
  const loops = layoutCity({ planet: 'verdan' }).gatherLoops;
  const specs = makeAliens(loops, ALIEN_COUNT, 'verdan');
  const first = specs.find((s) => s.role === 1)!;
  const loner = specs.find((s) => s.role === 0)!;
  const cycle = first.walkSpan + first.talkSpan;
  // Mid-walk and mid-talk times in the pair's first cycle after time 0.
  const base = cycle - first.cycleOffset + cycle;
  const midWalk = base + first.walkSpan / 2;
  const midTalk = base + first.walkSpan + first.talkSpan / 2;

  it('is true for a pair stopped mid-chat', () => {
    expect(isConversing(alienPose(loops, first, midTalk))).toBe(true);
  });

  it('is false for a pair out walking', () => {
    expect(isConversing(alienPose(loops, first, midWalk))).toBe(false);
  });

  it('is never true for a loner, even when it stops', () => {
    for (let t = 0; t < 120; t += 0.25) expect(isConversing(alienPose(loops, loner, t))).toBe(false);
  });
});

describe('distanceFade', () => {
  it('is full up close, gone far off, and falls in between', () => {
    expect(distanceFade(5)).toBe(1);
    expect(distanceFade(CHAT_NEAR)).toBe(1);
    expect(distanceFade(CHAT_FAR)).toBe(0);
    expect(distanceFade(200)).toBe(0);
    const mid = distanceFade((CHAT_NEAR + CHAT_FAR) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});
