import { describe, expect, test } from 'vitest';
import { ticketTailorApiV1Fixture } from '../fixture.js';
import { TICKET_TAILOR_ADAPTER_METADATA, ticketTailorAdapter } from '../index.js';

const context = { tenantId: 'tenant-test', organizationId: 'organization-test' };

describe('Ticket Tailor migration adapter', () => {
  test('discovers deterministic source coverage and known losses', async () => {
    const discovery = await ticketTailorAdapter.discover(ticketTailorApiV1Fixture, context);
    expect(discovery.source.sourceSystem).toBe('ticket-tailor');
    expect(discovery.entities.find(({ type }) => type === 'ticket')?.estimatedRows).toBe(1);
    expect(discovery.unsupportedFeatures).toEqual(TICKET_TAILOR_ADAPTER_METADATA.knownLosses);
  });

  test('resumes extraction and preserves historical financial provenance', async () => {
    const discovery = await ticketTailorAdapter.discover(ticketTailorApiV1Fixture, context);
    const first = await ticketTailorAdapter.extract({
      configuration: ticketTailorApiV1Fixture,
      discovery,
      limit: 2,
      context,
    });
    expect(first.nextCursor).toBe('ticket-tailor-v1:2');
    const remaining = await ticketTailorAdapter.extract({
      configuration: ticketTailorApiV1Fixture,
      discovery,
      cursor: first.nextCursor,
      limit: 100,
      context,
    });
    const payment = remaining.rows.find(({ entityType }) => entityType === 'historical-payment')!;
    const normalized = await ticketTailorAdapter.normalize(payment, context);
    expect(normalized.financialSnapshot).toMatchObject({
      amountMinor: 3400,
      currency: 'USD',
      sideEffects: 'suppressed',
      reconciliationStatus: 'unreconciled',
    });
    expect(normalized.dependencies).toEqual([
      { entityType: 'historical-order', externalId: 'ord_310' },
    ]);
  });

  test('reports required-field validation errors', async () => {
    const normalized = await ticketTailorAdapter.normalize(
      {
        externalId: 'tt-bad',
        entityType: 'ticket-type',
        sourcePosition: 'fixture:1',
        data: { migrationResource: 'ticket_type', name: 'Missing event' },
      },
      context,
    );
    expect(await ticketTailorAdapter.validate(normalized, context)).toContainEqual(
      expect.objectContaining({ code: 'TICKET_TAILOR_REQUIRED_FIELD', field: 'event_id' }),
    );
  });
});
