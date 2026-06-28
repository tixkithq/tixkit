import { test, expect, requireReachable } from './fixtures/validation-test';
import type { APIResponse, Page, Response as PlaywrightResponse, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';

const devOrganizationId = 'org_dev_local';

const settingsRoutes = [
  { path: '/settings', heading: 'Settings Home', name: 'home' },
  { path: '/settings/workspace', heading: 'Workspace', name: 'workspace' },
  { path: '/settings/branding', heading: 'Brand', name: 'brand' },
  { path: '/settings/members', heading: 'Members', name: 'members' },
  { path: '/settings/payments', heading: 'Payments', name: 'payments' },
  { path: '/settings/billing', heading: 'Billing', name: 'billing' },
  { path: '/settings/profile', heading: 'Profile', name: 'profile' },
  { path: '/settings/appearance', heading: 'Appearance', name: 'appearance' },
] as const;

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectJsonStatus<T>(
  response: APIResponse | PlaywrightResponse,
  expectedStatus: number,
): Promise<T> {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body as T;
}

test.describe('admin settings validation', () => {
  test('settings primary routes render across desktop and mobile without accessibility regressions', async ({
    page,
  }, testInfo) => {
    test.slow();
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const route of settingsRoutes) {
      await page.goto(`${adminBaseUrl}${route.path}`);
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
      await expect(
        page.getByRole('navigation').getByRole('link', { name: 'Workspace' }),
      ).toBeVisible();
      await attachScreenshot(page, testInfo, `settings-${route.name}-desktop`);
      await expectNoAxeViolations(page, testInfo);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of settingsRoutes) {
      await page.goto(`${adminBaseUrl}${route.path}`);
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
      await attachScreenshot(page, testInfo, `settings-${route.name}-mobile`);
    }
    await expectNoAxeViolations(page, testInfo);
  });

  test('profile gated actions stay inactive and pass axe', async ({ page }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.goto(`${adminBaseUrl}/settings/profile`);
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();

    const avatar = page.getByRole('button', { name: 'Change Avatar' });
    if (await avatar.isVisible().catch(() => false)) {
      await expect(avatar).toHaveAttribute('aria-disabled', 'true');
    }

    const save = page.getByRole('button', { name: 'Save Changes' });
    if (await save.isVisible().catch(() => false)) {
      await expect(save).toHaveAttribute('aria-disabled', 'true');
    }

    await attachScreenshot(page, testInfo, 'settings-profile');
    await expectNoAxeViolations(page, testInfo);
  });

  test('branding settings persist name, color, and custom domain changes', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const initialName = `E2E Brand ${suffix}`;
    const updatedName = `E2E Brand ${suffix} Updated`;
    const updatedColor = '#1d4ed8';
    const domain = `brand-${suffix}.example.test`.toLowerCase();
    const createdBrand = await expectJsonStatus<{
      id: string;
      name: string;
      theme?: { primaryColor?: string };
    }>(
      await page.request.post(`${apiBaseUrl}/v1/brands`, {
        data: {
          organizationId: devOrganizationId,
          name: initialName,
          slug: `e2e-brand-${suffix}`,
          theme: { primaryColor: '#222222' },
          whiteLabel: true,
        },
        failOnStatusCode: false,
      }),
      201,
    );
    expect(createdBrand.name).toBe(initialName);
    expect(createdBrand.theme?.primaryColor).toBe('#222222');

    await page.addInitScript(
      (selection) => {
        window.localStorage.setItem('tixkit:selected-organization-id', selection.organizationId);
        window.localStorage.setItem('tixkit:selected-brand-id', selection.brandId);
      },
      {
        organizationId: devOrganizationId,
        brandId: createdBrand.id,
      },
    );

    await page.goto(`${adminBaseUrl}/settings/branding`);
    await expect(page.getByRole('heading', { name: 'Brand' })).toBeVisible();
    await expect(page.getByLabel('Brand Name')).toHaveValue(initialName);

    await page.getByLabel('Brand Name').fill(updatedName);
    await page.getByLabel('Hex value').fill(updatedColor);

    const updateResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/brands/${createdBrand.id}` &&
        response.request().method() === 'PATCH'
      );
    });
    await page.getByRole('button', { name: 'Save Changes' }).click();
    const updatedBrand = await expectJsonStatus<{
      id: string;
      name: string;
      theme?: { primaryColor?: string };
    }>(await updateResponsePromise, 200);
    expect(updatedBrand).toMatchObject({
      id: createdBrand.id,
      name: updatedName,
      theme: expect.objectContaining({ primaryColor: updatedColor }),
    });

    await page.getByLabel('Domain').fill(domain);
    const domainResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/brands/${createdBrand.id}/domains` &&
        response.request().method() === 'POST'
      );
    });
    await page.getByRole('button', { name: 'Add' }).click();
    const addedDomain = await expectJsonStatus<{
      brandId: string;
      domain: string;
      isPrimary: boolean;
      sslStatus: string;
    }>(await domainResponsePromise, 201);
    expect(addedDomain).toMatchObject({
      brandId: createdBrand.id,
      domain,
      isPrimary: true,
      sslStatus: 'pending',
    });

    const brandsResponse = await page.request.get(`${apiBaseUrl}/v1/brands`, {
      failOnStatusCode: false,
    });
    const brands = await expectJsonStatus<
      Array<{
        id: string;
        name: string;
        theme?: { primaryColor?: string } | string;
        domains?: Array<{ domain: string; sslStatus: string }>;
      }>
    >(brandsResponse, 200);
    expect(brands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdBrand.id,
          name: updatedName,
          domains: expect.arrayContaining([expect.objectContaining({ domain })]),
        }),
      ]),
    );

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Brand' })).toBeVisible();
    await expect(page.getByLabel('Brand Name')).toHaveValue(updatedName);
    await expect(page.getByLabel('Hex value')).toHaveValue(updatedColor);
    await expect(page.getByText(domain, { exact: true })).toBeVisible();
    await attachScreenshot(page, testInfo, 'settings-branding-round-trip');
    await expectNoAxeViolations(page, testInfo);
  });

  test('billing invoice action is not exposed as an enabled fake success path', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.goto(`${adminBaseUrl}/settings/billing`);
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

    const invoices = page.getByRole('button', { name: 'Download Invoices' });
    if (await invoices.isVisible().catch(() => false)) {
      await expect(invoices).toHaveAttribute('aria-disabled', 'true');
    }

    await attachScreenshot(page, testInfo, 'settings-billing');
    await expectNoAxeViolations(page, testInfo);
  });
});
