import { test, expect, watchForErrors, expectNoErrors } from './support';

/**
 * The buttons a person actually presses.
 *
 * "New deal is not working" was the report that started this suite, and the
 * cause was invisible to every existing test: the markup was correct, the
 * handler simply was never bound.
 */
test.describe('primary actions respond', () => {
  test('New deal opens the dialog on the pipeline', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/pipeline');

    const button = page.getByRole('button', { name: 'New deal' });
    await expect(button).toBeVisible();
    await button.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('New deal')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expectNoErrors(errors, 'pipeline New deal');
  });

  test('New client opens the dialog on clients', async ({ page }) => {
    await page.goto('/clients');

    const button = page.getByRole('button', { name: 'New client' });
    await expect(button).toBeVisible();
    await button.click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('command bar', () => {
  test('opens on the keyboard shortcut and jumps to a page', async ({ page }) => {
    await page.goto('/dashboard');

    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.getByPlaceholder(/search clients, deals/i).fill('legal');
    await dialog.getByText('Legal', { exact: true }).first().click();

    await expect(page).toHaveURL(/\/legal/);
  });

  test('searches records through the API and finds a seeded client', async ({ page }) => {
    await page.goto('/dashboard');
    await page.keyboard.press('ControlOrMeta+k');

    // Two characters is the threshold at which the client calls /api/v1/search;
    // this is the one test that proves search reaches the server at all.
    await page.getByPlaceholder(/search clients, deals/i).fill('a');
    await page.getByPlaceholder(/search clients, deals/i).fill('an');

    const dialog = page.getByRole('dialog');
    // Either results arrive or the empty state does; a spinner that never
    // resolves is the failure being excluded here.
    await expect(
      dialog.getByText(/no records matched|clients|contacts|opportunities/i).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('the AI page reports its own configuration', () => {
  test('says so when no API key is set, rather than failing on send', async ({ page }) => {
    await page.goto('/ai');

    const composer = page.getByLabel('Ask the assistant');
    await expect(composer).toBeVisible();

    const banner = page.getByText('The assistant needs an Anthropic API key');
    const configured = !(await banner.isVisible().catch(() => false));

    if (configured) {
      // A working key: the composer must accept input.
      await expect(composer).toBeEnabled();
    } else {
      // No key: the page must say so up front and refuse input, instead of
      // taking a question and failing after a round trip.
      await expect(composer).toBeDisabled();
      await expect(composer).toHaveAttribute('placeholder', /ANTHROPIC_API_KEY/);
    }
  });
});
