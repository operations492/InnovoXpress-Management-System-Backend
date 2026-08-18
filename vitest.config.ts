import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // tests share one DB; run suites serially
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
