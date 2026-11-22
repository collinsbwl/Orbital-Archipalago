// Gemini pricing. One table of USD per million tokens; `price(usage)` reads it.
// Thinking tokens are billed as output (architecture.md §3.6).

import type { Usage } from '@orbital/contracts';

export interface PricePerMillion {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Dollars per million tokens, keyed by pinned model id. Update when Gemini publishes new rates.
 * DEFAULT: values reflect the Gemini 2.5 rate card as of Nov 2026.
 */
export const PRICE_TABLE: Record<string, PricePerMillion> = {
  'gemini-2.5-flash': { input: 0.3, cachedInput: 0.075, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, cachedInput: 0.3125, output: 10 },
  // Decisions API: input-only billing, no caching (so cached = input), output always 0.
  'gemini-decision-1': { input: 0.1, cachedInput: 0.1, output: 0 },
  stub: { input: 0, cachedInput: 0, output: 0 },
};

/** USD for a single call. Callers write this into `Usage.costUsd` before recording. */
export function price(u: Pick<Usage, 'model' | 'inputTokens' | 'cachedTokens' | 'outputTokens'>): number {
  const rate = PRICE_TABLE[u.model];
  if (!rate) return 0;
  const uncachedIn = Math.max(0, u.inputTokens - u.cachedTokens);
  return (
    (uncachedIn * rate.input + u.cachedTokens * rate.cachedInput + u.outputTokens * rate.output) /
    1_000_000
  );
}
