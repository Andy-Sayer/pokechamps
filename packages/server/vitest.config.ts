import { defineConfig } from 'vitest/config';

// Server tests run against an in-memory sqlite DB. Each test file gets its
// own process (default vitest behaviour) so the connection singleton is fresh.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // bcrypt at cost=12 is ~250ms/hash; a few register/login round trips push
    // the default 5s timeout uncomfortably close.
    testTimeout: 20_000,
  },
});
