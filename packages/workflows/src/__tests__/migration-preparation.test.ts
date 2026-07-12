import { describe, expect, it } from 'vitest';
import {
  SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
  SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
  eventbriteAdapter,
  hiEventsMigrationAdapter,
  pretixMigrationAdapter,
  ticketTailorAdapter,
  type EventbriteConfiguration,
  type TicketTailorConfiguration,
  type MigrationAdapter,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import {
  assertSafeMigrationOrigin,
  buildMigrationAdapterApiPage,
  createPinnedMigrationFetch,
  decodeMigrationPreparationCursor,
  encodeMigrationPreparationCursor,
  encryptMigrationPreparationCursor,
  decryptMigrationPreparationCursor,
  migrationApiResourcePlan,
  isBlockedMigrationAddress,
  migrationAuthorizationHeader,
  migrationPaginationCursor,
  migrationCursorKeyringFromEnvironment,
  readMigrationArtifactBody,
  readMigrationJsonResponse,
} from '../activities/migration-preparation.js';

describe('migration source origin policy', () => {
  it('fails closed for local, credential-bearing, insecure, and nonstandard-port origins', async () => {
    await expect(assertSafeMigrationOrigin('http://example.com')).rejects.toThrow(
      'MIGRATION_SOURCE_ORIGIN_REJECTED',
    );
    await expect(assertSafeMigrationOrigin('https://user:pass@example.com')).rejects.toThrow(
      'MIGRATION_SOURCE_ORIGIN_REJECTED',
    );
    await expect(assertSafeMigrationOrigin('https://localhost')).rejects.toThrow(
      'MIGRATION_SOURCE_ORIGIN_REJECTED',
    );
    await expect(assertSafeMigrationOrigin('https://127.0.0.1')).rejects.toThrow(
      'MIGRATION_SOURCE_ORIGIN_REJECTED',
    );
    await expect(assertSafeMigrationOrigin('https://example.com:8443')).rejects.toThrow(
      'MIGRATION_SOURCE_ORIGIN_REJECTED',
    );
  });

  it('rejects mapped, translation, multicast, documentation, and private address ranges', () => {
    for (const address of [
      '127.0.0.1',
      '100.64.0.1',
      '192.0.0.8',
      '192.88.99.1',
      '203.0.113.1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::7f00:1',
      '64:ff9b:1::7f00:1',
      '2002:7f00:1::',
      '2001:0:4136:e378::',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      '2001:1::1',
    ]) {
      expect(isBlockedMigrationAddress(address)).toBe(true);
    }
    expect(isBlockedMigrationAddress('8.8.8.8')).toBe(false);
    expect(isBlockedMigrationAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('revalidates and rejects a DNS rebinding answer at connection time', async () => {
    let resolution = 0;
    const resolveHost = (async () => {
      resolution += 1;
      return resolution === 1
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    }) as never;
    await expect(
      assertSafeMigrationOrigin('https://source.example', resolveHost),
    ).resolves.toBeDefined();
    await expect(
      createPinnedMigrationFetch(resolveHost)('https://source.example/data'),
    ).rejects.toThrow('MIGRATION_SOURCE_ORIGIN_REJECTED');
  });

  it('uses source-specific authorization without accepting header injection', () => {
    expect(migrationAuthorizationHeader('pretix', 'token')).toBe('Token token');
    expect(migrationAuthorizationHeader('eventbrite', 'token')).toBe('Bearer token');
    expect(migrationAuthorizationHeader('hi-events', 'token')).toBe('Bearer token');
    expect(migrationAuthorizationHeader('ticket-tailor', 'token')).toBe('Basic dG9rZW46');
    expect(() => migrationAuthorizationHeader('pretix', 'token\r\nInjected: yes')).toThrow();
  });

  it('fails before buffering oversized HTTP and streamed object bodies', async () => {
    await expect(
      readMigrationJsonResponse(
        new Response('{}', {
          headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
        }),
      ),
    ).rejects.toThrow('MIGRATION_SOURCE_PAGE_TOO_LARGE');
    async function* oversized() {
      yield new Uint8Array(4);
      yield new Uint8Array(4);
    }
    await expect(readMigrationArtifactBody(oversized(), 7)).rejects.toThrow(
      'MIGRATION_ARTIFACT_TOO_LARGE',
    );
  });

  it('retains only allowlisted same-origin pagination coordinates', () => {
    expect(
      migrationPaginationCursor(
        {
          next: 'https://api.example.test/resources?page=2&access_token=secret&filter=all',
        },
        'https://api.example.test',
      ),
    ).toBe('page=2');
    expect(() =>
      migrationPaginationCursor(
        { next: 'https://attacker.example/resources?page=2' },
        'https://api.example.test',
      ),
    ).toThrow('MIGRATION_SOURCE_CURSOR_ORIGIN_REJECTED');
  });

  it('stores authenticated encrypted cursor state and rejects tampering', () => {
    const key = Buffer.alloc(32, 9);
    const previous = Buffer.alloc(32, 8);
    const scope = {
      tenantId: 'tenant',
      organizationId: 'organization',
      jobId: 'job',
      sourceSystem: 'pretix',
    };
    const keyring = {
      currentKeyId: 'current',
      keys: { current: key, previous },
    };
    const raw = encodeMigrationPreparationCursor({
      resourceIndex: 3,
      upstreamCursor: 'continuation=opaque-token',
    });
    const encrypted = encryptMigrationPreparationCursor(raw, keyring, scope);
    expect(encrypted).not.toContain('opaque-token');
    expect(decryptMigrationPreparationCursor(encrypted, keyring, scope)).toBe(raw);
    expect(() => decryptMigrationPreparationCursor(`${encrypted}x`, keyring, scope)).toThrow(
      'MIGRATION_CURSOR_INVALID',
    );
    expect(() =>
      decryptMigrationPreparationCursor(encrypted, keyring, {
        ...scope,
        jobId: 'other-job',
      }),
    ).toThrow('MIGRATION_CURSOR_INVALID');
    expect(() =>
      decryptMigrationPreparationCursor(encrypted, keyring, {
        ...scope,
        organizationId: 'other-organization',
      }),
    ).toThrow('MIGRATION_CURSOR_INVALID');

    const rotated = encryptMigrationPreparationCursor(
      raw,
      { currentKeyId: 'previous', keys: keyring.keys },
      scope,
    );
    expect(decryptMigrationPreparationCursor(rotated, keyring, scope)).toBe(raw);
  });

  it('loads an active write key and retains previous read keys across restart rotation', () => {
    const oldKey = Buffer.alloc(32, 1).toString('base64');
    const newKey = Buffer.alloc(32, 2).toString('base64');
    const scope = {
      tenantId: 'tenant',
      organizationId: 'organization',
      jobId: 'job',
      sourceSystem: 'eventbrite',
    };
    const beforeRestart = migrationCursorKeyringFromEnvironment({
      TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID: '2026-06',
      TIXKIT_MIGRATION_CURSOR_KEYS: JSON.stringify({ '2026-06': oldKey }),
    });
    const oldCursor = encryptMigrationPreparationCursor('opaque', beforeRestart, scope);
    const afterRestart = migrationCursorKeyringFromEnvironment({
      TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID: '2026-07',
      TIXKIT_MIGRATION_CURSOR_KEYS: JSON.stringify({
        '2026-07': newKey,
        '2026-06': oldKey,
      }),
    });
    expect(decryptMigrationPreparationCursor(oldCursor, afterRestart, scope)).toBe('opaque');
    expect(encryptMigrationPreparationCursor('next', afterRestart, scope)).toMatch(
      /^v2\.2026-07\./,
    );
    expect(() =>
      decryptMigrationPreparationCursor(
        oldCursor,
        migrationCursorKeyringFromEnvironment({
          TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID: '2026-07',
          TIXKIT_MIGRATION_CURSOR_KEYS: JSON.stringify({ '2026-07': newKey }),
        }),
        scope,
      ),
    ).toThrow('MIGRATION_CURSOR_INVALID');
  });
});

describe('migration official API resource plans', () => {
  it('covers every pretix collection and preserves exact official cursor coordinates', () => {
    const plan = migrationApiResourcePlan({
      sourceMode: 'official-api',
      sourceSystem: 'pretix',
      organizerSlug: 'organizer',
      eventSlugs: ['event-a'],
    });
    expect(plan.resources.map(({ resource }) => resource)).toEqual([
      'organizers',
      'events',
      'quotas',
      'items',
      'questions',
      'vouchers',
      'orders',
      'checkinlists',
    ]);
    const cursor = encodeMigrationPreparationCursor({
      resourceIndex: 6,
      upstreamCursor: 'official-page-token',
      adapterCursor: 'orders#offset=50',
    });
    expect(decodeMigrationPreparationCursor(cursor)).toEqual({
      resourceIndex: 6,
      upstreamCursor: 'official-page-token',
      adapterCursor: 'orders#offset=50',
    });
  });

  it('uses configured event scopes across Hi.Events, Eventbrite, and Ticket Tailor', () => {
    const hi = migrationApiResourcePlan({
      sourceMode: 'official-api',
      sourceSystem: 'hi-events',
      accountId: 'account',
      eventIds: ['event-1'],
    });
    expect(hi.resources.map(({ resource }) => resource)).toEqual(
      expect.arrayContaining(['products', 'orders', 'check-ins']),
    );
    const eventbrite = migrationApiResourcePlan({
      sourceMode: 'official-api',
      sourceSystem: 'eventbrite',
      organizationId: 'org-1',
      eventIds: ['event-1'],
    });
    expect(eventbrite.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'ticket_class',
          path: '/v3/events/event-1/ticket_classes/',
        }),
        expect.objectContaining({ path: '/v3/events/event-1/orders/' }),
      ]),
    );
    expect(eventbrite.resources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/v3/organizations/org-1/attendees/' }),
        expect.objectContaining({
          path: '/v3/organizations/org-1/ticket_classes/',
        }),
      ]),
    );
    const ticketTailor = migrationApiResourcePlan({
      sourceMode: 'official-api',
      sourceSystem: 'ticket-tailor',
      accountId: 'account',
      eventIds: ['event-1'],
    });
    expect(ticketTailor.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: 'issued_ticket' }),
        expect.objectContaining({
          resource: 'check_in',
          query: { event_id: 'event-1' },
        }),
      ]),
    );
  });

  it.each([
    {
      sourceSystem: 'pretix' as const,
      source: {
        sourceMode: 'official-api' as const,
        sourceSystem: 'pretix' as const,
        organizerSlug: 'sample-organizer',
        eventSlugs: ['sample-event'],
      },
      fixture: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      adapter: pretixMigrationAdapter as MigrationAdapter<unknown, string>,
    },
    {
      sourceSystem: 'hi-events' as const,
      source: {
        sourceMode: 'official-api' as const,
        sourceSystem: 'hi-events' as const,
        accountId: 'sample-account',
        eventIds: ['event-1'],
      },
      fixture: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      adapter: hiEventsMigrationAdapter as MigrationAdapter<unknown, string>,
    },
  ])(
    'converts native $sourceSystem API pages without fixture-envelope entity fields',
    async ({ source, fixture, adapter }) => {
      const context = { tenantId: 'tenant', organizationId: 'organization' };
      const normalized: NormalizedMigrationEntity[] = [];
      const records: Array<{
        resource?: string;
        collection?: string;
        body: Readonly<Record<string, unknown>>;
      }> = [];
      for (const page of fixture.pages) {
        for (const record of page.records as readonly unknown[]) {
          records.push(
            record as {
              resource?: string;
              collection?: string;
              body: Readonly<Record<string, unknown>>;
            },
          );
        }
      }
      const resourceKey = source.sourceSystem === 'pretix' ? 'resource' : 'collection';
      const resources = new Map<string, Record<string, unknown>[]>();
      for (const record of records) {
        const resource = String(record[resourceKey]);
        const bodies = resources.get(resource) ?? [];
        bodies.push(record.body as Record<string, unknown>);
        resources.set(resource, bodies);
      }
      let pageIndex = 0;
      for (const [resource, bodies] of resources) {
        const configuration = buildMigrationAdapterApiPage(
          source,
          { results: bodies },
          `native-page-${pageIndex++}`,
          resource,
        );
        const discovery = await adapter.discover(configuration, context);
        const extracted = await adapter.extract({
          configuration,
          discovery,
          limit: 100,
          context,
        });
        for (const row of extracted.rows) {
          const entity = await adapter.normalize(row, context);
          expect(await adapter.validate(entity, context)).toEqual([]);
          normalized.push(entity);
        }
      }
      expect(normalized).toHaveLength(18);
      const types = new Set(normalized.map(({ entityType }) => entityType));
      expect(types.has('historical-payment')).toBe(true);
      expect(types.has('historical-refund')).toBe(true);
      expect(types.has('check-in')).toBe(true);
    },
  );

  it('transforms official Eventbrite expanded orders into order, attendee, and ticket rows', async () => {
    const page = buildMigrationAdapterApiPage(
      {
        sourceMode: 'official-api',
        sourceSystem: 'eventbrite',
        organizationId: 'org-1',
        eventIds: ['event-1'],
      },
      {
        orders: [
          {
            id: 'order-1',
            event_id: 'event-1',
            order_number: '101',
            total_minor: 2500,
            attendees: [
              {
                id: 'attendee-1',
                ticket_class_id: 'ticket-class-1',
                profile: { email: 'redacted@example.test' },
                barcodes: [{ barcode: 'REDACTED-CODE' }],
              },
            ],
          },
        ],
        pagination: {},
      },
      'resource-4-page-deadbeef',
      'order',
    );
    const context = { tenantId: 'tenant', organizationId: 'organization' };
    const configuration = page as EventbriteConfiguration;
    const discovery = await eventbriteAdapter.discover(configuration, context);
    const extracted = await eventbriteAdapter.extract({
      configuration,
      discovery,
      limit: 100,
      context,
    });
    expect(extracted.rows.map(({ entityType }) => entityType)).toEqual([
      'historical-order',
      'attendee',
      'ticket',
    ]);
    const ticket = await eventbriteAdapter.normalize(extracted.rows[2]!, context);
    expect(ticket.dependencies).toEqual(
      expect.arrayContaining([
        { entityType: 'event', externalId: 'event-1' },
        { entityType: 'historical-order', externalId: 'order-1' },
        { entityType: 'attendee', externalId: 'attendee-1' },
        { entityType: 'ticket-type', externalId: 'ticket-class-1' },
      ]),
    );
  });

  it('accepts exact Ticket Tailor list envelopes and preserves official cursor coordinates', async () => {
    const page = buildMigrationAdapterApiPage(
      {
        sourceMode: 'official-api',
        sourceSystem: 'ticket-tailor',
        accountId: 'account-1',
        eventIds: ['event-1'],
      },
      {
        data: [
          {
            id: 'ticket-1',
            event_id: 'event-1',
            order_id: 'order-1',
            ticket_type_id: 'type-1',
            attendee_id: 'ticket-1:attendee',
            attendee_email: 'redacted@example.test',
            barcode: 'REDACTED-CODE',
          },
        ],
        links: { next: null },
      },
      'resource-3-page-cafebabe',
      'issued_ticket',
    );
    const context = { tenantId: 'tenant', organizationId: 'organization' };
    const configuration = page as TicketTailorConfiguration;
    const discovery = await ticketTailorAdapter.discover(configuration, context);
    const extracted = await ticketTailorAdapter.extract({
      configuration,
      discovery,
      limit: 100,
      context,
    });
    expect(extracted.rows.map(({ entityType }) => entityType)).toEqual(['attendee', 'ticket']);
    expect(extracted.nextCursor).toBeUndefined();
  });
});
