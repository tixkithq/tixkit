import { describe, expect, it } from 'vitest';
import { adminApi } from '@/lib/api';

describe('AdminApi.getPrincipal', () => {
  it('returns a principal with permissions in dev fixtures', async () => {
    const result = await adminApi.getPrincipal();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.permissions.length).toBeGreaterThan(0);
      expect(result.data.tenantId).toBeDefined();
      expect(Array.isArray(result.data.organizationIds)).toBe(true);
    }
  });
});

describe('AdminApi settings fixtures', () => {
  it('loads and updates organization settings through the typed API', async () => {
    const listResult = await adminApi.listOrganizations();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const organization = listResult.data[0];
    expect(organization).toBeDefined();

    const updateResult = await adminApi.updateOrganization(organization.id, {
      name: 'Updated Tixkit',
      slug: organization.slug,
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.name).toBe('Updated Tixkit');
      expect(updateResult.data.boxOfficeSettings).toEqual({
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      });
    }
  });

  it('updates brand settings and creates domains through the typed API', async () => {
    const listResult = await adminApi.listBrands();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const brand = listResult.data[0];
    expect(brand).toBeDefined();

    const updateResult = await adminApi.updateBrand(brand.id, {
      theme: { ...brand.theme, primaryColor: '#111111' },
      supportUrl: 'https://help.example.test',
      legalUrls: {
        terms: 'https://legal.example.test/terms',
        privacy: 'https://legal.example.test/privacy',
        refundPolicy: 'https://legal.example.test/refunds',
      },
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.theme.primaryColor).toBe('#111111');
      expect(updateResult.data.supportUrl).toBe('https://help.example.test');
      expect(updateResult.data.legalUrls).toEqual({
        terms: 'https://legal.example.test/terms',
        privacy: 'https://legal.example.test/privacy',
        refundPolicy: 'https://legal.example.test/refunds',
      });
    }

    const domainResult = await adminApi.addBrandDomain(brand.id, 'tickets.example.test');
    expect(domainResult.ok).toBe(true);
    if (domainResult.ok) {
      expect(domainResult.data.domain).toBe('tickets.example.test');
    }
  });

  it('invites members and starts payment account setup through the typed API', async () => {
    const inviteResult = await adminApi.inviteTeamMember('org_demo', {
      email: 'teammate@example.test',
      role: 'viewer',
    });
    expect(inviteResult.ok).toBe(true);
    if (inviteResult.ok) {
      expect(inviteResult.data.status).toBe('invited');
    }

    const accountResult = await adminApi.createStripeConnectAccount('org_demo');
    expect(accountResult.ok).toBe(true);
    if (accountResult.ok) {
      expect(accountResult.data.provider).toBe('stripe_connect');
      expect(accountResult.data).toMatchObject({
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: {},
        disabledReason: null,
      });
      const refreshResult = await adminApi.refreshStripeConnectAccount(
        'org_demo',
        accountResult.data.id,
      );
      expect(refreshResult.ok).toBe(true);
      if (refreshResult.ok) {
        expect(refreshResult.data.status).toBe('active');
        expect(refreshResult.data).toMatchObject({
          detailsSubmitted: true,
          chargesEnabled: true,
          payoutsEnabled: true,
          disabledReason: null,
        });
      }
    }
  });
});

describe('AdminApi message campaign fixtures', () => {
  it('preserves persisted audience labels on reloaded campaigns', async () => {
    const result = await adminApi.listMessages('evt_demo_002');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data[0]).toMatchObject({
      audience: 'not_checked_in',
      audienceKey: 'not_checked_in',
      audienceLabel: 'Not checked in',
    });
  });
});

describe('AdminApi content document contract', () => {
  it('lists content documents through a typed page envelope', async () => {
    const result = await adminApi.listContentDocuments({ channel: 'email', limit: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
    }
  });

  it('does not fake content document writes in fixtures', async () => {
    const result = await adminApi.createContentDocument({
      organizationId: 'org_demo',
      brandId: 'brd_demo',
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmed',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('fixture_unavailable');
      expect(result.error.status).toBe(503);
    }
  });
});

describe('AdminApi.updateTicketType', () => {
  it('updates an existing ticket type by id', async () => {
    const createResult = await adminApi.createTicketType('evt_demo_001', {
      name: 'Original Name',
      kind: 'paid',
      priceCents: 3000,
      currency: 'USD',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const updateResult = await adminApi.updateTicketType(createResult.data.id, {
      name: 'Updated Name',
      priceCents: 3999,
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.name).toBe('Updated Name');
      expect(updateResult.data.priceCents).toBe(3999);
    }
  });

  it('returns not_found for a nonexistent ticket type', async () => {
    const result = await adminApi.updateTicketType('tt_nonexistent', {
      name: 'Nope',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      expect(result.error.status).toBe(404);
    }
  });

  it('creates, lists, and deletes access rules for locked tickets', async () => {
    const ticketResult = await adminApi.createTicketType('evt_demo_001', {
      name: 'Locked Invite',
      kind: 'paid',
      visibility: 'locked',
      priceCents: 5000,
      currency: 'USD',
      requiresAccessCode: true,
      accessCodeHint: 'Invite code',
    });
    expect(ticketResult.ok).toBe(true);
    if (!ticketResult.ok) return;

    const createRule = await adminApi.createAccessRule(ticketResult.data.id, {
      type: 'code',
      value: 'VIP123',
      maxUses: 5,
    });
    expect(createRule.ok).toBe(true);
    if (!createRule.ok) return;

    const listRules = await adminApi.listAccessRules(ticketResult.data.id);
    expect(listRules.ok).toBe(true);
    if (listRules.ok) {
      expect(listRules.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: createRule.data.id, value: 'VIP123', usesCount: 0 }),
        ]),
      );
    }

    const deleteRule = await adminApi.deleteAccessRule(createRule.data.id);
    expect(deleteRule.ok).toBe(true);

    const afterDelete = await adminApi.listAccessRules(ticketResult.data.id);
    expect(afterDelete.ok).toBe(true);
    if (afterDelete.ok) {
      expect(afterDelete.data.some((rule) => rule.id === createRule.data.id)).toBe(false);
    }
  });

  it('creates locked tickets with access rules and a new inventory pool atomically through the batch API', async () => {
    const result = await adminApi.createTicketTypeBatch('evt_demo_001', {
      ticketType: {
        name: 'Atomic Locked VIP',
        kind: 'paid',
        visibility: 'locked',
        priceCents: 7500,
        currency: 'USD',
        requiresAccessCode: true,
      },
      inventoryPool: {
        name: 'Atomic VIP Pool',
        totalCapacity: 25,
      },
      accessRules: [{ type: 'code', value: 'ATOMICVIP' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ticketType.inventoryPoolId).toMatch(/^ip_/);
    expect(result.data.accessRules).toEqual([
      expect.objectContaining({ ticketTypeId: result.data.ticketType.id, value: 'ATOMICVIP' }),
    ]);
  });

  it('updates tickets and appends access rules through the batch API', async () => {
    const createResult = await adminApi.createTicketTypeBatch('evt_demo_001', {
      ticketType: {
        name: 'Editable Locked VIP',
        kind: 'paid',
        visibility: 'locked',
        priceCents: 5000,
        currency: 'USD',
        requiresAccessCode: true,
      },
      inventoryPool: {
        name: 'Editable VIP Pool',
        totalCapacity: 15,
      },
      accessRules: [{ type: 'code', value: 'EDITVIP1' }],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const updateResult = await adminApi.updateTicketTypeBatch(createResult.data.ticketType.id, {
      ticketType: {
        name: 'Updated Locked VIP',
        priceCents: 6500,
      },
      accessRules: [{ type: 'code', value: 'EDITVIP2' }],
    });

    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.data.ticketType.name).toBe('Updated Locked VIP');
    expect(updateResult.data.ticketType.priceCents).toBe(6500);
    expect(updateResult.data.accessRules.map((rule) => rule.value)).toEqual(
      expect.arrayContaining(['EDITVIP1', 'EDITVIP2']),
    );
  });

  it('rejects duplicate access codes before fixture writes', async () => {
    const result = await adminApi.createTicketTypeBatch('evt_demo_001', {
      ticketType: {
        name: 'Duplicate Locked VIP',
        kind: 'paid',
        visibility: 'locked',
        priceCents: 7500,
        currency: 'USD',
        requiresAccessCode: true,
      },
      inventoryPool: {
        name: 'Duplicate VIP Pool',
        totalCapacity: 10,
      },
      accessRules: [
        { type: 'code', value: 'DUPVIP' },
        { type: 'code', value: ' dupvip ' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('duplicate_access_rule');
    }
  });

  it('fails batch create when neither an existing nor new inventory pool is provided', async () => {
    const result = await adminApi.createTicketTypeBatch('evt_demo_001', {
      ticketType: {
        name: 'No Pool',
        kind: 'paid',
        priceCents: 7500,
        currency: 'USD',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing_inventory_pool');
    }
  });

  it('creates, lists, and updates products and product categories', async () => {
    const categoryResult = await adminApi.createProductCategory('evt_demo_001', {
      name: 'Merch',
      sortOrder: 3,
    });
    expect(categoryResult.ok).toBe(true);
    if (!categoryResult.ok) return;

    const categoriesResult = await adminApi.listProductCategories('evt_demo_001');
    expect(categoriesResult.ok).toBe(true);
    if (categoriesResult.ok) {
      expect(categoriesResult.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: categoryResult.data.id, name: 'Merch', sortOrder: 3 }),
        ]),
      );
    }

    const productResult = await adminApi.createProduct('evt_demo_001', {
      name: 'Festival T-shirt',
      description: 'Soft cotton shirt',
      priceCents: 2500,
      currency: 'USD',
      categoryId: categoryResult.data.id,
      maxPerOrder: 2,
      status: 'active',
      sortOrder: 5,
    });
    expect(productResult.ok).toBe(true);
    if (!productResult.ok) return;

    const productsResult = await adminApi.listProducts('evt_demo_001');
    expect(productsResult.ok).toBe(true);
    if (productsResult.ok) {
      expect(productsResult.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: productResult.data.id,
            categoryId: categoryResult.data.id,
            maxPerOrder: 2,
            priceCents: 2500,
          }),
        ]),
      );
    }

    const updateResult = await adminApi.updateProduct(productResult.data.id, {
      name: 'Festival Hoodie',
      description: null,
      categoryId: null,
      priceCents: 4500,
      status: 'inactive',
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.name).toBe('Festival Hoodie');
      expect(updateResult.data.description).toBeUndefined();
      expect(updateResult.data.categoryId).toBeUndefined();
      expect(updateResult.data.priceCents).toBe(4500);
      expect(updateResult.data.status).toBe('inactive');
    }
  });

  it('returns not_found for a nonexistent product update', async () => {
    const result = await adminApi.updateProduct('prd_nonexistent', {
      name: 'Nope',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      expect(result.error.status).toBe(404);
    }
  });
});

describe('AdminApi checkout questions', () => {
  it('creates, updates, and deletes event checkout questions through the typed API', async () => {
    const createResult = await adminApi.createCheckoutQuestion('evt_demo_001', {
      type: 'select',
      label: 'T-shirt size',
      required: true,
      appliesTo: 'attendee',
      options: ['S', 'M', 'L'],
      sortOrder: 99,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    expect(createResult.data.eventId).toBe('evt_demo_001');
    expect(createResult.data.options).toEqual(['S', 'M', 'L']);

    const updateResult = await adminApi.updateCheckoutQuestion(createResult.data.id, {
      label: 'Shirt size',
      required: false,
      sortOrder: 12,
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.label).toBe('Shirt size');
      expect(updateResult.data.required).toBe(false);
      expect(updateResult.data.sortOrder).toBe(12);
    }

    const listResult = await adminApi.listCheckoutQuestions('evt_demo_001');
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.data.some((question) => question.id === createResult.data.id)).toBe(true);
    }

    const deleteResult = await adminApi.deleteCheckoutQuestion(createResult.data.id);
    expect(deleteResult.ok).toBe(true);
  });

  it('returns not_found when updating a missing checkout question', async () => {
    const result = await adminApi.updateCheckoutQuestion('q_missing', {
      label: 'Nope',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
  });
});

describe('AdminApi event fee policy', () => {
  it('reads and updates event fee pass-through settings', async () => {
    const initial = await adminApi.getEventFeePolicy('evt_demo_001');
    expect(initial.ok).toBe(true);
    if (initial.ok) {
      expect(initial.data.eventId).toBe('evt_demo_001');
      expect(initial.data.rules[0]?.absorbIntoPrice).toBe(false);
    }

    const update = await adminApi.updateEventFeePolicy('evt_demo_001', {
      passFeesToBuyer: false,
      rules: [
        {
          name: 'Organizer-paid order fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
        },
      ],
    });
    expect(update.ok).toBe(true);
    if (update.ok) {
      expect(update.data.passFeesToBuyer).toBe(false);
      expect(update.data.rules).toEqual([
        expect.objectContaining({
          name: 'Organizer-paid order fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
          absorbIntoPrice: true,
        }),
      ]);
    }
  });
});

describe('AdminApi reports date range', () => {
  it('getSalesReport reflects the requested from/to range', async () => {
    const from = '2026-01-01';
    const to = '2026-01-31';
    const result = await adminApi.getSalesReport('evt_demo_001', { from, to });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.range.from).toBe(from);
      expect(result.data.range.to).toBe(to);
    }
  });

  it('getTaxReport accepts a date range without error', async () => {
    const result = await adminApi.getTaxReport('evt_demo_001', {
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.eventId).toBe('evt_demo_001');
      expect(result.data.totalTaxCollectedCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns attendance, promo, conversion, and affiliate reports through typed methods', async () => {
    const attendance = await adminApi.getAttendanceReport('evt_demo_001');
    const promo = await adminApi.getPromoReport('evt_demo_001');
    const conversion = await adminApi.getConversionReport('evt_demo_001');
    const affiliate = await adminApi.getAffiliateReport('org_demo');

    expect(attendance.ok).toBe(true);
    expect(promo.ok).toBe(true);
    expect(conversion.ok).toBe(true);
    expect(affiliate.ok).toBe(true);

    if (attendance.ok) {
      expect(attendance.data).toMatchObject({ eventId: 'evt_demo_001' });
      expect(attendance.data.totalAttendees).toBeGreaterThanOrEqual(attendance.data.checkedIn);
    }
    if (promo.ok) {
      expect(promo.data.discountCodes[0]).toHaveProperty('revenueAttributedCents');
    }
    if (conversion.ok) {
      expect(conversion.data.widgetViews).toBe(0);
      expect(conversion.data.conversionRate).toBeGreaterThanOrEqual(0);
    }
    if (affiliate.ok) {
      expect(affiliate.data.organizationId).toBe('org_demo');
      expect(affiliate.data.affiliates[0]).toHaveProperty('commissionCents');
    }
  });

  it('createExport returns a queued export job through the typed API', async () => {
    const result = await adminApi.createExport({
      eventId: 'evt_demo_001',
      type: 'sales',
      format: 'csv',
      filters: { from: '2026-02-01', to: '2026-02-28' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.exportId).toMatch(/^exp_/);
      expect(result.data.status).toBe('pending');
      expect(result.data.type).toBe('sales');
      expect(result.data.format).toBe('csv');
    }
  });

  it('getExport returns the queued export job through the typed API', async () => {
    const createResult = await adminApi.createExport({
      eventId: 'evt_demo_001',
      type: 'attendees',
      format: 'csv',
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = await adminApi.getExport(createResult.data.exportId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.data.exportId).toBe(createResult.data.exportId);
      expect(getResult.data.status).toBe('pending');
      expect(getResult.data.type).toBe('attendees');
      expect(getResult.data.format).toBe('csv');
    }
  });
});

describe('AdminApi order timestamps', () => {
  it('paid fixture orders expose paidAt', async () => {
    const result = await adminApi.getOrder('ord_001');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('paid');
      expect(result.data.paidAt).toBeDefined();
    }
  });

  it('refundOrder queues a refund workflow', async () => {
    // ord_002 is paid with zero refunds.
    const result = await adminApi.refundOrder('ord_002', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('pending');
      expect(result.data.message).toContain('Refund workflow');
    }
  });

  it('refundOrder supports partial refund with amountCents', async () => {
    // ord_001 is paid with totalCents 5000, refundedCents 0.
    const result = await adminApi.refundOrder('ord_001', {
      amountCents: 2000,
      reason: 'partial customer request',
      voidTickets: false,
      restoreInventory: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.refundAmount).toBe(2000);
      expect(result.data.status).toBe('pending');
    }
    // Verify order state transitioned to partially_refunded.
    const orderResult = await adminApi.getOrder('ord_001');
    expect(orderResult.ok).toBe(true);
    if (orderResult.ok) {
      expect(orderResult.data.status).toBe('partially_refunded');
      expect(orderResult.data.refundedCents).toBe(2000);
    }
  });

  it('refundOrder passes reason through to the API', async () => {
    // Use ord_001 which now has 2000 refunded. Refund the rest.
    const result = await adminApi.refundOrder('ord_001', {
      reason: 'final partial refund',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Full remaining refund: 5000 - 2000 = 3000
      expect(result.data.refundAmount).toBe(3000);
    }
  });

  it('cancelOrder sets cancelledAt', async () => {
    // ord_003 is pending.
    const result = await adminApi.cancelOrder('ord_003', { idempotencyKey: 'cancel_ord_003' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cancelledAt).toBeDefined();
    }
  });
});

describe('AdminApi create methods pass explicit org/brand context', () => {
  it('createEvent accepts organizationId and brandId from bootstrap context', async () => {
    const result = await adminApi.createEvent({
      organizationId: 'org_demo',
      brandId: 'brd_demo',
      title: 'Bootstrap Context Event',
      startsAt: '2026-09-01T19:00',
      timezone: 'UTC',
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBe('Bootstrap Context Event');
    }
  });

  it('createApiKey accepts organizationId from bootstrap context', async () => {
    const result = await adminApi.createApiKey({
      organizationId: 'org_demo',
      name: 'Bootstrap Context Key',
      scopes: ['events.read'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('Bootstrap Context Key');
    }
  });

  it('createWebhookEndpoint accepts organizationId from bootstrap context', async () => {
    const result = await adminApi.createWebhookEndpoint({
      organizationId: 'org_demo',
      url: 'https://example.com/hooks/bootstrap',
      events: ['order.created'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.url).toBe('https://example.com/hooks/bootstrap');
    }
  });
});
