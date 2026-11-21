import { defineConfig } from 'vitest/config';

// Adapter tests on an in-process LiteSVM chain (no validator), beyond Track A's suite.
export default defineConfig({ test: { include: ['test/adapter.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } });
