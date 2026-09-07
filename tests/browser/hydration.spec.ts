import { test, expect, ROUTES, watchForErrors, expectNoErrors, expectHydrated } from './support';

/**
 * The suite this project was missing.
 *
 * A stale build once left every authenticated route rendering perfectly and
 * responding to nothing: the layout's JavaScript chunk 404ed, React never
 * attached, and every button on every page was inert. All 182 logic tests
 * passed throughout. Server-rendered HTML is not evidence that a page works.
 */
test.describe('every route renders, hydrates and reports no errors', () => {
  for (const route of ROUTES) {
    test(`${route} is usable`, async ({ page }) => {
      const errors = watchForErrors(page);

      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), `${route} responded`).toBeLessThan(400);

      // Not redirected to sign-in: the session from setup is being honoured.
      await expect(page).toHaveURL(new RegExp(`${route}(\\?.*)?$`));

      await expectHydrated(page);
      expectNoErrors(errors, route);
    });
  }
});

test('the dashboard renders its own content, not only the loading skeleton', async ({ page }) => {
  // Every route has a loading.tsx, so a page that never resolves still paints
  // something. Reaching first paint is not the same as reaching the data.
  await page.goto('/dashboard');
  await expect(page.getByRole('button', { name: /search or jump to/i })).toBeVisible();
  await expect(page.locator('main')).not.toBeEmpty();
  // The shell is present on the skeleton too; the org name in the rail is only
  // rendered once the server component has resolved its context.
  await expect(page.getByText(/velozity global/i).first()).toBeVisible();
});
