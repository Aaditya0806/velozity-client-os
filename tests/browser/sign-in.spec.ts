import { test, expect } from '@playwright/test';
import { DEMO } from './support';

// These run without the stored session: they are about getting one.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('sign-in', () => {
  test('sends an unauthenticated visitor to sign-in', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('rejects a wrong password and says so', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel(/email/i).fill(DEMO.email);
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText(/incorrect|invalid/i).first()).toBeVisible();
    // Still on the form: a failed sign-in must not reach the application.
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('accepts the demo credentials', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel(/email/i).fill(DEMO.email);
    await page.getByLabel(/password/i).fill(DEMO.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
  });
});
