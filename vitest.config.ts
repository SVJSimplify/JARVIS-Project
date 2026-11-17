import { defineConfig } from 'vitest/config';

/**
 * Dedicated test runner config. vite.config.ts sets root=src/renderer for the renderer
 * build; without this file vitest inherited that root and found no tests (the `npm test`
 * script ran zero tests and exited 1). Root stays the project so tests/ and src/ resolve.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxConcurrency: 4,
  },
});
