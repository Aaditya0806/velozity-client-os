import { test, expect, watchForErrors, expectNoErrors } from './support';

test.describe('navigation', () => {
  test('moves between sections without a full page reload', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/dashboard');

    // A marker on the window survives client-side routing and is destroyed by a
    // document navigation, which is what distinguishes the two.
    await page.evaluate(() => {
      (window as unknown as { __clientRouted: boolean }).__clientRouted = true;
    });

    await page.getByRole('link', { name: 'Pipeline', exact: true }).click();
    await expect(page).toHaveURL(/\/pipeline/);
    await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();

    const survived = await page.evaluate(
      () => (window as unknown as { __clientRouted?: boolean }).__clientRouted === true,
    );
    expect(survived, 'routing was client-side, not a document reload').toBe(true);

    expectNoErrors(errors, 'dashboard → pipeline');
  });

  test('marks the current section in the rail', async ({ page }) => {
    await page.goto('/clients');
    await expect(page.getByRole('link', { name: 'Clients', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('remembers the collapsed rail across a reload', async ({ page }) => {
    await page.goto('/dashboard');

    const collapse = page.getByRole('button', { name: /collapse navigation/i });
    await collapse.click();

    const expand = page.getByRole('button', { name: /expand navigation/i });
    await expect(expand).toBeVisible();

    // The preference is a cookie read on the server, so it must survive a fresh
    // document load — a preference that resets on every visit is not one.
    await page.reload();
    await expect(page.getByRole('button', { name: /expand navigation/i })).toBeVisible();

    // Leave the workspace as it was found.
    await page.getByRole('button', { name: /expand navigation/i }).click();
    await expect(page.getByRole('button', { name: /collapse navigation/i })).toBeVisible();
  });
});
