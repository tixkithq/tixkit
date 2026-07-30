import { type Page, type Response as PlaywrightResponse, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  currentResaleTermsAcceptance,
  seedFreeCheckoutEvent,
  seedPaidRefundableOrder,
  seedTicketVariantCheckoutEvent,
} from './helpers/seed';
import { createDb } from '../packages/db/src/client';

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;

const adminPrimaryRoutes = [
  { path: '/dashboard', heading: 'Overview', name: 'dashboard' },
  { path: '/events', heading: 'Events', name: 'events' },
  { path: '/orders', heading: 'Orders', name: 'orders' },
  { path: '/attendees', heading: 'Attendees', name: 'attendees' },
  { path: '/check-in', heading: 'Choose an event', name: 'check-in' },
  { path: '/messages', heading: 'Messages', name: 'messages' },
  { path: '/reports', heading: 'Reports', name: 'reports' },
  { path: '/developer', heading: 'Developer', name: 'developer' },
  { path: '/developer/api-keys', heading: 'API Keys', name: 'api-keys' },
  { path: '/developer/webhooks', heading: 'Webhooks', name: 'webhooks' },
] as const;

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectAdminPrimaryRouteMatrix(page: Page, testInfo: TestInfo): Promise<void> {
  await page.setViewportSize(desktopViewport);
  for (const route of adminPrimaryRoutes) {
    await page.goto(`${adminBaseUrl}${route.path}`);
    await expect(page.getByRole('heading', { name: route.heading }).first()).toBeVisible();
    await attachScreenshot(page, testInfo, `admin-primary-${route.name}-desktop`);
    await expectNoAxeViolations(page, testInfo);
  }

  await page.setViewportSize(mobileViewport);
  for (const route of adminPrimaryRoutes) {
    await page.goto(`${adminBaseUrl}${route.path}`);
    await expect(page.getByRole('heading', { name: route.heading }).first()).toBeVisible();
    await attachScreenshot(page, testInfo, `admin-primary-${route.name}-mobile`);
    await expectNoAxeViolations(page, testInfo);
  }
}

async function expectJsonStatus<T extends { status?: string; id?: string }>(
  response: PlaywrightResponse | Awaited<ReturnType<Page['request']['post']>>,
  expectedStatus: number,
): Promise<T> {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body as T;
}

function isApiResponse(response: PlaywrightResponse, method: string, pathname: string): boolean {
  return response.request().method() === method && new URL(response.url()).pathname === pathname;
}

type BootstrapScope = {
  organizationId: string;
  brandId: string;
};

function collectionItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: unknown[] }).items.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
    );
  }
  return [];
}

async function bootstrapAdminScope(page: Page): Promise<BootstrapScope> {
  const [organizationsResponse, brandsResponse] = await Promise.all([
    page.request.get(`${apiBaseUrl}/v1/organizations`, {
      failOnStatusCode: false,
    }),
    page.request.get(`${apiBaseUrl}/v1/brands`, { failOnStatusCode: false }),
  ]);
  const organizationsBody = await organizationsResponse
    .json()
    .catch(async () => ({ raw: await organizationsResponse.text() }));
  const brandsBody = await brandsResponse
    .json()
    .catch(async () => ({ raw: await brandsResponse.text() }));

  expect(organizationsResponse.status(), JSON.stringify(organizationsBody, null, 2)).toBe(200);
  expect(brandsResponse.status(), JSON.stringify(brandsBody, null, 2)).toBe(200);

  const organizations = collectionItems(organizationsBody);
  const brands = collectionItems(brandsBody);
  const selectedBrand = brands.find(
    (brand) =>
      typeof brand.id === 'string' &&
      typeof brand.organizationId === 'string' &&
      organizations.some((organization) => organization.id === brand.organizationId),
  );

  expect(selectedBrand, JSON.stringify({ organizations, brands }, null, 2)).toBeTruthy();

  return {
    organizationId: String(selectedBrand?.organizationId),
    brandId: String(selectedBrand?.id),
  };
}

async function setAdminScope(page: Page, scope: BootstrapScope): Promise<void> {
  await page.addInitScript(({ organizationId, brandId }) => {
    window.localStorage.setItem('tixkit:selected-organization-id', organizationId);
    window.localStorage.setItem('tixkit:selected-brand-id', brandId);
  }, scope);
}

async function completeSeededFreeCheckout(
  page: Page,
  eventId: string,
  eventTitle: string,
  ticketName: string,
  productName: string,
  buyerEmail: string,
): Promise<void> {
  await page.goto(`${checkoutBaseUrl}/checkout?eventId=${eventId}`);

  await expect(page.getByRole('heading', { name: eventTitle })).toBeVisible();
  await page.getByRole('button', { name: `Increase ${ticketName} quantity` }).click();
  await page.getByRole('button', { name: `Increase ${productName} quantity` }).click();
  await page.getByLabel('Email').fill(buyerEmail);
  await page.getByLabel('First name').fill('Browser');
  await page.getByLabel('Last name').fill('Buyer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Place free order' })).toBeVisible();
  await page.getByRole('button', { name: 'Place free order' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
}

async function updateEventStatus(
  page: Page,
  eventId: string,
  action: 'publish' | 'pause' | 'archive',
  expectedStatus: 'published' | 'paused' | 'archived',
): Promise<void> {
  const response = await page.request.post(`${apiBaseUrl}/v1/events/${eventId}/${action}`, {
    data: {},
    failOnStatusCode: false,
  });
  const body = await expectJsonStatus<{ status: string }>(response, 200);
  expect(body.status).toBe(expectedStatus);
}

async function expectEventDetail(page: Page, eventId: string) {
  const response = await page.request.get(`${apiBaseUrl}/v1/events/${eventId}`, {
    failOnStatusCode: false,
  });
  return expectJsonStatus<{
    id: string;
    title: string;
    description?: string | null;
    status: string;
    visibility?: string;
    capacity?: number | null;
    coverImageUrl?: string | null;
    externalUrl?: string | null;
    venue?: {
      name?: string | null;
      address?: string | null;
      city?: string | null;
      region?: string | null;
      postalCode?: string | null;
      country?: string | null;
    } | null;
    seo?: {
      title?: string | null;
      description?: string | null;
      imageUrl?: string | null;
    } | null;
  }>(response, 200);
}

async function firstOrderIdForEvent(page: Page, eventId: string): Promise<string> {
  const response = await page.request.get(`${apiBaseUrl}/v1/orders?eventId=${eventId}`, {
    failOnStatusCode: false,
  });
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(200);
  expect(body.items?.length, JSON.stringify(body, null, 2)).toBeGreaterThan(0);
  return String(body.items[0].id);
}

async function setInventoryPoolCapacity(poolId: string, totalCapacity: number): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://tixkit:tixkit@localhost:5432/tixkit');
  try {
    await db
      .updateTable('inventory_pools')
      .set({ total_capacity: totalCapacity, updated_at: new Date() })
      .where('id', '=', poolId)
      .execute();
  } finally {
    await db.destroy();
  }
}

test.describe('admin product workflow coverage', () => {
  test('admin can create an event and validate publish, pause, and archive status gates', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await setAdminScope(page, await bootstrapAdminScope(page));

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const title = `E2E Admin Lifecycle ${suffix}`;

    await page.goto(`${adminBaseUrl}/events`);
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await page.getByRole('link', { name: 'Create event' }).first().click();

    const createEventForm = page.getByRole('main');
    await expect(page.getByRole('heading', { name: 'Create an event' })).toBeVisible();
    await createEventForm.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await createEventForm.getByLabel('Start', { exact: true }).fill('2026-08-21T19:00');
    await createEventForm.getByLabel('End (optional)', { exact: true }).fill('2026-08-21T22:00');
    await createEventForm.getByLabel('Venue name (optional)', { exact: true }).fill('Browser Hall');
    const submitCreateEvent = createEventForm.getByRole('button', {
      name: 'Create draft',
    });
    await expect(submitCreateEvent).toBeEnabled();

    const createResponsePromise = page.waitForResponse((response) =>
      isApiResponse(response, 'POST', '/v1/events'),
    );
    await submitCreateEvent.click();
    const createdEvent = await expectJsonStatus<{ id: string; status: string }>(
      await createResponsePromise,
      201,
    );
    expect(createdEvent.status).toBe('draft');

    await page.goto(`${adminBaseUrl}/events/${createdEvent.id}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();

    const updatedTitle = `${title} Edited`;
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Event settings' })).toBeVisible();
    const basicsForm = page.locator('#basics-form');
    await basicsForm.getByRole('textbox', { name: 'Title', exact: true }).fill(updatedTitle);
    await basicsForm
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Updated browser edit description.');
    await basicsForm.getByRole('combobox', { name: 'Visibility' }).click();
    await page.getByRole('option', { name: 'Unlisted' }).click();
    const basicsResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${createdEvent.id}` &&
        response.request().method() === 'PATCH'
      );
    });
    await basicsForm.getByRole('button', { name: 'Save Changes' }).click();
    await expectJsonStatus(await basicsResponsePromise, 200);

    const scheduleForm = page.locator('#schedule-form');
    await scheduleForm.getByLabel('Venue Name', { exact: true }).fill('Edited Browser Hall');
    await scheduleForm.getByLabel('Address', { exact: true }).fill('500 Browser Ave');
    await scheduleForm.getByLabel('City', { exact: true }).fill('Austin');
    await scheduleForm.getByLabel('Region', { exact: true }).fill('TX');
    await scheduleForm.getByLabel('Postal Code', { exact: true }).fill('78701');
    await expect(scheduleForm.getByLabel('Postal Code', { exact: true })).toHaveValue('78701');
    await scheduleForm.getByRole('combobox', { name: 'Country' }).click();
    await page.getByRole('option', { name: 'United States' }).click();
    const scheduleResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${createdEvent.id}` &&
        response.request().method() === 'PATCH'
      );
    });
    await scheduleForm.getByRole('button', { name: 'Save Changes' }).click();
    await expectJsonStatus(await scheduleResponsePromise, 200);

    const salesForm = page.locator('#sales-form');
    await salesForm.getByLabel('Capacity', { exact: true }).fill('250');
    const salesResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${createdEvent.id}` &&
        response.request().method() === 'PATCH'
      );
    });
    await salesForm.getByRole('button', { name: 'Save Changes' }).click();
    await expectJsonStatus(await salesResponsePromise, 200);

    const marketingForm = page.locator('#marketing-form');
    await marketingForm
      .getByLabel('External URL', { exact: true })
      .fill('https://tickets.example.test/e2e-edited');
    await marketingForm.getByLabel('SEO Title', { exact: true }).fill('Edited admin lifecycle SEO');
    await marketingForm
      .getByLabel('SEO Description', { exact: true })
      .fill('Edited SEO description from Playwright.');
    const updateResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${createdEvent.id}` &&
        response.request().method() === 'PATCH'
      );
    });
    await marketingForm.getByRole('button', { name: 'Save Changes' }).click();
    const editedEvent = await expectJsonStatus<{
      id: string;
      title: string;
      description?: string | null;
      visibility?: string;
      capacity?: number | null;
      venue?: {
        name?: string | null;
        address?: string | null;
        city?: string | null;
      };
      seo?: {
        title?: string | null;
        description?: string | null;
        imageUrl?: string | null;
      };
      externalUrl?: string | null;
    }>(await updateResponsePromise, 200);
    expect(editedEvent).toMatchObject({
      id: createdEvent.id,
      title: updatedTitle,
      description: 'Updated browser edit description.',
      visibility: 'unlisted',
      capacity: 250,
      externalUrl: 'https://tickets.example.test/e2e-edited',
    });
    expect(editedEvent.venue).toMatchObject({
      name: 'Edited Browser Hall',
      address: '500 Browser Ave',
      city: 'Austin',
      region: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    expect(editedEvent.seo).toMatchObject({
      title: 'Edited admin lifecycle SEO',
      description: 'Edited SEO description from Playwright.',
    });

    await expect(page.getByRole('heading', { name: 'Event settings' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(
      updatedTitle,
    );

    const persistedEvent = await expectEventDetail(page, createdEvent.id);
    expect(persistedEvent).toMatchObject({
      id: createdEvent.id,
      title: updatedTitle,
      description: 'Updated browser edit description.',
      visibility: 'unlisted',
      capacity: 250,
      externalUrl: 'https://tickets.example.test/e2e-edited',
    });
    expect(persistedEvent.venue).toMatchObject({
      name: 'Edited Browser Hall',
      address: '500 Browser Ave',
      city: 'Austin',
      region: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    expect(persistedEvent.seo).toMatchObject({
      title: 'Edited admin lifecycle SEO',
      description: 'Edited SEO description from Playwright.',
    });

    await page.goto(`${adminBaseUrl}/events/${createdEvent.id}`);
    await expect(page.getByRole('heading', { name: updatedTitle })).toBeVisible();
    await expect(page.getByText('Edited Browser Hall')).toBeVisible();
    await expect(page.getByText('of 250')).toBeVisible();

    const blockedPublishResponse = await page.request.post(
      `${apiBaseUrl}/v1/events/${createdEvent.id}/publish`,
      {
        data: {},
        failOnStatusCode: false,
      },
    );
    const blockedPublish = await expectJsonStatus<{
      status?: string;
      error: {
        code: string;
        details: { requiredBlockers: Array<{ id: string }> };
      };
    }>(blockedPublishResponse, 409);
    expect(blockedPublish.error.code).toBe('launch_readiness_failed');
    expect(blockedPublish.error.details.requiredBlockers.map((blocker) => blocker.id)).toEqual(
      expect.arrayContaining([
        'sellable_tickets',
        'checkout_consent',
        'public_content',
        'confirmation_content',
      ]),
    );

    const lifecycleSeed = await seedFreeCheckoutEvent(request, `lifecycle-${suffix}`);
    await page.goto(`${adminBaseUrl}/events/${lifecycleSeed.event.id}`);
    await expect(page.getByText('Published', { exact: true })).toBeVisible();

    await updateEventStatus(page, lifecycleSeed.event.id, 'pause', 'paused');
    await page.goto(`${adminBaseUrl}/events/${lifecycleSeed.event.id}`);
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();

    await updateEventStatus(page, lifecycleSeed.event.id, 'archive', 'archived');
    await page.goto(`${adminBaseUrl}/events/${lifecycleSeed.event.id}`);
    await expect(page.getByText('Archived', { exact: true })).toBeVisible();

    await attachScreenshot(page, testInfo, 'admin-events-lifecycle-desktop');
    await expectNoAxeViolations(page, testInfo);
  });

  test('seeded checkout order is visible across admin event, product, order, and report surfaces', async ({
    page,
    request,
  }, testInfo) => {
    test.slow();
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);
    const buyerEmail = `admin-workflow+${suffix}@example.com`;

    await completeSeededFreeCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      product.name,
      buyerEmail,
    );
    const orderId = await firstOrderIdForEvent(page, event.id);

    await page.goto(`${adminBaseUrl}/events/${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByText('Quick Links')).toBeVisible();
    await expect(page.getByText('Recent Orders')).toBeVisible();
    await expect(page.getByText(buyerEmail)).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-event-detail-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.setViewportSize(mobileViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-event-detail-mobile');

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/products`);
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
    const productRow = page.getByRole('row').filter({ hasText: product.name });
    await expect(productRow).toBeVisible();
    await expect(productRow.getByText('active', { exact: true })).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-products-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.goto(`${adminBaseUrl}/orders/${orderId}`);
    await expect(page.getByRole('heading', { name: orderId })).toBeVisible();
    await expect(page.getByText(buyerEmail, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByText(product.name, { exact: true })).toBeVisible();
    await expect(page.getByText('Order confirmed and paid')).toBeVisible();
    await expect(page.getByText('Payment Confirmed')).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-order-detail-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.goto(`${adminBaseUrl}/orders`);
    await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Search by buyer/i })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Buyer' })).toBeVisible();

    await page.goto(`${adminBaseUrl}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(page.getByText('Sales, tax, and attendance analytics')).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-reports-desktop');
    await expectNoAxeViolations(page, testInfo);

    await expectAdminPrimaryRouteMatrix(page, testInfo);
  });

  test('event detail Copy link reports clipboard failures and success accurately', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await setAdminScope(page, await bootstrapAdminScope(page));

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedFreeCheckoutEvent(request, `copy-link-${suffix}`);
    await page.goto(`${adminBaseUrl}/events/${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    const publicEventHref = await page
      .getByRole('link', { name: 'Open public page' })
      .getAttribute('href');
    expect(publicEventHref).toBeTruthy();

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      });
    });
    await page.getByRole('button', { name: 'Copy public link' }).click();
    await expect(
      page.getByText('Copy unavailable. Select and copy the public event URL manually.'),
    ).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error('clipboard denied')),
        },
      });
    });
    await page.getByRole('button', { name: 'Copy public link' }).click();
    await expect(
      page.getByText('Unable to copy public event link. Select and copy it manually.'),
    ).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (value: string) => {
            window.sessionStorage.setItem('copied-event-link', value);
            return Promise.resolve();
          },
        },
      });
    });
    await page.getByRole('button', { name: 'Copy public link' }).click();
    await expect(page.getByText('Public event link copied')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.sessionStorage.getItem('copied-event-link')))
      .toBe(publicEventHref);

    await attachScreenshot(page, testInfo, 'admin-event-detail-copy-link');
  });

  test('admin can manage waitlist settings and issue a manual offer', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedTicketVariantCheckoutEvent(request, `waitlist-${suffix}`);
    const buyerEmail = `waitlist-${suffix}@example.com`;
    const laterBuyerEmail = `waitlist-later-${suffix}@example.com`;
    const joinedEntry = await expectJsonStatus<{
      id: string;
      email: string;
      status: string;
      ticketTypeId: string;
    }>(
      await request.post(`${apiBaseUrl}/v1/public/events/${seeded.event.id}/waitlist`, {
        data: {
          ticketTypeId: seeded.tickets.soldOut.id,
          email: buyerEmail,
          firstName: 'Waitlist',
          lastName: 'Buyer',
          quantity: 1,
        },
        failOnStatusCode: false,
      }),
      201,
    );
    expect(joinedEntry).toMatchObject({
      email: buyerEmail,
      status: 'joined',
      ticketTypeId: seeded.tickets.soldOut.id,
    });
    const laterJoinedEntry = await expectJsonStatus<{
      id: string;
      email: string;
      status: string;
      ticketTypeId: string;
    }>(
      await request.post(`${apiBaseUrl}/v1/public/events/${seeded.event.id}/waitlist`, {
        data: {
          ticketTypeId: seeded.tickets.soldOut.id,
          email: laterBuyerEmail,
          firstName: 'Later',
          lastName: 'Buyer',
          quantity: 1,
        },
        failOnStatusCode: false,
      }),
      201,
    );
    expect(laterJoinedEntry).toMatchObject({
      email: laterBuyerEmail,
      status: 'joined',
      ticketTypeId: seeded.tickets.soldOut.id,
    });

    await setInventoryPoolCapacity(seeded.pools.soldOut.id, 2);

    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/tickets`);
    await expect(page.getByRole('heading', { name: 'Ticket Types' })).toBeVisible();
    await page.getByRole('tab', { name: /Waitlist/ }).click();
    await expect(page.getByRole('heading', { name: 'Waitlist' })).toBeVisible();

    const waitlistRow = page.getByRole('row').filter({ hasText: buyerEmail });
    const laterWaitlistRow = page.getByRole('row').filter({ hasText: laterBuyerEmail });
    await expect(waitlistRow).toBeVisible();
    await expect(laterWaitlistRow).toBeVisible();
    await expect(waitlistRow.getByText('Sold Out Admission')).toBeVisible();
    await expect(waitlistRow.getByText('joined')).toBeVisible();
    await expect(laterWaitlistRow.getByText('joined')).toBeVisible();

    const autoOfferSwitch = page.getByRole('switch', { name: 'Auto-offers' });
    await expect(autoOfferSwitch).toBeChecked();
    await autoOfferSwitch.click();
    await page.getByLabel('Claim window').fill('45');

    const settingsResponsePromise = page.waitForResponse((response) =>
      isApiResponse(response, 'PATCH', `/v1/events/${seeded.event.id}/waitlist/settings`),
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const settings = await expectJsonStatus<{
      autoOfferEnabled: boolean;
      offerTtlMinutes: number;
    }>(await settingsResponsePromise, 200);
    expect(settings).toEqual({ autoOfferEnabled: false, offerTtlMinutes: 45 });

    const offerResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() ===
          `${apiBaseUrl}/v1/events/${seeded.event.id}/waitlist/${joinedEntry.id}/offer` &&
        response.request().method() === 'POST'
      );
    });
    await waitlistRow.getByRole('button', { name: 'Offer' }).click();
    const offer = await expectJsonStatus<{
      entry: { id: string; status: string; offerExpiresAt?: string };
      claimToken: string;
    }>(await offerResponsePromise, 200);
    expect(offer.entry).toMatchObject({
      id: joinedEntry.id,
      status: 'offered',
    });
    expect(offer.entry.offerExpiresAt).toBeTruthy();
    expect(offer.claimToken).toHaveLength(32);

    await expect(waitlistRow.getByText('offered')).toBeVisible();

    const persistedWaitlist = await expectJsonStatus<{
      items: Array<{ id: string; status: string; offerExpiresAt?: string }>;
      settings: { autoOfferEnabled: boolean; offerTtlMinutes: number };
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${seeded.event.id}/waitlist`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(persistedWaitlist.settings).toEqual({
      autoOfferEnabled: false,
      offerTtlMinutes: 45,
    });
    expect(persistedWaitlist.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: joinedEntry.id,
          status: 'offered',
          offerExpiresAt: expect.any(String),
        }),
        expect.objectContaining({
          id: laterJoinedEntry.id,
          status: 'joined',
        }),
      ]),
    );

    await attachScreenshot(page, testInfo, 'admin-waitlist-offer-desktop');
    await expectNoAxeViolations(page, testInfo);
  });

  test('admin can manage resale policy and delist resale listings from tickets', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `resale-${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedPaidRefundableOrder(request, suffix);
    const resalePolicy = await expectJsonStatus<{
      enabled: boolean;
      maxMultiplier: number;
      maxAbsoluteCents?: number;
    }>(
      await request.put(`${apiBaseUrl}/v1/events/${seeded.event.id}/resale-policy`, {
        data: {
          enabled: true,
          maxMultiplier: 1.2,
          maxAbsoluteCents: 6000,
        },
        failOnStatusCode: false,
      }),
      200,
    );
    expect(resalePolicy).toEqual({
      enabled: true,
      maxMultiplier: 1.2,
      maxAbsoluteCents: 6000,
    });

    const listing = await expectJsonStatus<{
      id: string;
      ticketId: string;
      status: string;
      priceCents: number;
      faceValueCents: number;
    }>(
      await request.post(`${apiBaseUrl}/v1/tickets/${seeded.ticketIds[0]}/resale-listings`, {
        data: {
          priceCents: 5500,
          termsAcceptance: currentResaleTermsAcceptance,
        },
        headers: { 'Idempotency-Key': `e2e-resale-list-${suffix}` },
        failOnStatusCode: false,
      }),
      201,
    );
    expect(listing).toMatchObject({
      ticketId: seeded.ticketIds[0],
      status: 'listed',
      priceCents: 5500,
      faceValueCents: 5000,
    });

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/tickets`);
    await expect(page.getByRole('heading', { name: 'Ticket Types' })).toBeVisible();
    await page.getByRole('tab', { name: 'Fees & Resale' }).click();
    const resalePanel = page.getByTestId('resale-policy-panel');
    await expect(resalePanel.getByRole('heading', { name: 'Resale' })).toBeVisible();
    await expect(resalePanel.getByRole('switch', { name: 'Resale policy' })).toBeChecked();
    await expect(resalePanel.getByLabel('Max markup')).toHaveValue('1.2');
    await expect(resalePanel.getByLabel('Absolute cap ($)')).toHaveValue('60');

    const listingRow = resalePanel.getByRole('row').filter({ hasText: seeded.ticketIds[0] });
    await expect(listingRow).toBeVisible();
    await expect(listingRow.getByText('$55.00')).toBeVisible();
    await expect(listingRow.getByText('$50.00')).toBeVisible();
    await expect(listingRow.getByText('listed')).toBeVisible();

    await resalePanel.getByRole('switch', { name: 'Resale policy' }).click();
    await resalePanel.getByLabel('Max markup').fill('1.1');
    await resalePanel.getByLabel('Absolute cap ($)').fill('55');
    const policyResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${seeded.event.id}/resale-policy` &&
        response.request().method() === 'PUT'
      );
    });
    await resalePanel.getByRole('button', { name: 'Save resale policy' }).click();
    const updatedPolicy = await expectJsonStatus<{
      enabled: boolean;
      maxMultiplier: number;
      maxAbsoluteCents?: number;
    }>(await policyResponsePromise, 200);
    expect(updatedPolicy).toEqual({
      enabled: false,
      maxMultiplier: 1.1,
      maxAbsoluteCents: 5500,
    });

    const persistedPolicy = await expectJsonStatus<{
      enabled: boolean;
      maxMultiplier: number;
      maxAbsoluteCents?: number;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${seeded.event.id}/resale-policy`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(persistedPolicy).toEqual(updatedPolicy);

    const delistResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/ticket-listings/${listing.id}/delist` &&
        response.request().method() === 'POST'
      );
    });
    await listingRow.getByRole('button', { name: 'Delist' }).click();
    const delisted = await expectJsonStatus<{ id: string; status: string }>(
      await delistResponsePromise,
      200,
    );
    expect(delisted).toMatchObject({ id: listing.id, status: 'delisted' });

    const persistedListings = await expectJsonStatus<{
      items: Array<{ id: string; status: string; ticketId: string }>;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${seeded.event.id}/resale-listings`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(persistedListings.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: listing.id,
          ticketId: seeded.ticketIds[0],
          status: 'delisted',
        }),
      ]),
    );

    await attachScreenshot(page, testInfo, 'admin-resale-policy-listings-desktop');
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const evaluation = await client.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const panel = document.querySelector('[data-testid="resale-policy-panel"]');
          const heading = Array.from(panel?.querySelectorAll('h2') ?? [])
            .find((node) => node.textContent?.trim() === 'Resale') ?? null;
          const policySwitch = panel?.querySelector('[role="switch"]') ?? null;
          const multiplier = panel?.querySelector('#resale-max-multiplier') ?? null;
          const absoluteCap = panel?.querySelector('#resale-absolute-cap') ?? null;
          const delistButton = Array.from(panel?.querySelectorAll('button') ?? [])
            .find((node) => node.textContent?.includes('Delist')) ?? null;
          const metric = (node) => {
            const rect = node?.getBoundingClientRect();
            return rect ? {
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              visible: rect.width > 0 && rect.height > 0,
            } : null;
          };
          return {
            panel: metric(panel),
            heading: metric(heading),
            policySwitch: metric(policySwitch),
            multiplier: metric(multiplier),
            absoluteCap: metric(absoluteCap),
            delistButton: metric(delistButton),
          };
        })()`,
      });
      const metrics = evaluation.result.value as Record<
        string,
        {
          width: number;
          height: number;
          top: number;
          left: number;
          visible: boolean;
        } | null
      >;

      for (const key of [
        'panel',
        'heading',
        'policySwitch',
        'multiplier',
        'absoluteCap',
        'delistButton',
      ] as const) {
        expect(metrics[key], key).toMatchObject({
          width: expect.any(Number),
          height: expect.any(Number),
          visible: true,
        });
      }
      expect(metrics.panel?.width).toBeGreaterThan(320);
      expect(metrics.panel?.height).toBeGreaterThan(220);
      expect(metrics.policySwitch?.height).toBeGreaterThan(16);
      expect(metrics.multiplier?.height).toBeGreaterThan(28);
      expect(metrics.absoluteCap?.height).toBeGreaterThan(28);
      expect(metrics.delistButton?.width).toBeGreaterThan(48);
    }
  });

  test('admin can configure multi-session event occurrences from the tickets workspace', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedFreeCheckoutEvent(request, suffix);
    const occurrenceTitle = `Friday session ${suffix}`;

    await page.goto(`${adminBaseUrl}/events/${event.id}/schedule`);
    await expect(page.getByRole('heading', { name: 'Occurrences' })).toBeVisible();

    await page.getByLabel('Title').fill(occurrenceTitle);
    await page.getByLabel('Starts').fill('2026-08-21T19:00');
    await page.getByLabel('Ends').fill('2026-08-21T22:00');
    await page.getByLabel('Timezone').fill('America/New_York');

    const createResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${event.id}/occurrences` &&
        response.request().method() === 'POST'
      );
    });
    await page.getByRole('button', { name: 'Add' }).click();
    const occurrence = await expectJsonStatus<{
      id: string;
      title: string;
      timezone: string;
    }>(await createResponsePromise, 201);
    expect(occurrence).toMatchObject({
      title: occurrenceTitle,
      timezone: 'America/New_York',
    });

    const occurrenceRow = page.getByRole('row').filter({ hasText: occurrenceTitle });
    await expect(occurrenceRow).toBeVisible();
    await expect(occurrenceRow.getByText('scheduled', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Occurrences' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: occurrenceTitle })).toBeVisible();

    const listResponse = await page.request.get(`${apiBaseUrl}/v1/events/${event.id}/occurrences`, {
      failOnStatusCode: false,
    });
    const listBody = await expectJsonStatus<{
      items: Array<{ id: string; title: string }>;
    }>(listResponse, 200);
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: occurrence.id, title: occurrenceTitle }),
      ]),
    );

    await attachScreenshot(page, testInfo, 'admin-event-occurrences-desktop');
    await expectNoAxeViolations(page, testInfo);
  });

  test('admin can create a locked ticket type with access-code rules', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedFreeCheckoutEvent(request, suffix);
    const ticketName = `Invite Only ${suffix}`;
    const accessCode = `VIP-${suffix}`;

    await page.goto(`${adminBaseUrl}/events/${event.id}/tickets`);
    await expect(page.getByRole('heading', { name: 'Ticket Types' })).toBeVisible();
    await page.getByRole('button', { name: 'Create ticket type' }).click();
    await expect(page.getByRole('heading', { name: 'Create Ticket Type' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(ticketName);
    await page.getByLabel('Price', { exact: true }).fill('0');
    await page.getByLabel('Quantity (optional)').fill('12');
    await page.getByLabel('Pool Name').fill(`${ticketName} Pool`);
    await page.getByLabel('Pool Capacity').fill('12');
    await page.getByRole('combobox', { name: 'Visibility' }).click();
    await page.getByRole('option', { name: 'Locked' }).click();
    await expect(page.getByLabel('Requires Access Code')).toBeChecked();
    await page.getByLabel('Access Codes').fill(`${accessCode}\nVIP-DUPLICATE-${suffix}`);

    const createResponsePromise = page.waitForResponse((response) => {
      return (
        response.url() === `${apiBaseUrl}/v1/events/${event.id}/ticket-types/batch` &&
        response.request().method() === 'POST'
      );
    });
    await page.getByRole('button', { name: 'Create Ticket Type' }).click();
    const created = await expectJsonStatus<{
      ticketType: {
        id: string;
        name: string;
        visibility: string;
        requiresAccessCode: boolean;
      };
      accessRules: Array<{ type: string; value: string; usesCount: number }>;
    }>(await createResponsePromise, 201);
    expect(created.ticketType).toMatchObject({
      name: ticketName,
      visibility: 'locked',
      requiresAccessCode: true,
    });
    expect(created.accessRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'code',
          value: accessCode,
          usesCount: 0,
        }),
      ]),
    );

    const accessRulesResponse = await page.request.get(
      `${apiBaseUrl}/v1/ticket-types/${created.ticketType.id}/access-rules`,
      { failOnStatusCode: false },
    );
    const accessRules = await expectJsonStatus<{
      items: Array<{
        ticketTypeId: string;
        type: string;
        value: string;
        usesCount: number;
      }>;
    }>(accessRulesResponse, 200);
    expect(accessRules.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketTypeId: created.ticketType.id,
          type: 'code',
          value: '[redacted]',
          usesCount: 0,
        }),
      ]),
    );

    const ticketRow = page.getByRole('row').filter({ hasText: ticketName });
    await expect(ticketRow).toBeVisible();
    await expect(ticketRow.getByText('Required', { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Ticket Types' })).toBeVisible();
    const persistedTicketRow = page.getByRole('row').filter({ hasText: ticketName });
    await expect(persistedTicketRow).toBeVisible();
    await expect(persistedTicketRow.getByText('Required', { exact: true })).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-locked-ticket-access-code-desktop');
    await expectNoAxeViolations(page, testInfo);
  });
});
