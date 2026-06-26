import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility gate tests using axe-core.
 *
 * These tests run axe accessibility checks against pages that are accessible
 * without authentication. When the admin dashboard is extended with auth
 * mocking, additional pages can be added here.
 */

test.describe('Admin dashboard accessibility', () => {
  test('sign-in page has no critical axe violations', async ({ page }) => {
    await page.goto('/sign-in');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    // Log violations for debugging.
    if (criticalViolations.length > 0) {
      console.error(
        'Accessibility violations:',
        JSON.stringify(criticalViolations, null, 2),
      );
    }

    expect(criticalViolations).toEqual([]);
  });

  test('404 page has no critical axe violations', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    if (criticalViolations.length > 0) {
      console.error(
        'Accessibility violations on 404:',
        JSON.stringify(criticalViolations, null, 2),
      );
    }

    expect(criticalViolations).toEqual([]);
  });

  test('dashboard shell has no critical axe violations', async ({ page }) => {
    // When Clerk is not configured, the dashboard shell renders without auth.
    // This tests the layout/sidebar/navigation for accessibility.
    await page.goto('/dashboard');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    if (criticalViolations.length > 0) {
      console.error(
        'Accessibility violations on dashboard:',
        JSON.stringify(criticalViolations, null, 2),
      );
    }

    expect(criticalViolations).toEqual([]);
  });
});
