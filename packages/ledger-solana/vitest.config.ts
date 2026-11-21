import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/validator.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
