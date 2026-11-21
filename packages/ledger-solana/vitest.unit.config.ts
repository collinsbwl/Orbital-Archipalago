import { defineConfig } from 'vitest/config';

// Adapter tests on an in-process LiteSVM chain (no validator), beyond Track A's suite, plus the swap-in comparison.
export default defineConfig({
  test: { include: ['test/adapter.test.ts', 'test/swap-in.test.ts'], testTimeout: 300_000, hookTimeout: 60_000 },
});
