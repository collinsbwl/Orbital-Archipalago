import { describe, expect, it } from 'vitest';
import { createPoseMemory, forget, recall, remember } from './map-pose';

const home = { position: { x: 0, y: 7.5, z: 10.5 }, target: { x: 0, y: 0, z: 0 } };

describe('map pose memory', () => {
  it('falls back when nothing was saved', () => {
    expect(recall(createPoseMemory(), home)).toBe(home);
  });

  it('keeps the first pose and ignores later ones', () => {
    const m = createPoseMemory();
    remember(m, { x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
    remember(m, { x: 9, y: 9, z: 9 }, { x: 9, y: 9, z: 9 });
    expect(recall(m, home).position).toEqual({ x: 1, y: 2, z: 3 });
    expect(recall(m, home).target).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('copies the numbers, so a camera that keeps moving does not change the memory', () => {
    const m = createPoseMemory();
    const pos = { x: 1, y: 2, z: 3 };
    remember(m, pos, { x: 0, y: 0, z: 0 });
    pos.x = 50;
    expect(recall(m, home).position.x).toBe(1);
  });

  it('forgets', () => {
    const m = createPoseMemory();
    remember(m, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 });
    forget(m);
    remember(m, { x: 7, y: 7, z: 7 }, { x: 0, y: 0, z: 0 });
    expect(recall(m, home).position.x).toBe(7);
  });
});
