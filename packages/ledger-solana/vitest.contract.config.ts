import { defineConfig } from 'vitest/config';

// Track A's ledger contract suite on an in-process LiteSVM chain (no validator).
export default defineConfig({
  test: { include: ['test/contract.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
