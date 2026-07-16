import { describe, expect, it } from 'vitest';
import {
  evaluateEventPaymentReadiness,
  eventRequiresPayment,
  evaluateAcknowledgement,
  evaluateLifecycleContent,
  evaluateSellableTickets,
  resolvePaymentMode,
} from '../services/readiness.js';

describe('readiness service invariants', () => {
  it('requires payment for active paid products even when tickets are free', () => {
    const paidProductRequiresPayment = eventRequiresPayment({
      tickets: [{ kind: 'free', priceCents: 0, minimumPriceCents: null }],
      products: [{ status: 'active', priceCents: 2_500 }],
    });
    expect(paidProductRequiresPayment).toBe(true);
    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: paidProductRequiresPayment,
        paymentMode: 'capture',
        eventCurrency: 'USD',
      }),
    ).toEqual({
      status: 'blocked',
      reasonCode: 'payment_capture_mode_paid_unsupported',
    });
    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: paidProductRequiresPayment,
        paymentMode: 'provider',
        eventCurrency: 'USD',
        account: {
          id: 'pa_product',
          status: 'active',
          chargesEnabled: true,
          defaultCurrency: 'USD',
        },
      }),
    ).toEqual({ status: 'complete', reasonCode: 'payment_ready' });
    expect(
      eventRequiresPayment({
        tickets: [{ kind: 'free', priceCents: 0, minimumPriceCents: null }],
        products: [
          { status: 'active', priceCents: 0 },
          { status: 'inactive', priceCents: 2_500 },
        ],
      }),
    ).toBe(false);
  });
  it('does not require a payment account for free-only events', () => {
    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: false,
        paymentMode: 'capture',
        eventCurrency: 'USD',
      }),
    ).toEqual({ status: 'not_applicable', reasonCode: 'payment_not_required' });
  });

  it('does not represent capture mode as charges-enabled for paid events', () => {
    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: true,
        paymentMode: 'capture',
        account: {
          id: 'pa_1',
          status: 'active',
          chargesEnabled: true,
          defaultCurrency: 'USD',
        },
        eventCurrency: 'USD',
      }),
    ).toEqual({
      status: 'blocked',
      reasonCode: 'payment_capture_mode_paid_unsupported',
    });
  });

  it('allows the explicit non-production provider-test platform path without a connected account', () => {
    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: true,
        paymentMode: 'provider_test',
        eventCurrency: 'USD',
      }),
    ).toEqual({ status: 'complete', reasonCode: 'payment_ready' });
  });

  it('allows provider and capture test modes only in explicit development or test environments', () => {
    const original = {
      nodeEnv: process.env.NODE_ENV,
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
      providerTestMode: process.env.PAYMENT_PROVIDER_TEST_MODE,
      captureTestMode: process.env.E2E_PAID_CAPTURE_MODE,
    };
    try {
      process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_secret';
      process.env.PAYMENT_PROVIDER_TEST_MODE = '1';
      for (const nodeEnv of [undefined, 'production', 'staging', 'preview', 'developmnt']) {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        expect(resolvePaymentMode()).toBe('provider');
      }
      for (const nodeEnv of ['development', 'test']) {
        process.env.NODE_ENV = nodeEnv;
        expect(resolvePaymentMode()).toBe('provider_test');
      }

      delete process.env.STRIPE_SECRET_KEY;
      process.env.E2E_PAID_CAPTURE_MODE = '1';
      process.env.NODE_ENV = 'development';
      expect(resolvePaymentMode()).toBe('provider_test');
      process.env.NODE_ENV = 'staging';
      expect(resolvePaymentMode()).toBe('capture');
    } finally {
      if (original.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original.nodeEnv;
      if (original.stripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = original.stripeSecretKey;
      if (original.providerTestMode === undefined) delete process.env.PAYMENT_PROVIDER_TEST_MODE;
      else process.env.PAYMENT_PROVIDER_TEST_MODE = original.providerTestMode;
      if (original.captureTestMode === undefined) delete process.env.E2E_PAID_CAPTURE_MODE;
      else process.env.E2E_PAID_CAPTURE_MODE = original.captureTestMode;
    }
  });

  it('requires an active charges-enabled currency-coherent provider account', () => {
    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: true,
        paymentMode: 'provider',
        account: {
          id: 'pa_1',
          status: 'active',
          chargesEnabled: true,
          defaultCurrency: 'EUR',
        },
        eventCurrency: 'EUR',
      }),
    ).toEqual({ status: 'complete', reasonCode: 'payment_ready' });

    expect(
      evaluateEventPaymentReadiness({
        requiresPayment: true,
        paymentMode: 'provider',
        account: {
          id: 'pa_1',
          status: 'active',
          chargesEnabled: true,
          defaultCurrency: 'USD',
        },
        eventCurrency: 'EUR',
      }),
    ).toEqual({ status: 'blocked', reasonCode: 'payment_currency_mismatch' });
  });

  it('invalidates review acknowledgement when the subject fingerprint changes', () => {
    const acknowledgement = {
      stepVersion: 1,
      subjectFingerprint: 'a'.repeat(64),
      acknowledgedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(
      evaluateAcknowledgement({
        stepId: 'preview_review',
        currentFingerprint: 'a'.repeat(64),
        acknowledgement,
      }),
    ).toMatchObject({ complete: true, reason: 'preview_reviewed' });
    expect(
      evaluateAcknowledgement({
        stepId: 'preview_review',
        currentFingerprint: 'b'.repeat(64),
        acknowledgement,
      }),
    ).toEqual({
      complete: false,
      reason: 'acknowledgement_stale',
      acknowledgedAt: '2026-07-01T00:00:00.000Z',
      acknowledgementValid: false,
    });
  });

  it('invalidates acknowledgement when the step contract version changes', () => {
    expect(
      evaluateAcknowledgement({
        stepId: 'checkout_consent',
        currentFingerprint: 'a'.repeat(64),
        acknowledgement: {
          stepVersion: 0,
          subjectFingerprint: 'a'.repeat(64),
          acknowledgedAt: '2026-07-01T00:00:00.000Z',
        },
      }),
    ).toEqual({
      complete: false,
      reason: 'acknowledgement_stale',
      acknowledgedAt: '2026-07-01T00:00:00.000Z',
      acknowledgementValid: false,
    });
  });

  it.each([
    [[], 'sellable_ticket_missing'],
    [
      [
        {
          status: 'active',
          totalCapacity: 0,
          reservedCount: 0,
          soldCount: 0,
          salesStartAt: null,
          salesEndAt: null,
        },
      ],
      'inventory_invalid',
    ],
    [
      [
        {
          status: 'active',
          totalCapacity: 10,
          reservedCount: 0,
          soldCount: 0,
          salesStartAt: '2027-02-01',
          salesEndAt: '2027-01-01',
        },
      ],
      'sales_window_invalid',
    ],
    [
      [
        {
          status: 'active',
          totalCapacity: 10,
          reservedCount: 0,
          soldCount: 10,
          salesStartAt: null,
          salesEndAt: null,
        },
      ],
      'ticket_inventory_unavailable',
    ],
    [
      [
        {
          status: 'active',
          totalCapacity: 10,
          reservedCount: 0,
          soldCount: 0,
          salesStartAt: null,
          salesEndAt: null,
        },
      ],
      'sellable_ticket_available',
    ],
  ] as const)('emits the authoritative ticket reason %#', (tickets, reasonCode) => {
    expect(evaluateSellableTickets(tickets, new Date('2026-01-01'))).toMatchObject({ reasonCode });
  });

  it('accepts a later occurrence sales window relative to that occurrence', () => {
    expect(
      evaluateSellableTickets(
        [
          {
            status: 'active',
            totalCapacity: 10,
            reservedCount: 0,
            soldCount: 0,
            salesStartAt: '2026-06-01T00:00:00.000Z',
            salesEndAt: '2026-06-30T00:00:00.000Z',
            eventOccurrenceId: 'occ_2',
            occurrenceEventId: 'evt_1',
            occurrenceStartsAt: '2026-07-15T00:00:00.000Z',
            occurrenceStatus: 'scheduled',
          },
        ],
        new Date('2026-05-01T00:00:00.000Z'),
        '2026-07-01T00:00:00.000Z',
      ),
    ).toMatchObject({ status: 'complete', reasonCode: 'sellable_ticket_available' });
  });

  it.each([
    [
      {
        occurrenceEventId: null,
        occurrenceStatus: 'scheduled',
        occurrenceStartsAt: '2026-07-15T00:00:00.000Z',
      },
    ],
    [
      {
        occurrenceEventId: 'evt_1',
        occurrenceStatus: 'cancelled',
        occurrenceStartsAt: '2026-07-15T00:00:00.000Z',
      },
    ],
    [
      {
        occurrenceEventId: 'evt_1',
        occurrenceStatus: 'scheduled',
        occurrenceStartsAt: '2026-04-01T00:00:00.000Z',
      },
    ],
  ])('rejects an unusable occurrence scope %#', (occurrence) => {
    expect(
      evaluateSellableTickets(
        [
          {
            status: 'active',
            totalCapacity: 10,
            reservedCount: 0,
            soldCount: 0,
            salesStartAt: null,
            salesEndAt: null,
            eventOccurrenceId: 'occ_2',
            ...occurrence,
          },
        ],
        new Date('2026-05-01T00:00:00.000Z'),
        '2026-07-01T00:00:00.000Z',
      ),
    ).toMatchObject({ status: 'incomplete', reasonCode: 'inventory_invalid' });
  });

  it('requires published document and version status and supports brand confirmation fallback', () => {
    const base = {
      channel: 'email',
      key: 'order-confirmed',
      publishedVersionId: 'ver_1',
      publishedVersionStatus: 'published',
    };
    expect(
      evaluateLifecycleContent([{ ...base, eventId: null, status: 'published' }], 'evt_1'),
    ).toEqual({ publicContent: false, confirmationContent: true });
    expect(
      evaluateLifecycleContent([{ ...base, eventId: 'evt_1', status: 'archived' }], 'evt_1'),
    ).toEqual({ publicContent: false, confirmationContent: false });
    expect(
      evaluateLifecycleContent(
        [
          {
            ...base,
            eventId: 'evt_1',
            status: 'published',
            publishedVersionStatus: 'draft',
          },
        ],
        'evt_1',
      ),
    ).toEqual({ publicContent: false, confirmationContent: false });
  });
});
