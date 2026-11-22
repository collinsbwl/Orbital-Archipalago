import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../test-fixtures';
import { planetDetails, planetTitle } from './labels';

describe('planet labels', () => {
  it('capitalise the planet id for the name', () => {
    expect(planetTitle('helion')).toBe('Helion');
    expect(planetTitle('tethys')).toBe('Tethys');
    expect(planetTitle('')).toBe('');
    expect(planetTitle('x')).toBe('X');
  });

  it('give the currency and a quick economy read for the hover details', () => {
    const p = makeSnapshot(3).planets[0]!;
    expect(planetDetails(p)).toEqual(['HLX', 'GDP 1,000', 'CPI 100.0', 'Population 30']);
    expect(planetDetails({ ...p, metrics: { ...p.metrics, gdp: 1_234_567, cpi: 14_333 } })).toEqual(['HLX', 'GDP 1,234,567', 'CPI 143.3', 'Population 30']);
  });
});
