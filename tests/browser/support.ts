import { test as base, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * The shared test fixture.
 *
 * Next's development overlay renders a `<nextjs-portal>` that sits above the
 * page and swallows pointer events aimed at anything beneath it. It exists only
 * in development, so a click it blocks is an artefact of the harness rather than
 * a defect in the product — but it fails the test just as convincingly.
 *
 * Neutralised for pointer events only: the overlay still renders, and the
 * console-error checks that catch real failures are untouched.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const hide = () => {
        const style = document.createElement('style');
        style.textContent = 'nextjs-portal { pointer-events: none !important; }';
        document.head?.appendChild(style);
      };
      if (document.head) hide();
      else document.addEventListener('DOMContentLoaded', hide, { once: true });
    });
    await use(page);
  },
});

export const DEMO = {
  email: process.env.PLAYWRIGHT_USER ?? 'admin@velozity.demo',
  password: process.env.SEED_DEMO_PASSWORD ?? 'Velozity!Demo2026',
} as const;

/** Every authenticated route, as the sidebar offers them. */
export const ROUTES = [
  '/dashboard',
  '/pipeline',
  '/clients',
  '/services',
  '/projects',
  '/tasks',
  '/documents',
  '/legal',
  '/legal/renewals',
  '/finance',
  '/reports',
  '/ai',
  '/automations',
  '/settings',
] as const;

/**
 * Console noise that is expected and says nothing about correctness.
 *
 * Kept deliberately short. A permissive list here would defeat the purpose:
 * the bug this suite was written for announced itself only as a console error.
 */
const IGNORED = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  // Next's dev overlay and HMR client, which do not run in a production build.
  /webpack-hmr/i,
];

export interface PageErrors {
  /** Console messages at error level. */
  console: string[];
  /** Uncaught exceptions, which is where a ChunkLoadError surfaces. */
  uncaught: string[];
  /** Failed sub-resource requests — a missing JS chunk appears here first. */
  failedRequests: string[];
}

/**
 * Collect everything that indicates the page did not load correctly.
 *
 * Call before navigating. The three channels are separate because they fail
 * differently: a 404 on a chunk is a failed request, the resulting
 * ChunkLoadError is an uncaught exception, and a component throwing during
 * render is a console error. A build corrupted mid-session produced all three,
 * while the entire vitest suite stayed green.
 */
export function watchForErrors(page: Page): PageErrors {
  const errors: PageErrors = { console: [], uncaught: [], failedRequests: [] };

  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED.some((pattern) => pattern.test(text))) return;
    errors.console.push(text);
  });

  page.on('pageerror', (error) => {
    errors.uncaught.push(error.message);
  });

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    // Playwright reports a cancelled navigation as a failure; only static
    // assets and API calls are meaningful here.
    if (failure.includes('ERR_ABORTED')) return;
    errors.failedRequests.push(`${request.url()} — ${failure}`);
  });

  page.on('response', (response) => {
    const url = response.url();
    if (response.status() >= 400 && url.includes('/_next/static/')) {
      errors.failedRequests.push(`${url} — HTTP ${response.status()}`);
    }
  });

  return errors;
}

export function expectNoErrors(errors: PageErrors, context: string): void {
  expect(
    {
      console: errors.console,
      uncaught: errors.uncaught,
      failedRequests: errors.failedRequests,
    },
    `${context} loaded without errors`,
  ).toEqual({ console: [], uncaught: [], failedRequests: [] });
}

/**
 * Assert that React actually attached on this page.
 *
 * Rendering is not the same as working: a server-rendered page whose JavaScript
 * never ran looks completely normal and does nothing at all. The only honest
 * check is to interact with something and require a response. The command bar
 * lives in the dashboard layout, so this exercises the shared chunk that every
 * authenticated route depends on.
 */
export async function expectHydrated(page: Page): Promise<void> {
  const search = page.getByRole('button', { name: /search or jump to/i });
  await expect(search, 'the header search button is present').toBeVisible();

  const dialog = page.getByRole('dialog');

  // Hydration is asynchronous, and a click that lands before React attaches is
  // silently discarded rather than queued. Waiting a fixed interval would trade
  // one flake for another, so this retries the interaction until it takes
  // effect — which is precisely the condition being asserted. The button sets
  // the dialog open rather than toggling it, so repeating the click is safe.
  await expect(async () => {
    await search.click();
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }, 'clicking search opens the command bar — proving React is attached').toPass({
    timeout: 30_000,
  });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

export { expect };
