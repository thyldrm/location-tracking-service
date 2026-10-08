import { defineConfig } from 'vitest/config';

/**
 * Integration and end-to-end tests. They run against real infrastructure started with Testcontainers
 * (see test/setup/global-setup.ts), so Docker must be available.
 */
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts', 'test/**/*.e2e-spec.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    // Test files share one database; run them one at a time so they cannot interfere.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
