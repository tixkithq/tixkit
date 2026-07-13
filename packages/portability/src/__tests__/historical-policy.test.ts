import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalPortableJson,
  createPortableHistoricalPayloadPolicies,
  portableHistoricalPolicyDescriptor,
} from '../index.js';

describe('portable historical payload policy', () => {
  it('accepts side-effect-suppressed financial snapshots and rejects mutable or secret fields', () => {
    const policies = createPortableHistoricalPayloadPolicies();
    const payment = {
      portableId: 'payment_01',
      attributes: {
        status: 'succeeded',
        provider: 'stripe',
        createdAt: '2026-07-12T20:00:00.000Z',
        updatedAt: '2026-07-12T20:00:00.000Z',
      },
      dependencies: [{ section: 'orders', portableId: 'order_01' }],
      financialSnapshot: {
        kind: 'historical-payment',
        amountMinor: 4200,
        currency: 'USD',
        occurredAt: '2026-07-12T20:00:00.000Z',
        provenance: {
          sourceSystem: 'tixkit-portable',
          sourceExternalId: 'payment_01',
          importedAt: '2026-07-12T20:00:00.000Z',
        },
        reconciliationStatus: 'reconciled',
        sideEffects: 'suppressed',
      },
    } as const;

    expect(policies.get('payments')?.validateRecord('payments', payment)).toBe(true);
    expect(
      policies.get('payments')?.validateRecord('payments', {
        ...payment,
        attributes: { ...payment.attributes, clientSecret: 'must-not-export' },
      }),
    ).toBe(false);
    expect(
      policies.get('payments')?.validateRecord('payments', {
        ...payment,
        financialSnapshot: { ...payment.financialSnapshot, providerReference: 'pm_reusable_01' },
      }),
    ).toBe(false);
    expect(
      policies.get('payments')?.validateRecord('payments', {
        ...payment,
        dependencies: [],
      }),
    ).toBe(false);
    expect(
      policies.get('payments')?.validateRecord('payments', {
        ...payment,
        financialSnapshot: { ...payment.financialSnapshot, sideEffects: 'enabled' },
      }),
    ).toBe(false);
    expect(policies.get('orders')?.validateRecord('orders', payment)).toBe(false);
  });

  it('requires exact bounded historical attributes', () => {
    const policy = createPortableHistoricalPayloadPolicies().get('buyers')!;
    const buyer = {
      portableId: 'buyer_01',
      attributes: {
        email: 'buyer@example.test',
        firstName: null,
        lastName: null,
        phone: null,
        createdAt: '2026-07-12T20:00:00.000Z',
        updatedAt: '2026-07-12T20:00:00.000Z',
      },
    };
    expect(policy.validateRecord('buyers', buyer)).toBe(true);
    expect(
      policy.validateRecord('buyers', {
        ...buyer,
        attributes: { ...buyer.attributes, createdAt: 'not-a-date' },
      }),
    ).toBe(false);
    expect(
      policy.validateRecord('buyers', {
        ...buyer,
        attributes: { ...buyer.attributes, providerToken: 'tok_live' },
      }),
    ).toBe(false);

    const ticketPolicy = createPortableHistoricalPayloadPolicies().get('tickets')!;
    const ticket = {
      portableId: 'ticket_01',
      attributes: {
        codeSha256: 'a'.repeat(64),
        status: 'valid',
        transferredToEmail: null,
        transferredAt: null,
        checkedInAt: null,
        createdAt: '2026-07-12T20:00:00.000Z',
        updatedAt: '2026-07-12T20:00:00.000Z',
      },
      dependencies: [
        { section: 'events', portableId: 'event_01' },
        { section: 'ticket_types', portableId: 'ticket_type_01' },
        { section: 'attendees', portableId: 'attendee_01' },
        { section: 'orders', portableId: 'order_01' },
      ],
    } as const;
    expect(ticketPolicy.validateRecord('tickets', ticket)).toBe(true);
    expect(
      ticketPolicy.validateRecord('tickets', {
        ...ticket,
        attributes: { ...ticket.attributes, codeSha256: null },
      }),
    ).toBe(false);
  });

  it('binds dependency, financial, token, and side-effect semantics into the policy hash', () => {
    const policy = createPortableHistoricalPayloadPolicies().get('payments')!;
    const descriptor = portableHistoricalPolicyDescriptor('payments');
    expect(createHash('sha256').update(canonicalPortableJson(descriptor)).digest('hex')).toBe(
      policy.policySha256,
    );
    expect(
      createHash('sha256')
        .update(
          canonicalPortableJson({
            ...descriptor,
            financialSnapshot: { ...descriptor.financialSnapshot, sideEffects: 'enabled' },
          }),
        )
        .digest('hex'),
    ).not.toBe(policy.policySha256);
    expect(
      createHash('sha256')
        .update(canonicalPortableJson({ ...descriptor, dependencies: { required: [] } }))
        .digest('hex'),
    ).not.toBe(policy.policySha256);
  });
});
