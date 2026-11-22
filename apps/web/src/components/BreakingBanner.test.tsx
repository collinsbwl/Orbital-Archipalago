import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimEvent } from '@orbital/contracts';
import { BANNER_MS, BreakingBanner } from './BreakingBanner';
import { EXIT_MS } from './motion';

const tradeWar: SimEvent = { id: 'e2', cycle: 9, kind: 'crisis', text: 'Trade war: Helion and Verdan raised tariffs within 3 cycles' };
const smallRate: SimEvent = { id: 'e3', cycle: 9, kind: 'policy', text: 'Tethys policy rate 0 -> 15 bp (inflation 0 bp, output gap -505 bp)' };
const old: SimEvent = { id: 'e1', cycle: 1, kind: 'crisis', text: 'Trade war: Helion and Tethys raised tariffs within 2 cycles' };

describe('BreakingBanner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ignores news already there on load', () => {
    render(<BreakingBanner events={[old]} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('slides in for a new breaking event, not a routine one, then leaves on its own', () => {
    const { rerender } = render(<BreakingBanner events={[old]} />);
    rerender(<BreakingBanner events={[old, smallRate]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<BreakingBanner events={[old, smallRate, tradeWar]} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Verdan/);
    act(() => vi.advanceTimersByTime(BANNER_MS));
    expect(screen.getByRole('alert').className).toContain('leaving'); // slides out first
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('can be dismissed', () => {
    const { rerender } = render(<BreakingBanner events={[]} />);
    rerender(<BreakingBanner events={[tradeWar]} />);
    fireEvent.click(screen.getByLabelText('Dismiss breaking news'));
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('BreakingBanner on a planet', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const recession = (planet: string, id: string): SimEvent =>
    ({ id, cycle: 9, kind: 'crisis', planet: planet.toLowerCase(), text: `Recession: ${planet} GDP fell 20.0% over 2 consecutive 5-cycle periods` });

  it("shows only the focused planet's news", () => {
    const { rerender } = render(<BreakingBanner events={[]} focused="helion" />);
    rerender(<BreakingBanner events={[recession('Tethys', 'e1')]} focused="helion" />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<BreakingBanner events={[recession('Tethys', 'e1'), tradeWar]} focused="helion" />); // Helion vs Verdan
    expect(screen.getByRole('alert').textContent).toMatch(/Helion/);
  });

  it('hides a story about another planet when the player lands somewhere else', () => {
    const { rerender } = render(<BreakingBanner events={[]} />);
    rerender(<BreakingBanner events={[recession('Tethys', 'e1')]} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<BreakingBanner events={[recession('Tethys', 'e1')]} focused="helion" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pops up again when looped playback replays the same events', () => {
    const { rerender } = render(<BreakingBanner events={[]} cycle={1} />);
    rerender(<BreakingBanner events={[tradeWar]} cycle={9} />);
    act(() => vi.advanceTimersByTime(BANNER_MS));
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<BreakingBanner events={[]} cycle={0} />); // loop restarts
    rerender(<BreakingBanner events={[tradeWar]} cycle={9} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
