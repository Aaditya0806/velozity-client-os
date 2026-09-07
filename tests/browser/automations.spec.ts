import { test, expect, watchForErrors, expectNoErrors } from './support';

/**
 * The automation builder, end to end.
 *
 * This creates a real automation and deletes it again. It is worth the write:
 * the builder generates its form from the engine's own enumerations, and the
 * only way to know the two still agree is to save one and have the server
 * accept it.
 */
test.describe.configure({ mode: 'serial' });

test('builds, saves and removes an automation', async ({ page }) => {
  const errors = watchForErrors(page);
  const name = `Browser test ${Date.now()}`;

  await page.goto('/automations');

  await page.getByRole('button', { name: 'New automation' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Trigger event').selectOption('opportunity.won');

  // A condition, so the IF branch is exercised rather than left empty.
  await dialog.getByRole('button', { name: 'Condition' }).click();
  await dialog.getByLabel('Condition 1 field').fill('opportunity.amount');
  await dialog.getByLabel('Condition 1 operator').selectOption('gt');
  await dialog.getByLabel('Condition 1 value').fill('10000');

  await dialog.getByRole('button', { name: 'Add a timeline note' }).click();
  await dialog.getByLabel(/^Title/).last().fill('Large deal won');

  await dialog.getByRole('button', { name: 'Create automation' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // Scoped to the card itself. A locator like `div` filtered by text matches the
  // outermost element containing it — often the whole page — which then finds
  // any other automation's badge and passes for the wrong reason.
  const card = page.locator(`[data-automation="${name}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // Switched off: creating an automation and letting it start acting are
  // deliberately separate decisions.
  await expect(card.getByText('Paused')).toBeVisible();

  expectNoErrors(errors, 'automation builder');

  // Clean up: this ran against the real demo tenant.
  await card.getByRole('button', { name: `Delete ${name}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
});

test('refuses to save an automation with no actions, and says why', async ({ page }) => {
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Nothing to do');
  await dialog.getByRole('button', { name: 'Create automation' }).click();

  await expect(dialog.getByText(/needs at least one action/i)).toBeVisible();
  // Still open: a refusal that closes the form loses the user's work.
  await expect(dialog).toBeVisible();
});
