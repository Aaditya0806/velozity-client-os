import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

// Browser tests run against the real application: a real Next server, the real
// Supabase project and the seeded demo tenant. Unlike the vitest suites, which
// substitute PGlite and stub the providers, nothing here is in-process — that is
// the point. These cover what those cannot see: whether the thing renders,
// hydrates and responds to a click.
loadEnv({ path: '.env' });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/browser',
  // vitest owns `*.test.ts` under tests/; Playwright owns `*.spec.ts`. Keeping
  // the extensions distinct means neither runner ever collects the other's
  // files, which it would fail on in confusing ways.
  testMatch: '**/*.spec.ts',

  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // One worker, always. Parallel workers fight the dev server's on-demand
  // compilation — several first-hits at once yield a half-built module graph
  // and `__webpack_modules__ is not a function` on whichever route lost — and
  // they exhaust the database pooler's connection cap. Both produce failures
  // that move between runs and say nothing about the code. A suite that is
  // trusted matters more than one that is quick.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The app is served from one region and the database from another; the
    // default 30s action timeout is tight enough to flake on a cold route.
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [
    // Signs in once and writes a storage state the rest reuse, so 30 tests do
    // not perform 30 sign-ins against a live GoTrue.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'tests/browser/.auth/admin.json' },
      dependencies: ['setup'],
    },
  ],

  webServer: {
    // `next dev`, never `next build`. A production build writes into the same
    // .next directory a running dev server is reading from, which corrupts it
    // and leaves every page served but unhydrated — the exact failure these
    // tests exist to catch.
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
