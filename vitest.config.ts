import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Tests run against an in-process PostgreSQL and stubbed providers, so this
// only needs to satisfy the env schema - no real credentials are involved.
loadEnv({ path: '.env.test' });

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // PGlite is a single in-process PostgreSQL per file; running files in
    // parallel forks is fine, tests within a file must be serial.
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
