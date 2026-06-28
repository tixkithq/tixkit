import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { createDb, type Database } from '../../packages/db/src/client';
import { apiBaseUrl } from './env';

const devTenantId = 'tnt_dev_local';
export const devOrganizationId = 'org_dev_local';
export const devBrandId = 'brd_dev_local';

export type SeededCheckoutEvent = {
  event: { id: string; title: string };
  ticketType: { id: string; name: string };
  product: { id: string; name: string };
};

export type SeededPaidCheckoutEvent = {
  event: { id: string; title: string };
  ticketType: { id: string; name: string };
  inventoryPool: { id: string };
};

export type SeededPaidPromoCheckoutEvent = SeededPaidCheckoutEvent & {
  discountCode: { id: string; code: string; discountCents: number };
};

export type SeededTicketVariantCheckoutEvent = {
  event: { id: string; title: string };
  accessCode: string;
  tickets: {
    public: { id: string; name: string };
    hidden: { id: string; name: string };
    locked: { id: string; name: string };
    donation: { id: string; name: string; minimumPriceCents: number };
    minimumPair: { id: string; name: string };
    soldOut: { id: string; name: string };
    sharedA: { id: string; name: string };
    sharedB: { id: string; name: string };
  };
  pools: {
    hidden: { id: string };
    locked: { id: string };
    donation: { id: string };
    soldOut: { id: string };
    shared: { id: string };
  };
};

export type SeededMessagingPrerequisites = {
  templateKey: string;
};

export type SeededPaidRefundableOrder = {
  event: { id: string; title: string };
  ticketType: { id: string; name: string };
  inventoryPool: { id: string };
  order: { id: string; buyerEmail: string; totalCents: number };
  ticketIds: string[];
};

export type RefundWorkflowState = {
  order: { status: string; refundedCents: number };
  refunds: Array<{ id: string; amountCents: number; status: string; providerRefundId: string }>;
  tickets: Array<{ id: string; status: string }>;
  inventoryPool: { soldCount: number };
  timelineTypes: string[];
  emailJobs: Array<{ id: string; status: string }>;
};

export type PaidCheckoutCaptureState = {
  session: { status: string; orderId: string | null; paymentIntentId: string | null };
  order: {
    id: string;
    status: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    paymentProvider: string | null;
    paymentIntentId: string | null;
  };
  paymentIntent: {
    provider: string;
    providerIntentId: string;
    status: string;
    orderId: string | null;
  };
  hold: { status: string; quantity: number };
  inventoryPool: { soldCount: number };
  ticketCount: number;
  ticketIds: string[];
  ticketEmailJob: {
    templateKey: string;
    attachments: Array<{
      filename: string;
      contentType: string;
      content: string;
      contentEncoding?: 'base64';
    }>;
  } | null;
};

export type WalletPassState = {
  ticketId: string;
  ticketCode: string;
  provider: string;
  status: string;
  passUrl: string;
  accessTokenHash: string | null;
  contentType: string | null;
  artifactBase64: string | null;
};

export type PromoCheckoutCaptureState = PaidCheckoutCaptureState & {
  discountCode: { id: string; code: string; usesCount: number };
  redemption: {
    discountCodeId: string;
    eventId: string;
    checkoutSessionId: string;
    orderId: string | null;
    tenantId: string | null;
  };
};

export type SeededAffiliateAttribution = {
  affiliate: { id: string; code: string; name: string; commissionCents: number };
  attribution: { id: string; orderId: string };
};

export type SeededTaxSnapshot = {
  taxRule: { id: string; name: string; rate: number };
  taxableAmountCents: number;
  taxCollectedCents: number;
};

export type CheckoutOrderState = {
  session: { status: string; orderId: string | null };
  order: { id: string; status: string; totalCents: number };
  holds: Array<{ ticketTypeId: string; status: string; quantity: number }>;
  inventoryPool: { soldCount: number };
  ticketCount: number;
};

export type CheckInWorkflowTicket = {
  id: string;
  ticketTypeId: string;
  qrPayload: string;
  qrHash: string;
  status: string;
};

export type SeededCheckInList = {
  id: string;
  name: string;
  tickets: CheckInWorkflowTicket[];
};

export type CheckInWorkflowState = {
  tickets: Array<{ id: string; status: string; checkedInByDeviceId: string | null }>;
  scanLogs: Array<{ outcome: string; offline: boolean; ticketId: string | null; qrHash: string }>;
};

async function expectJsonResponse(response: APIResponse, expectedStatus: number) {
  const body = await response.json().catch(async () => ({
    raw: await response.text(),
  }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body;
}

function localDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://tixkit:tixkit@localhost:5432/tixkit';
}

async function withE2eDb<T>(callback: (db: Database) => Promise<T>): Promise<T> {
  const db = createDb(localDatabaseUrl());
  try {
    return await callback(db);
  } finally {
    await db.destroy();
  }
}

function safeIdPart(suffix: string): string {
  return suffix.replaceAll(/[^a-zA-Z0-9_-]/g, '-').slice(0, 18);
}

function compactIdPart(suffix: string, maxLength = 18): string {
  const safe = suffix.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
  if (safe.length <= maxLength) return safe;
  const headLength = Math.max(4, Math.ceil(maxLength / 2));
  const tailLength = Math.max(4, maxLength - headLength - 1);
  return `${safe.slice(0, headLength)}-${safe.slice(-tailLength)}`;
}

export async function seedFreeCheckoutEvent(
  request: APIRequestContext,
  suffix: string,
): Promise<SeededCheckoutEvent> {
  const eventTitle = `E2E Checkout ${suffix}`;
  const event = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-checkout-${suffix}`,
        title: eventTitle,
        description: 'Seeded by Playwright for hosted checkout coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-07-15T23:00:00.000Z',
        endsAt: '2026-07-16T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  )) as { id: string; title: string };

  const pool = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/inventory-pools`, {
      data: {
        name: 'General admission',
        totalCapacity: 25,
        holdTtlSeconds: 600,
      },
    }),
    201,
  )) as { id: string };

  const ticketType = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/ticket-types`, {
      data: {
        name: 'General Admission',
        kind: 'free',
        visibility: 'public',
        currency: 'USD',
        priceCents: 0,
        inventoryPoolId: pool.id,
        minPerOrder: 1,
        maxPerOrder: 4,
      },
    }),
    201,
  )) as { id: string; name: string };

  const product = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/products`, {
      data: {
        name: 'Parking add-on',
        description: 'Seeded product add-on for checkout coverage.',
        priceCents: 0,
        currency: 'USD',
        maxPerOrder: 2,
        status: 'active',
      },
    }),
    201,
  )) as { id: string; name: string };

  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );

  return { event, ticketType, product };
}

export async function seedPaidCheckoutEvent(
  request: APIRequestContext,
  suffix: string,
  options: { brandId?: string } = {},
): Promise<SeededPaidCheckoutEvent> {
  await seedTicketIssueNotificationPrerequisites(suffix);

  const eventTitle = `E2E Paid Checkout ${suffix}`;
  const event = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: options.brandId ?? devBrandId,
        slug: `e2e-paid-checkout-${suffix}`,
        title: eventTitle,
        description: 'Seeded by Playwright for paid checkout capture-mode coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-09-18T23:00:00.000Z',
        endsAt: '2026-09-19T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  )) as { id: string; title: string };

  const inventoryPool = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/inventory-pools`, {
      data: {
        name: 'Paid admission',
        totalCapacity: 20,
        holdTtlSeconds: 600,
      },
    }),
    201,
  )) as { id: string };

  const ticketType = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/ticket-types`, {
      data: {
        name: 'Paid Admission',
        kind: 'paid',
        visibility: 'public',
        currency: 'USD',
        priceCents: 2_500,
        inventoryPoolId: inventoryPool.id,
        minPerOrder: 1,
        maxPerOrder: 4,
      },
    }),
    201,
  )) as { id: string; name: string };

  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );

  return { event, ticketType, inventoryPool };
}

async function seedTicketIssueNotificationPrerequisites(suffix: string): Promise<void> {
  const now = new Date();
  const safeSuffix = safeIdPart(suffix);
  const templateId = `ntf_tix_${safeSuffix}`.slice(0, 32);
  const templateVersionId = `ntv_tix_${safeSuffix}`.slice(0, 32);
  const providerRouteId = `epr_tix_${safeSuffix}`.slice(0, 32);

  await withE2eDb(async (db) => {
    const existingTemplate = await db
      .selectFrom('notification_templates')
      .select(['id'])
      .where('tenant_id', '=', devTenantId)
      .where('brand_id', '=', devBrandId)
      .where('key', '=', 'tickets-issued')
      .executeTakeFirst();

    if (!existingTemplate) {
      await db
        .insertInto('notification_templates')
        .values({
          id: templateId,
          tenant_id: devTenantId,
          brand_id: devBrandId,
          key: 'tickets-issued',
          name: `E2E tickets issued ${safeSuffix}`,
          description: 'Seeded by Playwright for paid checkout ticket delivery coverage.',
          category: 'transactional',
          variables: JSON.stringify(['orderId', 'orderNumber', 'ticketCount', 'attachments']),
          current_version_id: templateVersionId,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await db
        .insertInto('notification_template_versions')
        .values({
          id: templateVersionId,
          template_id: templateId,
          version: 1,
          subject_template: 'Your Tixkit tickets',
          html_template: '<p>Your tickets for {{orderNumber}} are attached.</p>',
          text_template: 'Your tickets for {{orderNumber}} are attached.',
          locale: 'en',
          is_default: true,
          published_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    const existingRoute = await db
      .selectFrom('email_provider_routes')
      .select(['id'])
      .where('tenant_id', '=', devTenantId)
      .where('brand_id', '=', devBrandId)
      .where('provider_type', '=', 'capture')
      .where('status', '=', 'active')
      .where('smoke_send_verified', '=', true)
      .executeTakeFirst();

    if (!existingRoute) {
      await db
        .insertInto('email_provider_routes')
        .values({
          id: providerRouteId,
          tenant_id: devTenantId,
          brand_id: devBrandId,
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_domain: 'example.com',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['transactional']),
          status: 'active',
          smoke_send_verified: true,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  });
}

export async function seedPaidPromoCheckoutEvent(
  request: APIRequestContext,
  suffix: string,
): Promise<SeededPaidPromoCheckoutEvent> {
  const seeded = await seedPaidCheckoutEvent(request, `promo-${suffix}`);
  const safeSuffix = compactIdPart(suffix);
  const discountCode = {
    id: `dc_promo_${safeSuffix}`.slice(0, 32),
    code: 'SAVE20',
    discountCents: 500,
  };
  const now = new Date();

  await withE2eDb(async (db) => {
    await db
      .insertInto('discount_codes')
      .values({
        id: discountCode.id,
        event_id: seeded.event.id,
        code: discountCode.code,
        type: 'percentage',
        value: 2_000,
        currency: 'USD',
        max_uses: 3,
        uses_count: 0,
        valid_from: new Date(now.getTime() - 60_000),
        valid_until: new Date(now.getTime() + 60 * 60_000),
        min_order_cents: 1_000,
        max_discount_cents: null,
        ticket_type_ids: JSON.stringify([seeded.ticketType.id]),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  return { ...seeded, discountCode };
}

export async function seedTicketVariantCheckoutEvent(
  request: APIRequestContext,
  suffix: string,
): Promise<SeededTicketVariantCheckoutEvent> {
  const safeSuffix = compactIdPart(suffix);
  const accessCode = `VIP-${safeSuffix}`;
  const eventTitle = `E2E Ticket Variants ${suffix}`;
  const event = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-ticket-variants-${suffix}`,
        title: eventTitle,
        description:
          'Seeded by Playwright for hidden, locked, donation, and shared-pool checkout coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-10-20T23:00:00.000Z',
        endsAt: '2026-10-21T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  )) as { id: string; title: string };

  async function createPool(name: string, totalCapacity = 10) {
    return (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/events/${event.id}/inventory-pools`, {
        data: {
          name,
          totalCapacity,
          holdTtlSeconds: 600,
        },
      }),
      201,
    )) as { id: string };
  }

  async function createTicket(input: {
    name: string;
    kind?: 'free' | 'paid' | 'donation';
    visibility?: 'public' | 'hidden' | 'locked';
    priceCents?: number;
    minimumPriceCents?: number;
    inventoryPoolId: string;
    requiresAccessCode?: boolean;
    accessCodeHint?: string;
    minPerOrder?: number;
    maxPerOrder?: number;
  }) {
    return (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/events/${event.id}/ticket-types`, {
        data: {
          name: input.name,
          kind: input.kind ?? 'free',
          visibility: input.visibility ?? 'public',
          currency: 'USD',
          priceCents: input.priceCents ?? 0,
          minimumPriceCents: input.minimumPriceCents,
          inventoryPoolId: input.inventoryPoolId,
          minPerOrder: input.minPerOrder ?? 1,
          maxPerOrder: input.maxPerOrder ?? 4,
          requiresAccessCode: input.requiresAccessCode,
          accessCodeHint: input.accessCodeHint,
        },
      }),
      201,
    )) as { id: string; name: string };
  }

  const publicPool = await createPool('Public admission');
  const hiddenPool = await createPool('Hidden admission');
  const lockedPool = await createPool('Locked admission');
  const donationPool = await createPool('Donation admission');
  const minimumPairPool = await createPool('Minimum pair admission');
  const soldOutPool = await createPool('Sold-out admission', 1);
  const sharedPool = await createPool('Shared admission pool');

  const publicTicket = await createTicket({
    name: 'Public Admission',
    inventoryPoolId: publicPool.id,
  });
  const hiddenTicket = await createTicket({
    name: 'Hidden Direct Link',
    visibility: 'hidden',
    inventoryPoolId: hiddenPool.id,
  });
  const lockedTicket = await createTicket({
    name: 'Locked VIP',
    visibility: 'locked',
    inventoryPoolId: lockedPool.id,
    requiresAccessCode: true,
    accessCodeHint: 'Use the invited buyer code',
  });
  const donationTicket = await createTicket({
    name: 'Donation Admission',
    kind: 'donation',
    priceCents: 0,
    minimumPriceCents: 500,
    inventoryPoolId: donationPool.id,
  });
  const minimumPairTicket = await createTicket({
    name: 'Minimum Pair',
    inventoryPoolId: minimumPairPool.id,
    minPerOrder: 2,
    maxPerOrder: 2,
  });
  const soldOutTicket = await createTicket({
    name: 'Sold Out Admission',
    inventoryPoolId: soldOutPool.id,
  });
  const sharedTicketA = await createTicket({
    name: 'Shared Early',
    inventoryPoolId: sharedPool.id,
  });
  const sharedTicketB = await createTicket({
    name: 'Shared Late',
    inventoryPoolId: sharedPool.id,
  });

  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/ticket-types/${lockedTicket.id}/access-rules`, {
      data: {
        type: 'code',
        value: accessCode,
        maxUses: 10,
      },
    }),
    201,
  );

  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );

  const soldOutSession = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
      headers: { 'idempotency-key': `variant-sold-out-session-${event.id}-${soldOutTicket.id}` },
      data: {
        eventId: event.id,
        items: [{ ticketTypeId: soldOutTicket.id, quantity: 1 }],
        buyer: {
          email: `sold-out-${safeSuffix}@example.com`,
          firstName: 'Sold',
          lastName: 'Out',
        },
      },
    }),
    201,
  )) as { id: string; clientToken: string };
  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/checkout/sessions/${soldOutSession.id}/confirm`, {
      headers: {
        'idempotency-key': `variant-sold-out-confirm-${soldOutSession.id}`,
        'x-checkout-session-token': soldOutSession.clientToken,
      },
      data: { paymentMethodId: 'pm_card_visa' },
    }),
    200,
  );

  return {
    event,
    accessCode,
    tickets: {
      public: publicTicket,
      hidden: hiddenTicket,
      locked: lockedTicket,
      donation: { ...donationTicket, minimumPriceCents: 500 },
      minimumPair: minimumPairTicket,
      soldOut: soldOutTicket,
      sharedA: sharedTicketA,
      sharedB: sharedTicketB,
    },
    pools: {
      hidden: hiddenPool,
      locked: lockedPool,
      donation: donationPool,
      soldOut: soldOutPool,
      shared: sharedPool,
    },
  };
}

export async function setInventoryPoolCapacity(
  poolId: string,
  totalCapacity: number,
): Promise<void> {
  await withE2eDb(async (db) => {
    await db
      .updateTable('inventory_pools')
      .set({ total_capacity: totalCapacity, updated_at: new Date() })
      .where('id', '=', poolId)
      .execute();
  });
}

export async function seedRefundNotificationPrerequisites(suffix: string): Promise<void> {
  const now = new Date();
  const safeSuffix = safeIdPart(suffix);
  const templateId = `ntf_ref_${safeSuffix}`.slice(0, 32);
  const templateVersionId = `ntv_ref_${safeSuffix}`.slice(0, 32);
  const providerRouteId = `epr_ref_${safeSuffix}`.slice(0, 32);

  await withE2eDb(async (db) => {
    await db
      .insertInto('notification_templates')
      .values({
        id: templateId,
        tenant_id: devTenantId,
        brand_id: devBrandId,
        key: 'order-refunded',
        name: `E2E order refunded ${safeSuffix}`,
        description: 'Seeded by Playwright for admin refund workflow coverage.',
        category: 'transactional',
        variables: JSON.stringify(['orderId', 'orderNumber', 'refundedCents']),
        current_version_id: templateVersionId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('notification_template_versions')
      .values({
        id: templateVersionId,
        template_id: templateId,
        version: 1,
        subject_template: 'Refund processed',
        html_template: '<p>Refund processed for {{orderNumber}}</p>',
        text_template: 'Refund processed for {{orderNumber}}',
        locale: 'en',
        is_default: true,
        published_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('email_provider_routes')
      .values({
        id: providerRouteId,
        tenant_id: devTenantId,
        brand_id: devBrandId,
        provider_type: 'capture',
        credentials_ref: 'capture',
        sender_domain: 'example.com',
        priority: 0,
        is_fallback: false,
        rate_limit_per_hour: null,
        allowed_categories: JSON.stringify(['transactional']),
        status: 'active',
        smoke_send_verified: true,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  });
}

export async function seedPaidRefundableOrder(
  request: APIRequestContext,
  suffix: string,
): Promise<SeededPaidRefundableOrder> {
  const safeSuffix = safeIdPart(suffix);
  const eventTitle = `E2E Refund ${suffix}`;
  const buyerEmail = `refund-workflow+${suffix}@example.com`;

  const event = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-refund-${suffix}`,
        title: eventTitle,
        description: 'Seeded by Playwright for refund workflow coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-08-20T23:00:00.000Z',
        endsAt: '2026-08-21T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  )) as { id: string; title: string };

  const inventoryPool = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/inventory-pools`, {
      data: {
        name: 'Refundable admission',
        totalCapacity: 10,
        holdTtlSeconds: 600,
      },
    }),
    201,
  )) as { id: string };

  const ticketType = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/ticket-types`, {
      data: {
        name: 'Refundable Admission',
        kind: 'paid',
        visibility: 'public',
        currency: 'USD',
        priceCents: 5_000,
        inventoryPoolId: inventoryPool.id,
        minPerOrder: 1,
        maxPerOrder: 4,
      },
    }),
    201,
  )) as { id: string; name: string };

  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );
  await seedRefundNotificationPrerequisites(suffix);

  const checkoutSessionId = `cks_ref_${safeSuffix}`.slice(0, 32);
  const holdId = `hld_ref_${safeSuffix}`.slice(0, 32);
  const orderId = `ord_ref_${safeSuffix}`.slice(0, 32);
  const lineItemId = `oli_ref_${safeSuffix}`.slice(0, 32);
  const attendeeOneId = `att_r1_${safeSuffix}`.slice(0, 32);
  const attendeeTwoId = `att_r2_${safeSuffix}`.slice(0, 32);
  const ticketOneId = `tkt_r1_${safeSuffix}`.slice(0, 32);
  const ticketTwoId = `tkt_r2_${safeSuffix}`.slice(0, 32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60_000);

  await withE2eDb(async (db) => {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('checkout_sessions')
        .values({
          id: checkoutSessionId,
          tenant_id: devTenantId,
          event_id: event.id,
          brand_id: devBrandId,
          status: 'completed',
          hold_id: holdId,
          currency: 'USD',
          cart: JSON.stringify({
            items: [{ ticketTypeId: ticketType.id, quantity: 2 }],
            buyerFields: {},
            attendeeFields: {},
          }),
          buyer: JSON.stringify({
            email: buyerEmail,
            firstName: 'Refund',
            lastName: 'Buyer',
          }),
          quote: JSON.stringify({
            subtotalCents: 10_000,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
            totalCents: 10_000,
            currency: 'USD',
          }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: expiresAt,
          idempotency_key: `e2e-refund-${safeSuffix}`,
          client_token: `e2e-refund-token-${safeSuffix}`,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await trx
        .insertInto('checkout_holds')
        .values({
          id: holdId,
          inventory_pool_id: inventoryPool.id,
          checkout_session_id: checkoutSessionId,
          ticket_type_id: ticketType.id,
          quantity: 2,
          expires_at: expiresAt,
          status: 'converted',
          created_at: now,
          updated_at: now,
        })
        .execute();

      await trx
        .insertInto('orders')
        .values({
          id: orderId,
          tenant_id: devTenantId,
          organization_id: devOrganizationId,
          brand_id: devBrandId,
          event_id: event.id,
          checkout_session_id: checkoutSessionId,
          order_number: `TK-RF-${safeSuffix}`,
          status: 'paid',
          currency: 'USD',
          subtotal_cents: 10_000,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: 10_000,
          refunded_cents: 0,
          buyer_email: buyerEmail,
          buyer_first_name: 'Refund',
          buyer_last_name: 'Buyer',
          buyer_phone: null,
          payment_intent_id: null,
          payment_provider: 'local',
          paid_at: now,
          refunded_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await trx
        .insertInto('order_line_items')
        .values({
          id: lineItemId,
          order_id: orderId,
          ticket_type_id: ticketType.id,
          product_id: null,
          attendee_id: null,
          description: ticketType.name,
          quantity: 2,
          unit_price_cents: 5_000,
          subtotal_cents: 10_000,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: 10_000,
          currency: 'USD',
          created_at: now,
          updated_at: now,
        })
        .execute();

      await trx
        .insertInto('attendees')
        .values([
          {
            id: attendeeOneId,
            tenant_id: devTenantId,
            order_id: orderId,
            event_id: event.id,
            ticket_type_id: ticketType.id,
            ticket_id: null,
            first_name: 'Refund',
            last_name: 'One',
            email: buyerEmail,
            phone: null,
            status: 'registered',
            custom_answers: null,
            checked_in_at: null,
            check_in_device_id: null,
            created_at: now,
            updated_at: now,
          },
          {
            id: attendeeTwoId,
            tenant_id: devTenantId,
            order_id: orderId,
            event_id: event.id,
            ticket_type_id: ticketType.id,
            ticket_id: null,
            first_name: 'Refund',
            last_name: 'Two',
            email: buyerEmail,
            phone: null,
            status: 'registered',
            custom_answers: null,
            checked_in_at: null,
            check_in_device_id: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();

      await trx
        .insertInto('tickets')
        .values([
          {
            id: ticketOneId,
            tenant_id: devTenantId,
            order_id: orderId,
            attendee_id: attendeeOneId,
            event_id: event.id,
            ticket_type_id: ticketType.id,
            status: 'valid',
            code: `RF-${safeSuffix}-1`,
            qr_payload: `tixkit:ticket:${ticketOneId}`,
            qr_hash: `hash-${ticketOneId}`,
            transferred_to_email: null,
            transferred_at: null,
            checked_in_at: null,
            checked_in_by_device_id: null,
            wallet_pass_id: null,
            created_at: now,
            updated_at: now,
          },
          {
            id: ticketTwoId,
            tenant_id: devTenantId,
            order_id: orderId,
            attendee_id: attendeeTwoId,
            event_id: event.id,
            ticket_type_id: ticketType.id,
            status: 'valid',
            code: `RF-${safeSuffix}-2`,
            qr_payload: `tixkit:ticket:${ticketTwoId}`,
            qr_hash: `hash-${ticketTwoId}`,
            transferred_to_email: null,
            transferred_at: null,
            checked_in_at: null,
            checked_in_by_device_id: null,
            wallet_pass_id: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();

      await trx
        .updateTable('attendees')
        .set({ ticket_id: ticketOneId, updated_at: now })
        .where('id', '=', attendeeOneId)
        .execute();
      await trx
        .updateTable('attendees')
        .set({ ticket_id: ticketTwoId, updated_at: now })
        .where('id', '=', attendeeTwoId)
        .execute();
      await trx
        .updateTable('inventory_pools')
        .set({ sold_count: 2, updated_at: now })
        .where('id', '=', inventoryPool.id)
        .execute();
    });
  });

  return {
    event,
    ticketType,
    inventoryPool,
    order: { id: orderId, buyerEmail, totalCents: 10_000 },
    ticketIds: [ticketOneId, ticketTwoId],
  };
}

export async function seedMessagingPrerequisites(
  suffix: string,
): Promise<SeededMessagingPrerequisites> {
  const now = new Date();
  const safeSuffix = safeIdPart(suffix);
  const templateId = `ntf_e2e_${safeSuffix}`.slice(0, 32);
  const templateVersionId = `ntv_e2e_${safeSuffix}`.slice(0, 32);
  const providerRouteId = `epr_e2e_${safeSuffix}`.slice(0, 32);
  const templateKey = `e2e-campaign-${safeSuffix}`.slice(0, 100);

  await withE2eDb(async (db) => {
    const existingTemplate = await db
      .selectFrom('notification_templates')
      .select('id')
      .where('id', '=', templateId)
      .executeTakeFirst();

    if (!existingTemplate) {
      await db
        .insertInto('notification_templates')
        .values({
          id: templateId,
          tenant_id: devTenantId,
          brand_id: devBrandId,
          key: templateKey,
          name: `E2E campaign ${safeSuffix}`,
          description: 'Seeded by Playwright for admin messaging coverage.',
          category: 'bulk',
          variables: JSON.stringify(['body']),
          current_version_id: templateVersionId,
          created_at: now,
          updated_at: now,
        })
        .execute();

      await db
        .insertInto('notification_template_versions')
        .values({
          id: templateVersionId,
          template_id: templateId,
          version: 1,
          subject_template: 'Tixkit update',
          html_template: '<p>{{body}}</p>',
          text_template: '{{body}}',
          locale: 'en',
          is_default: true,
          published_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    const existingRoute = await db
      .selectFrom('email_provider_routes')
      .select('id')
      .where('id', '=', providerRouteId)
      .executeTakeFirst();

    if (!existingRoute) {
      await db
        .insertInto('email_provider_routes')
        .values({
          id: providerRouteId,
          tenant_id: devTenantId,
          brand_id: devBrandId,
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_domain: 'example.com',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  });

  return { templateKey };
}

export async function seedMessageConsentForEmail(
  eventId: string,
  email: string,
  suffix: string,
): Promise<void> {
  const safeSuffix = safeIdPart(suffix);
  const consentId = `msc_e2e_${safeSuffix}`.slice(0, 32);
  const now = new Date();

  await withE2eDb(async (db) => {
    const attendee = await db
      .selectFrom('attendees')
      .select(['id', 'phone'])
      .where('event_id', '=', eventId)
      .where('email', '=', email)
      .executeTakeFirst();

    expect(attendee, `Expected checkout attendee for ${email}`).toBeTruthy();
    if (!attendee) return;

    const existingConsent = await db
      .selectFrom('message_consents')
      .select('id')
      .where('id', '=', consentId)
      .executeTakeFirst();

    if (existingConsent) return;

    await db
      .insertInto('message_consents')
      .values({
        id: consentId,
        tenant_id: devTenantId,
        attendee_id: attendee.id,
        email,
        phone: attendee.phone,
        email_opt_in: true,
        sms_opt_in: false,
        consent_text: 'E2E messaging consent',
        consent_version: 'e2e-v1',
        consented_at: now,
        revoked_at: null,
        created_at: now,
      })
      .execute();
  });
}

export async function readRefundWorkflowState(
  orderId: string,
  inventoryPoolId: string,
  ticketIds: string[],
): Promise<RefundWorkflowState> {
  return withE2eDb(async (db) => {
    const [order, refunds, tickets, inventoryPool, timeline, emailJobs] = await Promise.all([
      db
        .selectFrom('orders')
        .select(['status', 'refunded_cents'])
        .where('id', '=', orderId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('refunds')
        .select(['id', 'amount_cents', 'status', 'provider_refund_id'])
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'asc')
        .execute(),
      db
        .selectFrom('tickets')
        .select(['id', 'status'])
        .where('id', 'in', ticketIds)
        .orderBy('id', 'asc')
        .execute(),
      db
        .selectFrom('inventory_pools')
        .select(['sold_count'])
        .where('id', '=', inventoryPoolId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('order_timeline_events')
        .select(['type'])
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'asc')
        .execute(),
      db
        .selectFrom('email_jobs')
        .select(['id', 'status'])
        .where('tenant_id', '=', devTenantId)
        .where('idempotency_key', 'like', `order-refunded:${orderId}:%`)
        .orderBy('created_at', 'asc')
        .execute(),
    ]);

    return {
      order: {
        status: order.status,
        refundedCents: Number(order.refunded_cents),
      },
      refunds: refunds.map((refund) => ({
        id: refund.id,
        amountCents: Number(refund.amount_cents),
        status: refund.status,
        providerRefundId: refund.provider_refund_id,
      })),
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        status: ticket.status,
      })),
      inventoryPool: {
        soldCount: Number(inventoryPool.sold_count),
      },
      timelineTypes: timeline.map((event) => event.type),
      emailJobs: emailJobs.map((job) => ({
        id: job.id,
        status: job.status,
      })),
    };
  });
}

export async function readPaidCheckoutCaptureState(
  sessionId: string,
  inventoryPoolId: string,
): Promise<PaidCheckoutCaptureState> {
  return withE2eDb(async (db) => {
    const session = await db
      .selectFrom('checkout_sessions')
      .select(['status', 'order_id', 'payment_intent_id'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();

    if (!session.order_id) {
      throw new Error(`Checkout session ${sessionId} did not create an order`);
    }
    if (!session.payment_intent_id) {
      throw new Error(`Checkout session ${sessionId} did not create a payment intent`);
    }

    const [order, paymentIntent, hold, inventoryPool, tickets, ticketEmailJob] = await Promise.all([
      db
        .selectFrom('orders')
        .select([
          'id',
          'status',
          'subtotal_cents',
          'discount_cents',
          'total_cents',
          'payment_provider',
          'payment_intent_id',
        ])
        .where('id', '=', session.order_id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('payment_intents')
        .select(['provider', 'provider_intent_id', 'status', 'order_id'])
        .where('id', '=', session.payment_intent_id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('checkout_holds')
        .select(['status', 'quantity'])
        .where('checkout_session_id', '=', sessionId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('inventory_pools')
        .select(['sold_count'])
        .where('id', '=', inventoryPoolId)
        .executeTakeFirstOrThrow(),
      db.selectFrom('tickets').select(['id']).where('order_id', '=', session.order_id).execute(),
      db
        .selectFrom('email_jobs')
        .select(['template_key', 'variables'])
        .where('idempotency_key', '=', `tickets-issued:${session.order_id}`)
        .executeTakeFirst(),
    ]);
    const ticketEmailVariables = parseJsonRecord(ticketEmailJob?.variables);
    const attachments = Array.isArray(ticketEmailVariables.attachments)
      ? ticketEmailVariables.attachments.filter(
          (
            attachment,
          ): attachment is {
            filename: string;
            contentType: string;
            content: string;
            contentEncoding?: 'base64';
          } => {
            const candidate = attachment as Record<string, unknown>;
            return (
              typeof candidate.filename === 'string' &&
              typeof candidate.contentType === 'string' &&
              typeof candidate.content === 'string'
            );
          },
        )
      : [];

    return {
      session: {
        status: session.status,
        orderId: session.order_id,
        paymentIntentId: session.payment_intent_id,
      },
      order: {
        id: order.id,
        status: order.status,
        subtotalCents: Number(order.subtotal_cents),
        discountCents: Number(order.discount_cents),
        totalCents: Number(order.total_cents),
        paymentProvider: order.payment_provider,
        paymentIntentId: order.payment_intent_id,
      },
      paymentIntent: {
        provider: paymentIntent.provider,
        providerIntentId: paymentIntent.provider_intent_id,
        status: paymentIntent.status,
        orderId: paymentIntent.order_id,
      },
      hold: {
        status: hold.status,
        quantity: Number(hold.quantity),
      },
      inventoryPool: {
        soldCount: Number(inventoryPool.sold_count),
      },
      ticketCount: tickets.length,
      ticketIds: tickets.map((ticket) => ticket.id),
      ticketEmailJob: ticketEmailJob
        ? {
            templateKey: ticketEmailJob.template_key,
            attachments,
          }
        : null,
    };
  });
}

export async function readWalletPassState(sessionId: string): Promise<WalletPassState[]> {
  return withE2eDb(async (db) => {
    const session = await db
      .selectFrom('checkout_sessions')
      .select(['tenant_id', 'order_id'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();

    if (!session.order_id) {
      throw new Error(`Checkout session ${sessionId} did not create an order`);
    }

    const rows = await db
      .selectFrom('wallet_passes')
      .innerJoin('tickets', 'tickets.id', 'wallet_passes.ticket_id')
      .select([
        'wallet_passes.ticket_id as ticket_id',
        'tickets.code as ticket_code',
        'wallet_passes.provider as provider',
        'wallet_passes.status as status',
        'wallet_passes.pass_url as pass_url',
        'wallet_passes.access_token_hash as access_token_hash',
        'wallet_passes.content_type as content_type',
        'wallet_passes.artifact_base64 as artifact_base64',
      ])
      .where('wallet_passes.tenant_id', '=', session.tenant_id)
      .where('tickets.order_id', '=', session.order_id)
      .orderBy('wallet_passes.provider', 'asc')
      .execute();

    return rows.map((row) => ({
      ticketId: row.ticket_id,
      ticketCode: row.ticket_code,
      provider: row.provider,
      status: row.status,
      passUrl: row.pass_url,
      accessTokenHash: row.access_token_hash,
      contentType: row.content_type,
      artifactBase64: row.artifact_base64,
    }));
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readPromoCheckoutCaptureState(
  sessionId: string,
  inventoryPoolId: string,
  discountCodeId: string,
): Promise<PromoCheckoutCaptureState> {
  const paidState = await readPaidCheckoutCaptureState(sessionId, inventoryPoolId);

  return withE2eDb(async (db) => {
    const [discountCode, redemption] = await Promise.all([
      db
        .selectFrom('discount_codes')
        .select(['id', 'code', 'uses_count'])
        .where('id', '=', discountCodeId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('discount_redemptions')
        .select(['discount_code_id', 'event_id', 'checkout_session_id', 'order_id', 'tenant_id'])
        .where('checkout_session_id', '=', sessionId)
        .executeTakeFirstOrThrow(),
    ]);

    return {
      ...paidState,
      discountCode: {
        id: discountCode.id,
        code: discountCode.code,
        usesCount: Number(discountCode.uses_count),
      },
      redemption: {
        discountCodeId: redemption.discount_code_id,
        eventId: redemption.event_id,
        checkoutSessionId: redemption.checkout_session_id,
        orderId: redemption.order_id,
        tenantId: redemption.tenant_id,
      },
    };
  });
}

export async function seedAffiliateAttributionForOrder(
  orderId: string,
  suffix: string,
  commissionCents = 200,
): Promise<SeededAffiliateAttribution> {
  const safeSuffix = compactIdPart(suffix);
  const affiliate = {
    id: `aff_e2e_${safeSuffix}`.slice(0, 32),
    code: `E2EAFF${safeSuffix}`.slice(0, 32).toUpperCase(),
    name: `E2E Affiliate ${safeSuffix}`,
    commissionCents,
  };
  const attribution = {
    id: `atr_e2e_${safeSuffix}`.slice(0, 32),
    orderId,
  };
  const now = new Date();

  await withE2eDb(async (db) => {
    await db
      .insertInto('affiliates')
      .values({
        id: affiliate.id,
        tenant_id: devTenantId,
        organization_id: devOrganizationId,
        code: affiliate.code,
        name: affiliate.name,
        commission_percentage: 1_000,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await db
      .insertInto('attributions')
      .values({
        id: attribution.id,
        order_id: orderId,
        affiliate_id: affiliate.id,
        affiliate_code: affiliate.code,
        commission_cents: commissionCents,
        attributed_at: now,
        created_at: now,
      })
      .execute();
  });

  return { affiliate, attribution };
}

export async function seedTaxSnapshotForOrder(input: {
  eventId: string;
  orderId: string;
  suffix: string;
  taxableAmountCents?: number;
  taxCollectedCents?: number;
}): Promise<SeededTaxSnapshot> {
  const safeSuffix = compactIdPart(input.suffix);
  const taxRule = {
    id: `tax_e2e_${safeSuffix}`.slice(0, 32),
    name: `E2E VAT ${safeSuffix}`,
    rate: 825,
  };
  const taxableAmountCents = input.taxableAmountCents ?? 4_000;
  const taxCollectedCents = input.taxCollectedCents ?? 330;
  const now = new Date();

  await withE2eDb(async (db) => {
    await db
      .insertInto('tax_rules')
      .values({
        id: taxRule.id,
        event_id: input.eventId,
        name: taxRule.name,
        rate: taxRule.rate,
        type: 'exclusive',
        applied_to: 'all',
        countries: null,
        regions: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const lineItem = await db
      .selectFrom('order_line_items')
      .select(['id'])
      .where('order_id', '=', input.orderId)
      .orderBy('id', 'asc')
      .executeTakeFirstOrThrow();

    await db
      .updateTable('order_line_items')
      .set({
        unit_price_cents: taxableAmountCents,
        subtotal_cents: taxableAmountCents,
        discount_cents: 0,
        tax_cents: taxCollectedCents,
        total_cents: taxableAmountCents + taxCollectedCents,
        updated_at: now,
      })
      .where('id', '=', lineItem.id)
      .execute();

    await db
      .updateTable('orders')
      .set({
        subtotal_cents: taxableAmountCents,
        tax_cents: taxCollectedCents,
        total_cents: taxableAmountCents + taxCollectedCents,
        updated_at: now,
      })
      .where('id', '=', input.orderId)
      .execute();
  });

  return { taxRule, taxableAmountCents, taxCollectedCents };
}

export async function readCheckoutOrderState(
  sessionId: string,
  inventoryPoolId: string,
): Promise<CheckoutOrderState> {
  return withE2eDb(async (db) => {
    const session = await db
      .selectFrom('checkout_sessions')
      .select(['status', 'order_id'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();

    if (!session.order_id) {
      throw new Error(`Checkout session ${sessionId} did not create an order`);
    }

    const [order, holds, inventoryPool, tickets] = await Promise.all([
      db
        .selectFrom('orders')
        .select(['id', 'status', 'total_cents'])
        .where('id', '=', session.order_id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('checkout_holds')
        .select(['ticket_type_id', 'status', 'quantity'])
        .where('checkout_session_id', '=', sessionId)
        .orderBy('ticket_type_id', 'asc')
        .execute(),
      db
        .selectFrom('inventory_pools')
        .select(['sold_count'])
        .where('id', '=', inventoryPoolId)
        .executeTakeFirstOrThrow(),
      db.selectFrom('tickets').select(['id']).where('order_id', '=', session.order_id).execute(),
    ]);

    return {
      session: {
        status: session.status,
        orderId: session.order_id,
      },
      order: {
        id: order.id,
        status: order.status,
        totalCents: Number(order.total_cents),
      },
      holds: holds.map((hold) => ({
        ticketTypeId: hold.ticket_type_id,
        status: hold.status,
        quantity: Number(hold.quantity),
      })),
      inventoryPool: {
        soldCount: Number(inventoryPool.sold_count),
      },
      ticketCount: tickets.length,
    };
  });
}

export async function seedCheckInListForOrder(input: {
  eventId: string;
  orderId: string;
  suffix: string;
}): Promise<SeededCheckInList> {
  return withE2eDb(async (db) => {
    const tickets = await db
      .selectFrom('tickets')
      .select(['id', 'ticket_type_id', 'qr_payload', 'qr_hash', 'status'])
      .where('order_id', '=', input.orderId)
      .orderBy('id', 'asc')
      .execute();

    if (tickets.length === 0) {
      throw new Error(`Order ${input.orderId} has no tickets to scan`);
    }

    const now = new Date();
    const checkInListId = `cil_e2e_${safeIdPart(input.orderId)}`.slice(0, 32);
    const checkInListName = `E2E scanner ${input.suffix}`;
    await db
      .insertInto('check_in_lists')
      .values({
        id: checkInListId,
        event_id: input.eventId,
        name: checkInListName,
        ticket_type_ids: JSON.stringify([
          ...new Set(tickets.map((ticket) => ticket.ticket_type_id)),
        ]),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    return {
      id: checkInListId,
      name: checkInListName,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        ticketTypeId: ticket.ticket_type_id,
        qrPayload: ticket.qr_payload,
        qrHash: ticket.qr_hash,
        status: ticket.status,
      })),
    };
  });
}

export async function readCheckInWorkflowState(input: {
  checkInListId: string;
  ticketIds: string[];
}): Promise<CheckInWorkflowState> {
  return withE2eDb(async (db) => {
    const [tickets, scanLogs] = await Promise.all([
      db
        .selectFrom('tickets')
        .select(['id', 'status', 'checked_in_by_device_id'])
        .where('id', 'in', input.ticketIds)
        .orderBy('id', 'asc')
        .execute(),
      db
        .selectFrom('scan_logs')
        .select(['outcome', 'offline', 'ticket_id', 'qr_hash'])
        .where('check_in_list_id', '=', input.checkInListId)
        .orderBy('scanned_at', 'asc')
        .orderBy('id', 'asc')
        .execute(),
    ]);

    return {
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        status: ticket.status,
        checkedInByDeviceId: ticket.checked_in_by_device_id,
      })),
      scanLogs: scanLogs.map((log) => ({
        outcome: log.outcome,
        offline: Boolean(log.offline),
        ticketId: log.ticket_id,
        qrHash: log.qr_hash,
      })),
    };
  });
}
