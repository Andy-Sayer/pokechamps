import { defineConfig } from 'vitest/config';

// Root aggregator so `npx vitest` (run or watch) from the repo root picks up
// every workspace's OWN vitest config — crucially the web package's
// `environment: 'jsdom'`. Without this, a bare root `vitest` runs all suites
// in one node-environment process and the web tests false-fail with
// `localStorage is not defined`. `npm test` (per-workspace) is unaffected.
export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/server',
      'packages/tui',
      'packages/web',
      'packages/vision',
    ],
  },
});
