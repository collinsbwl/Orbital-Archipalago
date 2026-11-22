import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tick, tickTone } from './motion';

describe('tickTone', () => {
  it('is good when a number moves the good way, bad the other way, and null when unchanged', () => {
    expect(tickTone(100, 120, 'up')).toBe('good'); // GDP up
    expect(tickTone(100, 80, 'up')).toBe('bad');
    expect(tickTone(100, 120, 'down')).toBe('bad'); // inflation up
    expect(tickTone(100, 80, 'down')).toBe('good');
    expect(tickTone(100, 120, 'none')).toBe('neutral');
    expect(tickTone(100, 100, 'up')).toBeNull();
  });
});

describe('Tick', () => {
  it('does not flash at first, then flashes in the tone of each change', () => {
    const { container, rerender } = render(<Tick value={100} better="up">100</Tick>);
    expect(container.querySelector('.tick')!.className).toBe('tick');
    rerender(<Tick value={120} better="up">120</Tick>);
    expect(container.querySelector('.tick')!.className).toContain('tick-good');
    rerender(<Tick value={90} better="up">90</Tick>);
    expect(container.querySelector('.tick')!.className).toContain('tick-bad');
  });
});
