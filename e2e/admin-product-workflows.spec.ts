import { type Page, type Response as PlaywrightResponse, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import { seedFreeCheckoutEvent } from './helpers/seed';

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;

const adminPrimaryRoutes = [
  { path: '/dashboard', heading: 'Overview', name: 'dashboard' },
  { path: '/events', heading: 'Events', name: 'events' },
  { path: '/orders', heading: 'Orders', name: 'orders' },
  { path: '/attendees', heading: 'Attendees', name: 'attendees' },
  { path: '/check-in', heading: 'Check-in', name: 'check-in' },
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

test.describe('admin product workflow coverage', () => {
  test('admin can create an event and validate publish, pause, and archive status gates', async ({ page }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const title = `E2E Admin Lifecycle ${suffix}`;

    await page.goto(`${adminBaseUrl}/events`);
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
    await page.getByRole('button', { name: 'Create event' }).click();

    await expect(page.getByRole('heading', { name: 'Create Event' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await page.getByLabel('Slug').fill(`e2e-admin-lifecycle-${suffix}`);
    await page.getByLabel('Start Date').fill('2026-08-20T19:00');
    await page.getByLabel('End Date').fill('2026-08-20T22:00');
    await page.getByLabel('Venue Name').fill('Browser Hall');

    const createResponsePromise = page.waitForResponse((response) => {
      return response.url() === `${apiBaseUrl}/v1/events` && response.request().method() === 'POST';
    });
    await page.getByRole('button', { name: 'Create Event' }).click();
    const createdEvent = await expectJsonStatus<{ id: string; status: string }>(
      await createResponsePromise,
      201,
    );
    expect(createdEvent.status).toBe('draft');

    await page.goto(`${adminBaseUrl}/events/${createdEvent.id}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();

    const updatedTitle = `${title} Edited`;
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Event' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(updatedTitle);
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Updated browser edit description.');
    await page.getByRole('combobox', { name: 'Visibility' }).click();
    await page.getByRole('option', { name: 'Unlisted' }).click();
    await page.getByLabel('Capacity', { exact: true }).fill('250');
    await page.getByLabel('Venue Name', { exact: true }).fill('Edited Browser Hall');
    await page.getByLabel('Address', { exact: true }).fill('500 Browser Ave');
    await page.getByLabel('City', { exact: true }).fill('Austin');
    await page.getByLabel('Region', { exact: true }).fill('TX');
    await page.getByLabel('Postal Code', { exact: true }).fill('78701');
    await expect(page.getByLabel('Postal Code', { exact: true })).toHaveValue('78701');
    await page.getByLabel('Country', { exact: true }).fill('US');
    await page.getByLabel('Cover Image URL', { exact: true }).fill('https://cdn.example.test/e2e-cover.jpg');
    await page.getByLabel('External URL', { exact: true }).fill('https://tickets.example.test/e2e-edited');
    await page.getByLabel('SEO Title', { exact: true }).fill('Edited admin lifecycle SEO');
    await page.getByLabel('SEO Description', { exact: true }).fill('Edited SEO description from Playwright.');
    await page.getByLabel('SEO Image URL', { exact: true }).fill('https://cdn.example.test/e2e-seo.jpg');

    const updateResponsePromise = page.waitForResponse((response) => {
      return response.url() === `${apiBaseUrl}/v1/events/${createdEvent.id}` && response.request().method() === 'PATCH';
    });
    await page.getByRole('button', { name: 'Save Changes' }).click();
    const editedEvent = await expectJsonStatus<{
      id: string;
      title: string;
      description?: string | null;
      visibility?: string;
      capacity?: number | null;
      venue?: { name?: string | null; address?: string | null; city?: string | null };
      seo?: { title?: string | null; description?: string | null; imageUrl?: string | null };
      coverImageUrl?: string | null;
      externalUrl?: string | null;
    }>(await updateResponsePromise, 200);
    expect(editedEvent).toMatchObject({
      id: createdEvent.id,
      title: updatedTitle,
      description: 'Updated browser edit description.',
      visibility: 'unlisted',
      capacity: 250,
      coverImageUrl: 'https://cdn.example.test/e2e-cover.jpg',
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
      imageUrl: 'https://cdn.example.test/e2e-seo.jpg',
    });

    await expect(page.getByRole('heading', { name: updatedTitle })).toBeVisible();
    await expect(page.getByText('Edited Browser Hall')).toBeVisible();
    await expect(page.getByText('of 250')).toBeVisible();

    const persistedEvent = await expectEventDetail(page, createdEvent.id);
    expect(persistedEvent).toMatchObject({
      id: createdEvent.id,
      title: updatedTitle,
      description: 'Updated browser edit description.',
      visibility: 'unlisted',
      capacity: 250,
      coverImageUrl: 'https://cdn.example.test/e2e-cover.jpg',
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
      imageUrl: 'https://cdn.example.test/e2e-seo.jpg',
    });

    await updateEventStatus(page, createdEvent.id, 'publish', 'published');
    await page.goto(`${adminBaseUrl}/events/${createdEvent.id}`);
    await expect(page.getByText('Published', { exact: true })).toBeVisible();

    await updateEventStatus(page, createdEvent.id, 'pause', 'paused');
    await page.goto(`${adminBaseUrl}/events/${createdEvent.id}`);
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();

    await updateEventStatus(page, createdEvent.id, 'archive', 'archived');
    await page.goto(`${adminBaseUrl}/events/${createdEvent.id}`);
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
    await expect(page.getByRole('textbox', { name: 'Search orders...' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Buyer' })).toBeVisible();

    await page.goto(`${adminBaseUrl}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(page.getByText('Sales, tax, and attendance analytics')).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-reports-desktop');
    await expectNoAxeViolations(page, testInfo);

    await expectAdminPrimaryRouteMatrix(page, testInfo);
  });
});
