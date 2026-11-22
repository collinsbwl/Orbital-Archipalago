import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@orbital/contracts';
import { EventFeed } from './EventFeed';

const events: SimEvent[] = [
  { id: 'e1', cycle: 3, kind: 'policy', text: 'Tethys policy rate 0 -> 15 bp (inflation 0 bp, output gap -505 bp)' },
  { id: 'e2', cycle: 4, kind: 'crisis', planet: 'helion', text: 'Recession: Helion GDP fell 36.4% over 2 consecutive 5-cycle periods' },
];

describe('EventFeed', () => {
  it('shows only big events, as headlines', () => {
    render(<EventFeed events={events} />);
    expect(screen.queryByText(/Tethys policy rate/)).toBeNull();
    expect(screen.queryByText(/^Recession:/)).toBeNull();
    expect(screen.getByText('Helion')).toBeTruthy(); // planet chip
    expect(screen.getByText('-36.4%')).toBeTruthy(); // what changed and by how much
    expect(screen.queryByLabelText('Headlines only')).toBeNull();
  });

  it('says there is no big news when only routine events exist', () => {
    render(<EventFeed events={[events[0]!]} />);
    expect(screen.getByText('No big news yet.')).toBeTruthy();
  });
});

describe('EventFeed animation', () => {
  it('keeps a story that dropped out briefly, marked leaving, then removes it', async () => {
    const { vi } = await import('vitest');
    const { act } = await import('@testing-library/react');
    const { EXIT_MS } = await import('./motion');
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<EventFeed events={events} />);
      rerender(<EventFeed events={[events[0]!]} />);
      expect(container.querySelector('li.leaving')).toBeTruthy();
      act(() => vi.advanceTimersByTime(EXIT_MS));
      expect(container.querySelector('li')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
