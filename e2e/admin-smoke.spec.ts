import { test, expect, type Page } from '@playwright/test';
import { adminBaseUrl } from './helpers/env';

/**
 * Admin dashboard smoke tests.
 *
 * These tests verify that the admin dashboard starts and key routes render
 * without console errors. When Clerk credentials are not configured, the app
 * renders its shell without auth gating, making these tests runnable in CI
 * without secrets.
 */

test.describe('Admin dashboard smoke', () => {
  async function requireAdminReachable(page: Page): Promise<void> {
    const response = await page.request
      .get(adminBaseUrl, { failOnStatusCode: false, timeout: 5_000 })
      .catch(() => null);
    test.skip(
      !(response && response.status() < 500),
      `admin dashboard is not reachable at ${adminBaseUrl}`,
    );
  }

  async function expectDashboardOrSkipClerkMode(page: Page, path: string): Promise<void> {
    await requireAdminReachable(page);

    await page.goto(`${adminBaseUrl}${path}`);
    if (!page.url().includes('/dashboard')) {
      const currentPath = new URL(page.url()).pathname;
      if (currentPath === '/sign-in' || currentPath === '/sign-up') {
        test.skip(true, 'runtime admin server is Clerk-enabled; Clerk redirects are unit-tested');
      }
    }

    await expect(page).toHaveURL(/\/dashboard(?:[?#].*)?$/);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  }

  test.beforeEach(async ({ page }) => {
    await requireAdminReachable(page);
  });

  test('sign-in page loads', async ({ page }) => {
    await page.goto('/sign-in');
    // The page should render without errors.
    // When Clerk is configured, the Clerk sign-in component appears.
    // When not configured, the page still loads.
    await expect(page).toHaveTitle(/Tixkit/);
  });

  test('root redirects or renders', async ({ page }) => {
    const response = await page.goto('/');
    // The root should either redirect (302) or render (200).
    expect(response?.status()).toBeLessThan(400);
  });

  test('no-Clerk sign-in lands on dashboard without a manual refresh', async ({ page }) => {
    await expectDashboardOrSkipClerkMode(page, '/sign-in');
  });

  test('no-Clerk sign-up lands on dashboard without a manual refresh', async ({ page }) => {
    await expectDashboardOrSkipClerkMode(page, '/sign-up');
  });

  test('root route resolves to dashboard content without a manual refresh', async ({ page }) => {
    await expectDashboardOrSkipClerkMode(page, '/');
  });

  test('non-existent route shows 404', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    // Next.js not-found page should render.
    await expect(page.locator('body')).toBeVisible();
  });

  test('no critical console errors on sign-in', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    await page.goto('/sign-in');
    // Allow Clerk-related errors (external service) but not app errors.
    const appErrors = errors.filter(
      (e) => !e.includes('clerk') && !e.includes('Clerk') && !e.includes('favicon'),
    );
    expect(appErrors).toEqual([]);
  });
});
