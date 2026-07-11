import { describe, expect, test } from 'vitest';
import { eventbriteApiV3Fixture } from '../fixture.js';
import { EVENTBRITE_ADAPTER_METADATA, eventbriteAdapter } from '../index.js';

const context = { tenantId: 'tenant-test', organizationId: 'organization-test' };

describe('Eventbrite migration adapter', () => {
  test('discovers mapped official resources and reports known losses', async () => {
    const discovery = await eventbriteAdapter.discover(eventbriteApiV3Fixture, context);
    expect(discovery.source).toEqual({
      sourceSystem: 'eventbrite',
      sourceVersion: 'v3',
      accountId: 'org_10001',
    });
    expect(discovery.entities.find(({ type }) => type === 'event')?.estimatedRows).toBe(1);
    expect(discovery.unsupportedFeatures).toEqual(EVENTBRITE_ADAPTER_METADATA.knownLosses);
  });

  test('extracts with a stable resumable cursor and normalizes financial history safely', async () => {
    const discovery = await eventbriteAdapter.discover(eventbriteApiV3Fixture, context);
    const first = await eventbriteAdapter.extract({
      configuration: eventbriteApiV3Fixture,
      discovery,
      limit: 3,
      context,
    });
    expect(first.nextCursor).toBe('eventbrite-v1:3');
    const second = await eventbriteAdapter.extract({
      configuration: eventbriteApiV3Fixture,
      discovery,
      cursor: first.nextCursor,
      limit: 100,
      context,
    });
    const payment = second.rows.find(({ entityType }) => entityType === 'historical-payment');
    expect(payment).toBeDefined();
    const normalized = await eventbriteAdapter.normalize(payment!, context);
    expect(normalized.financialSnapshot).toMatchObject({
      sideEffects: 'suppressed',
      reconciliationStatus: 'unreconciled',
      providerReference: 'SANITIZED-PAYMENT-701',
    });
    expect(normalized.dependencies).toEqual([
      { entityType: 'historical-order', externalId: 'ord_301' },
    ]);
    expect(await eventbriteAdapter.validate(normalized, context)).toEqual([]);
  });

  test('rejects malformed and out-of-range cursors', async () => {
    const discovery = await eventbriteAdapter.discover(eventbriteApiV3Fixture, context);
    await expect(
      eventbriteAdapter.extract({
        configuration: eventbriteApiV3Fixture,
        discovery,
        cursor: 'eventbrite-v1:999',
        limit: 10,
        context,
      }),
    ).rejects.toThrow('out of range');
  });
});
