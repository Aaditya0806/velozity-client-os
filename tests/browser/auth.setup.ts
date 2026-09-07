import { test as setup, expect } from '@playwright/test';
import { DEMO, ROUTES } from './support';

const STATE = 'tests/browser/.auth/admin.json';

/**
 * Sign in once; every other spec reuses the resulting session.
 *
 * This is also the first real assertion in the suite: if sign-in is broken,
 * nothing downstream is worth reporting, and a single clear failure here is
 * more use than thirty timeouts.
 */
setup('authenticate and warm every route', async ({ page }) => {
  setup.setTimeout(180_000);

  await page.goto('/sign-in');

  await page.getByLabel(/email/i).fill(DEMO.email);
  await page.getByLabel(/password/i).fill(DEMO.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Landing on the dashboard is the only proof the credentials were accepted;
  // the form stays on screen with a message when they are not.
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: /search or jump to/i })).toBeVisible();

  await page.context().storageState({ path: STATE });

  // `next dev` compiles a route the first time it is requested, and several
  // workers hitting different uncompiled routes at once makes it serve a
  // half-built module graph — the browser then reports
  // `__webpack_modules__[moduleId] is not a function` on whichever routes lost
  // the race, a different set on every run. Touching each route once, in
  // sequence, removes the race rather than retrying past it. Against a
  // production build this loop is simply fast.
  for (const route of ROUTES) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
  }
});
