import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    environment: 'node',
    include: ['focused-checks/**/*.check.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
