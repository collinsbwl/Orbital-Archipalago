import { describe, expect, it } from 'vitest';
import { PRICE_TABLE, price } from '../src/pricing.js';

describe('pricing', () => {
  it('discounts cached input tokens', () => {
    const noCache = price({ model: 'gemini-2.5-flash', inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 });
    const withCache = price({ model: 'gemini-2.5-flash', inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0 });
    expect(noCache).toBeCloseTo(PRICE_TABLE['gemini-2.5-flash']!.input);
    expect(withCache).toBeCloseTo(PRICE_TABLE['gemini-2.5-flash']!.cachedInput);
    expect(withCache).toBeLessThan(noCache);
  });

  it('prices output per rate', () => {
    expect(price({ model: 'gemini-2.5-flash', inputTokens: 0, cachedTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(
      PRICE_TABLE['gemini-2.5-flash']!.output,
    );
  });

  it('stub costs zero', () => {
    expect(price({ model: 'stub', inputTokens: 10_000, cachedTokens: 0, outputTokens: 5_000 })).toBe(0);
  });
});
