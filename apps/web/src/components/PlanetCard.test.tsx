import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../test-fixtures';
import { PlanetCard, planetFacts } from './PlanetCard';

const verdan = makeSnapshot(5).planets[1]!;

describe('PlanetCard', () => {
  it('lists the planet economy numbers', () => {
    expect(planetFacts(verdan)).toEqual([
      ['GDP', '1,000'], ['Inflation (CPI)', '100.0'], ['Trade balance', '-5'], ['Population', '30'],
      ['Consumer confidence', '50'], ['Business confidence', '50'], ['Policy rate', '2.00%'],
    ]);
  });

  it('shows the name, currency and numbers, and goes back on click', () => {
    const onBack = vi.fn();
    render(<PlanetCard planet={verdan} onBack={onBack} />);
    expect(screen.getByText('Verdan')).toBeTruthy();
    expect(screen.getByText('VRD')).toBeTruthy();
    expect(screen.getByText('Population')).toBeTruthy();
    expect(screen.getByText('Policy rate')).toBeTruthy();
    fireEvent.click(screen.getByText('Back to map (Esc)'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows new numbers when the snapshot changes', () => {
    const { rerender } = render(<PlanetCard planet={verdan} onBack={() => {}} />);
    expect(screen.getByText('1,000')).toBeTruthy();
    rerender(<PlanetCard planet={{ ...verdan, metrics: { ...verdan.metrics, gdp: 2_468 } }} onBack={() => {}} />);
    expect(screen.getByText('2,468')).toBeTruthy();
  });
});
