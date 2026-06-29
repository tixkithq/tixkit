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

  test('workspace settings persist box-office policy with axe and CDP proof', async ({
    browserName,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const updatedName = `E2E Workspace ${suffix} Updated`;
    const organizations = await expectJsonStatus<
      Array<{
        id: string;
        name: string;
        slug: string;
        boxOfficeSettings: {
          enabled: boolean;
          allowedTenderTypes: string[];
          requireBuyerEmail: boolean;
          receiptMode: string;
        };
      }>
    >(
      await page.request.get(`${apiBaseUrl}/v1/organizations`, {
        failOnStatusCode: false,
      }),
      200,
    );
    const originalOrganization = organizations.find(
      (organization) => organization.id === devOrganizationId,
    );
    expect(originalOrganization).toBeDefined();
    const originalSettings = originalOrganization!.boxOfficeSettings;
    const originalName = originalOrganization!.name;
    const originalSlug = originalOrganization!.slug;

    await expectJsonStatus<{
      id: string;
      name: string;
      boxOfficeSettings: {
        enabled: boolean;
        allowedTenderTypes: string[];
        requireBuyerEmail: boolean;
        receiptMode: string;
      };
    }>(
      await page.request.patch(`${apiBaseUrl}/v1/organizations/${devOrganizationId}`, {
        data: {
          name: originalName,
          slug: originalSlug,
          boxOfficeSettings: {
            enabled: true,
            allowedTenderTypes: ['cash', 'manual_card', 'comp'],
            requireBuyerEmail: false,
            receiptMode: 'email',
          },
        },
        failOnStatusCode: false,
      }),
      200,
    );

    await page.addInitScript(
      (selection) => {
        window.localStorage.setItem('tixkit:selected-organization-id', selection.organizationId);
      },
      {
        organizationId: devOrganizationId,
      },
    );

    try {
      await page.goto(`${adminBaseUrl}/settings/workspace`);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.getByLabel('Workspace Name')).toHaveValue(originalName);
      await expect(page.getByLabel('Manual Card')).toBeChecked();
      await expect(page.getByText('Require buyer email for at-door orders')).toBeVisible();

      await page.getByLabel('Workspace Name').fill(updatedName);
      await page.getByLabel('Manual Card').click();
      await page.getByText('Require buyer email for at-door orders').click();

      const updateResponsePromise = page.waitForResponse((response) => {
        return (
          response.url() === `${apiBaseUrl}/v1/organizations/${devOrganizationId}` &&
          response.request().method() === 'PATCH'
        );
      });
      await page.getByRole('button', { name: 'Save Changes' }).click();
      const updatedOrganization = await expectJsonStatus<{
        id: string;
        name: string;
        boxOfficeSettings: {
          enabled: boolean;
          allowedTenderTypes: string[];
          requireBuyerEmail: boolean;
          receiptMode: string;
        };
      }>(await updateResponsePromise, 200);
      expect(updatedOrganization).toMatchObject({
        id: devOrganizationId,
        name: updatedName,
        boxOfficeSettings: {
          enabled: true,
          allowedTenderTypes: ['cash', 'comp'],
          requireBuyerEmail: true,
          receiptMode: 'email',
        },
      });

      await page.reload();
      await expect(page.getByLabel('Workspace Name')).toHaveValue(updatedName);
      await expect(page.getByLabel('Cash')).toBeChecked();
      await expect(page.getByLabel('Manual Card')).not.toBeChecked();
      await expect(page.getByLabel('Comp')).toBeChecked();
      await expect(page.getByLabel('Require buyer email for at-door orders')).toBeChecked();
      await attachScreenshot(page, testInfo, 'settings-workspace-box-office-policy');
      await expectNoAxeViolations(page, testInfo);

      if (browserName === 'chromium') {
        const client = await page.context().newCDPSession(page);
        const metrics = await client.send('Runtime.evaluate', {
          returnByValue: true,
          expression: `(() => {
            const selectors = ['#org-name', '#org-slug', '#box-office-enabled', '#require-buyer-email'];
            return selectors.map((selector) => {
              const node = document.querySelector(selector);
              if (!node) return { selector, width: 0, height: 0 };
              const rect = node.getBoundingClientRect();
              return { selector, width: rect.width, height: rect.height };
            });
          })()`,
        });
        const layout = metrics.result.value as Array<{
          selector: string;
          width: number;
          height: number;
        }>;
        await testInfo.attach('settings-workspace-cdp-layout', {
          body: JSON.stringify(layout, null, 2),
          contentType: 'application/json',
        });
        for (const item of layout) {
          expect(item.width, item.selector).toBeGreaterThan(0);
          expect(item.height, item.selector).toBeGreaterThan(0);
        }
      }
    } finally {
      await page.request.patch(`${apiBaseUrl}/v1/organizations/${devOrganizationId}`, {
        data: {
          name: originalName,
          slug: originalSlug,
          boxOfficeSettings: originalSettings,
        },
        failOnStatusCode: false,
      });
    }
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
