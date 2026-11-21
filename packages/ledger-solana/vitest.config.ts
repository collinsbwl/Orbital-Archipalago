import { defineConfig } from 'vitest/config';

// Integration tests against a real solana-test-validator (see test/validator.ts).
export default defineConfig({
  test: {
    include: ['test/solana-ledger.test.ts'],
    globalSetup: ['./test/validator.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
