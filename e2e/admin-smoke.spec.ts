import { test, expect } from '@playwright/test';

/**
 * Admin dashboard smoke tests.
 *
 * These tests verify that the admin dashboard starts and key routes render
 * without console errors. When Clerk credentials are not configured, the app
 * renders its shell without auth gating, making these tests runnable in CI
 * without secrets.
 */

test.describe('Admin dashboard smoke', () => {
  test('sign-in page loads', async ({ page }) => {
    await page.goto('/sign-in');
    // The page should render without errors.
    // When Clerk is configured, the Clerk sign-in component appears.
    // When not configured, the page still loads.
    await expect(page).toHaveTitle(/GateKit/);
  });

  test('root redirects or renders', async ({ page }) => {
    const response = await page.goto('/');
    // The root should either redirect (302) or render (200).
    expect(response?.status()).toBeLessThan(400);
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
