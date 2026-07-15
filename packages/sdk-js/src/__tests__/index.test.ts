import { afterEach, describe, it, expect, expectTypeOf, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TixkitClient,
  TixkitApiError,
  isLaunchReadinessFailure,
  isArchivedEventFailure,
  isStaleEventVersionFailure,
  MAX_OFFLINE_MANIFEST_TICKETS,
  type AdminTablePage,
  type BrandSenderIdentity,
  type ContentRenderArtifact,
  type EmailTemplateDocument,
  type EventPageDocumentV2,
  type Event,
  type OfflineManifest,
  type OAuthApplication,
  type Order,
  type OrderDetail,
  type PrivacyRequestInput,
  type PublicAvailabilityItem,
  type PublicCheckoutBootstrap,
  type PublicContentPage,
  type PublicEvent,
  type PublicEventPageBootstrap,
  type PuckData,
  type SmsTemplateDocument,
  type UploadArtifactDownload,
  type UploadPurpose,
  type CreateUploadArtifactInput,
  type WebhookEvent,
  type CreateMigrationJobInput,
  type AgentPlanDefinition,
  type AgentEventPrepareResolvedChanges,
} from '../index.js';

const validResolvedEventMedia: AgentEventPrepareResolvedChanges = {
  coverImageUrl: '/v1/public/event-media/event_cover/upl_example',
  seo: { imageUrl: '/v1/public/event-media/social/upl_example' },
};
void validResolvedEventMedia;
const invalidResolvedEventMedia: AgentEventPrepareResolvedChanges = {
  // @ts-expect-error Resolved event media must be an owned Tixkit media reference.
  coverImageUrl: 'https://unowned.example/cover.jpg',
};
void invalidResolvedEventMedia;

function mockFetch(status: number, body: unknown) {
  const init: ResponseInit = {
    status,
    headers: { 'Content-Type': 'application/json' },
  };
  if (status !== 204) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(body), init));
  }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, init));
}

function getCall(fetchMock: ReturnType<typeof vi.spyOn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index]!;
  return {
    url: String(url),
    method: init?.method,
    body: init?.body as string,
    headers: init?.headers as Record<string, string>,
  };
}

function acceptMigrationJobInput(_input: CreateMigrationJobInput): void {}

acceptMigrationJobInput({
  organizationId: 'org_1',
  sourceSystem: 'pretix',
  adapterVersion: 'api-v1',
  credentialId: 'mcred_12345678',
  idempotencyKey: 'bad-source',
  configuration: {
    sourceMode: 'official-api',
    sourceSystem: 'hi-events',
    // @ts-expect-error The outer and nested migration source systems must match.
    accountId: 'acct',
    eventIds: ['evt'],
  },
});
acceptMigrationJobInput({
  organizationId: 'org_1',
  sourceSystem: 'pretix',
  adapterVersion: 'api-v1',
  credentialId: 'mcred_12345678',
  idempotencyKey: 'missing-selector',
  // @ts-expect-error pretix official API jobs require a non-optional eventSlugs selector.
  configuration: {
    sourceMode: 'official-api',
    sourceSystem: 'pretix',
    organizerSlug: 'org',
  },
});
// @ts-expect-error Export jobs must not carry source API credential references.
acceptMigrationJobInput({
  organizationId: 'org_1',
  sourceSystem: 'generic-csv',
  adapterVersion: 'rfc4180-v1',
  credentialId: 'mcred_12345678',
  idempotencyKey: 'export-secret',
  configuration: {
    sourceMode: 'official-export',
    sourceSystem: 'generic-csv',
    artifactIds: ['upl_12345678'],
  },
});

describe('TixkitClient', () => {
  it('sends explicit test checkout mode only as a header', async () => {
    const fetchMock = mockFetch(201, { id: 'cs_1' });
    const client = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      buyer: { email: 'test@example.test' },
      idempotencyKey: 'test-order-1',
      testOrder: true,
    });
    const call = getCall(fetchMock);
    expect(call.headers['X-Tixkit-Test-Order']).toBe('1');
    expect(JSON.parse(call.body)).not.toHaveProperty('testOrder');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should construct with default config', () => {
    const client = new TixkitClient({ apiKey: 'tk_test_123' });
    expect(client).toBeDefined();
    expect(client.checkout).toBeDefined();
    expect(client.events).toBeDefined();
    expect(client.orders).toBeDefined();
    expect(client.tickets).toBeDefined();
  });

  it('supports human bearer access tokens without ambiguous dual credentials', async () => {
    const fetchMock = mockFetch(200, { id: 'agt_1' });
    const client = new TixkitClient({
      accessToken: 'human-session-token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.agentControl.getPrincipal('agt_1');
    expect(getCall(fetchMock).headers.Authorization).toBe('Bearer human-session-token');
    expect(
      () =>
        new TixkitClient({
          apiKey: 'tk_test',
          accessToken: 'human-session-token',
        }),
    ).toThrow('Configure either apiKey or accessToken, not both');
  });

  it('covers every migration file, mapping, and report route with typed methods', async () => {
    const fetchMock = mockFetch(200, { items: [] });
    const client = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await client.migrations.files('job_1');
    await client.migrations.mappings({
      organizationId: 'org_1',
      sourceSystem: 'pretix',
    });
    await client.migrations.createMapping({
      organizationId: 'org_1',
      sourceSystem: 'generic-csv',
      name: 'Attendee columns',
      entityType: 'attendee',
      mapping: { email: 'email_address', tags: ['tag_1', 'tag_2'] },
    });
    await client.migrations.downloadReport('job_1');

    expect(fetchMock.mock.calls.map((_, index) => getCall(fetchMock, index))).toMatchObject([
      { method: 'GET', url: 'https://api.test/v1/migration-jobs/job_1/files' },
      {
        method: 'GET',
        url: 'https://api.test/v1/migration-mappings?organizationId=org_1&sourceSystem=pretix',
      },
      { method: 'POST', url: 'https://api.test/v1/migration-mappings' },
      {
        method: 'GET',
        url: 'https://api.test/v1/migration-jobs/job_1/report/download',
      },
    ]);
  });

  it('creates signed portability jobs through the additive dedicated endpoint', async () => {
    const fetchMock = mockFetch(201, { id: 'job_portable_1' });
    const client = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.migrations.createPortable({
      organizationId: 'org_1',
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v2',
      idempotencyKey: 'portable-job-1',
      configuration: {
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: ['upl_12345678'],
      },
    });
    expect(getCall(fetchMock)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/portable-migration-jobs',
      headers: { 'Idempotency-Key': 'portable-job-1' },
    });
  });

  it('grants, revokes, and consumes typed historical export authorization', async () => {
    const authorization = {
      authorizationId: 'pexa_12345678',
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      grantedByPrincipalId: 'user_1',
      grantedAt: '2026-07-16T12:00:00.000Z',
      expiresAt: '2026-07-16T12:10:00.000Z',
      scope: 'tenant-historical-portability',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(authorization), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.tixkit.portable+json' },
        }),
      );
    const client = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(
      client.portability.grantHistoricalExportAuthorization({
        organizationId: 'org_1',
        expiresAt: authorization.expiresAt,
      }),
    ).resolves.toEqual(authorization);
    await expect(
      client.portability.revokeHistoricalExportAuthorization('pexa_unused_01', 'org_1'),
    ).resolves.toBeUndefined();
    const response = await client.portability.createExport({
      organizationId: 'org_1',
      mode: 'historical',
      authorizationId: authorization.authorizationId,
      idempotencyKey: 'historical-export-1',
    });
    await expect(response.arrayBuffer()).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer);

    expect(getCall(fetchMock, 0)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/portable-export-authorizations',
      body: JSON.stringify({
        organizationId: 'org_1',
        expiresAt: authorization.expiresAt,
      }),
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/portable-export-authorizations/pexa_unused_01/revoke',
      body: JSON.stringify({ organizationId: 'org_1' }),
    });
    expect(getCall(fetchMock, 2)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/portable-exports',
      headers: { 'Idempotency-Key': 'historical-export-1' },
      body: JSON.stringify({
        organizationId: 'org_1',
        mode: 'historical',
        authorizationId: authorization.authorizationId,
      }),
    });
  });

  it('creates an exact-parent final delta export', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Uint8Array.from([4, 5, 6]), {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.tixkit.portable+json' },
      }),
    );
    const client = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const cutoverFreeze = {
      frozenAt: '2026-07-17T12:00:00.000Z',
      receiptSha256: 'a'.repeat(64),
    };
    await client.portability.createExport({
      organizationId: 'org_1',
      mode: 'configuration',
      parentExportJobId: 'pex_parent_01',
      cutoverFreeze,
      idempotencyKey: 'final-delta-1',
    });
    expect(getCall(fetchMock)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/portable-delta-exports',
      headers: { 'Idempotency-Key': 'final-delta-1' },
      body: JSON.stringify({
        organizationId: 'org_1',
        mode: 'configuration',
        parentExportJobId: 'pex_parent_01',
        cutoverFreeze,
      }),
    });
  });

  it('binds portable commit to the exact approval and final cutover proof', async () => {
    const fetchMock = mockFetch(202, {
      jobId: 'job_portable_1',
      status: 'committing',
    });
    const client = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const cutoverProof = {
      tenantId: 'tenant_source',
      deploymentId: 'deployment_source',
      sourceChangeCursor: 'cursor_02',
      observedAt: '2026-07-12T23:00:00.000Z',
      sourceFrozen: true,
      bundleId: 'bundle_01',
      manifestSha256: 'a'.repeat(64),
      destinationId: 'deployment_destination',
      operationId: 'operation_01',
      issuedAt: '2026-07-12T23:00:00.000Z',
      expiresAt: '2026-07-12T23:05:00.000Z',
      nonce: 'cutover_nonce_01',
      receiptSha256: 'b'.repeat(64),
      keyId: 'cutover_key_01',
      signature: 'signed-proof',
    };
    await client.migrations.commitPortable(
      'job_portable_1',
      `commit:job_portable_1:approval_01:${'c'.repeat(64)}`,
      cutoverProof,
    );
    const call = getCall(fetchMock);
    expect(call).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/migration-jobs/job_portable_1/commit',
      headers: {
        'x-tixkit-confirmation': `commit:job_portable_1:approval_01:${'c'.repeat(64)}`,
      },
    });
    expect(JSON.parse(call.body)).toEqual({ cutoverProof });
  });

  it('correlates migration job source systems with their preparation selectors', () => {
    const input: CreateMigrationJobInput = {
      organizationId: 'org_1',
      sourceSystem: 'pretix',
      adapterVersion: '1',
      credentialId: 'mcred_12345678',
      configuration: {
        sourceMode: 'official-api',
        sourceSystem: 'pretix',
        organizerSlug: 'org',
        eventSlugs: ['event'],
      },
      idempotencyKey: 'migration-1',
    };
    expect(input.configuration.sourceSystem).toBe(input.sourceSystem);
  });

  it('keeps readiness endpoints in SDK parity', async () => {
    const fetchMock = mockFetch(200, {
      eventId: 'evt_1',
      launchable: false,
      requiredBlockers: [],
      recommendedWarnings: [],
      steps: [],
    });
    const client = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await client.events.launchReadiness('evt_1');
    expect(getCall(fetchMock)).toMatchObject({
      method: 'GET',
      url: 'https://api.test/v1/events/evt_1/launch-readiness',
    });
  });

  it('keeps scoped event media attachment endpoints in SDK parity', async () => {
    const fetchMock = mockFetch(200, []);
    const client = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await client.events.listMedia('evt_1');
    expect(getCall(fetchMock)).toMatchObject({
      method: 'GET',
      url: 'https://api.test/v1/events/evt_1/media',
    });

    await client.events.attachMedia('evt_1', 'poster', {
      uploadArtifactId: 'upl_1',
      altText: 'Festival poster',
      focalPoint: { x: 0.5, y: 0.4 },
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      method: 'PUT',
      url: 'https://api.test/v1/events/evt_1/media/poster',
    });

    await client.events.removeMedia('evt_1', 'poster');
    expect(getCall(fetchMock, 2)).toMatchObject({
      method: 'DELETE',
      url: 'https://api.test/v1/events/evt_1/media/poster',
    });
  });

  it('rejects malformed readiness blocker envelopes', () => {
    const malformed = new TixkitApiError('launch_readiness_failed', 'blocked', 409, 'req_1', {
      requiredBlockers: [null] as never[],
      recommendedWarnings: [],
    });
    expect(isLaunchReadinessFailure(malformed)).toBe(false);
    const unknownReason = new TixkitApiError('launch_readiness_failed', 'blocked', 409, 'req_1', {
      requiredBlockers: [
        {
          id: 'sellable_tickets',
          status: 'incomplete',
          priority: 'required',
          reasonCodes: ['unknown_reason'],
          actionId: 'manage_tickets',
          requiredPermission: 'tickets.write',
          updatedAt: null,
          acknowledgedAt: null,
          acknowledgementValid: null,
        },
      ],
      recommendedWarnings: [],
    });
    expect(isLaunchReadinessFailure(unknownReason)).toBe(false);
  });

  it('narrows every publish conflict contract', () => {
    expect(
      isStaleEventVersionFailure(
        new TixkitApiError('stale_event_version', 'stale', 409, 'req_1', {
          expectedVersion: 2,
          currentVersion: 3,
        }),
      ),
    ).toBe(true);
    expect(
      isStaleEventVersionFailure(
        new TixkitApiError('stale_event_version', 'stale', 409, 'req_1', {}),
      ),
    ).toBe(false);
    expect(
      isArchivedEventFailure(new TixkitApiError('event_archived', 'archived', 409, 'req_1')),
    ).toBe(true);
  });

  it('supports readiness acknowledgement create and delete', async () => {
    const fetchMock = mockFetch(201, {
      eventId: 'evt_1',
      stepId: 'preview_review',
    });
    const client = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.events.acknowledgeReadinessStep('evt_1', 'preview_review');
    expect(getCall(fetchMock)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/events/evt_1/readiness-acknowledgements/preview_review',
    });

    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await client.events.removeReadinessAcknowledgement('evt_1', 'preview_review');
    expect(getCall(fetchMock, 1)).toMatchObject({
      method: 'DELETE',
      url: 'https://api.test/v1/events/evt_1/readiness-acknowledgements/preview_review',
    });
  });

  it('gets workspace readiness for the selected brand', async () => {
    const fetchMock = mockFetch(200, { complete: true, steps: [] });
    const client = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.organizations.readiness('org_1', 'brd_1');
    expect(getCall(fetchMock).url).toBe(
      'https://api.test/v1/organizations/org_1/readiness?brandId=brd_1',
    );
  });

  it('constructs a public client without an API key', () => {
    const client = new TixkitClient({ apiBaseUrl: 'https://api.test' });
    expect(client.checkout).toBeDefined();
  });

  it('rejects secret API keys in browser runtimes', () => {
    const runtime = globalThis as typeof globalThis & {
      window?: unknown;
      document?: unknown;
    };
    runtime.window = {};
    runtime.document = {};

    try {
      expect(() => new TixkitClient({ apiKey: 'tk_test_123' })).toThrow(/server-only/);
    } finally {
      delete runtime.window;
      delete runtime.document;
    }
  });

  it('should construct with custom config', () => {
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://custom.api.com',
      apiVersion: '2026-07-16',
      timeout: 5000,
      maxRetries: 1,
    });
    expect(client).toBeDefined();
  });

  it('normalizes trailing slashes from custom API base URLs', async () => {
    const fetchMock = mockFetch(200, { data: [], nextCursor: null });
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test///',
      maxRetries: 0,
    });

    await client.events.list();

    expect(getCall(fetchMock).url).toBe('https://api.test/v1/events');
  });

  it('scannerDevices.create forwards explicit device scopes', async () => {
    const fetchMock = mockFetch(201, {
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      name: 'Read only scanner',
      deviceId: 'sd_public',
      eventIds: ['evt_1'],
      scopes: ['checkins.read'],
      status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      secret: 'secret',
    });
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const created = await client.scannerDevices.create({
      organizationId: 'org_1',
      name: 'Read only scanner',
      eventIds: ['evt_1'],
      scopes: ['checkins.read'],
    });

    expect(created.secret).toBe('secret');

    const call = getCall(fetchMock);
    expect(call.url).toBe('https://api.test/v1/scanner-devices');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      organizationId: 'org_1',
      name: 'Read only scanner',
      eventIds: ['evt_1'],
      scopes: ['checkins.read'],
    });
  });

  it('scannerDevices.create allows organization-wide scanner devices', async () => {
    const fetchMock = mockFetch(201, {
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      name: 'Org scanner',
      deviceId: 'sd_public',
      eventIds: [],
      scopes: ['checkins.read', 'checkins.write'],
      status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      secret: 'secret',
    });
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const created = await client.scannerDevices.create({
      organizationId: 'org_1',
      name: 'Org scanner',
    });

    expect(created.secret).toBe('secret');

    const call = getCall(fetchMock);
    expect(call.url).toBe('https://api.test/v1/scanner-devices');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      organizationId: 'org_1',
      name: 'Org scanner',
    });
  });

  it('TixkitApiError should have correct properties', () => {
    const error = new TixkitApiError('NOT_FOUND', 'Resource not found', 404, 'req_123', {
      resource: 'event',
    });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Resource not found');
    expect(error.statusCode).toBe(404);
    expect(error.requestId).toBe('req_123');
    expect(error.details).toEqual({ resource: 'event' });
    expect(error.name).toBe('TixkitApiError');
  });

  it('wraps empty API error responses with HTTP status details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(client.events.list()).rejects.toMatchObject({
      name: 'TixkitApiError',
      code: 'HTTP_502',
      message: 'Request failed with status 502',
      statusCode: 502,
      requestId: '',
    });
  });

  it('wraps malformed API error responses without losing client-error status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream gateway error', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 3,
    });

    await expect(client.events.list()).rejects.toMatchObject({
      name: 'TixkitApiError',
      code: 'HTTP_400',
      message: 'Request failed with status 400',
      statusCode: 400,
      requestId: '',
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends caller supplied checkout idempotency key only as a header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_1',
      eventId: 'evt_1',
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
      ],
      buyer: { email: 'buyer@example.com', dateOfBirth: '1990-01-01' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(headers['Idempotency-Key']).toBe('idem_checkout_1');
    expect(body.idempotencyKey).toBeUndefined();
  });

  it('sends checkout tracking separately from affiliate attribution', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_tracking',
      eventId: 'evt_1',
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
      ],
      trackingId: 'utm-campaign-1',
      affiliateCode: 'partner-1',
      buyer: { email: 'buyer@example.com', dateOfBirth: '1990-01-01' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.trackingId).toBe('utm-campaign-1');
    expect(body.affiliateCode).toBe('partner-1');
  });

  it('sends product checkout line items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_products',
      eventId: 'evt_1',
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
        { productId: 'prd_1', quantity: 2 },
      ],
      buyer: { email: 'buyer@example.com', dateOfBirth: '1990-01-01' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.items).toEqual([
      {
        ticketTypeId: 'tt_1',
        quantity: 1,
        attendeeFields: [{ dateOfBirth: '1990-01-01' }],
      },
      { productId: 'prd_1', quantity: 2 },
    ]);
  });

  it('sends resale checkout line items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_resale',
      eventId: 'evt_1',
      items: [{ resaleListingId: 'lst_1', quantity: 1 }],
      buyer: { email: 'buyer@example.com', dateOfBirth: '1990-01-01' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.items).toEqual([{ resaleListingId: 'lst_1', quantity: 1 }]);
  });

  it('passes waitlist claim tokens through checkout create', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_waitlist',
      eventId: 'evt_1',
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
      ],
      buyer: { email: 'buyer@example.com', dateOfBirth: '1990-01-01' },
      waitlistClaimToken: 'claim_token_123',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.waitlistClaimToken).toBe('claim_token_123');
  });

  it('exposes admin waitlist list and offer helpers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [],
            settings: { autoOfferEnabled: true, offerTtlMinutes: 1440 },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entry: { id: 'wl_1' },
            claimToken: 'claim_token_123',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ autoOfferEnabled: false, offerTtlMinutes: 60 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.events.listWaitlist('evt_1');
    await client.events.offerWaitlistEntry('evt_1', 'wl_1', {
      expiresInMinutes: 30,
    });
    await client.events.updateWaitlistSettings('evt_1', {
      autoOfferEnabled: false,
      offerTtlMinutes: 60,
    });

    expect(getCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/waitlist',
      method: 'GET',
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/waitlist/wl_1/offer',
      method: 'POST',
      body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    expect(getCall(fetchMock, 2)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/waitlist/settings',
      method: 'PATCH',
      body: JSON.stringify({ autoOfferEnabled: false, offerTtlMinutes: 60 }),
    });
  });

  it('exposes public waitlist helpers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'wl_1',
            eventId: 'evt_1',
            ticketTypeId: 'tt_1',
            email: 'buyer@example.com',
            quantity: 1,
            status: 'joined',
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'wl_1',
            eventId: 'evt_1',
            ticketTypeId: 'tt_1',
            email: 'buyer@example.com',
            quantity: 1,
            status: 'offered',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.public.joinWaitlist('evt_1', {
      ticketTypeId: 'tt_1',
      email: 'buyer@example.com',
      quantity: 2,
    });
    await client.public.getWaitlistClaim('claim token');

    expect(getCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.test/v1/public/events/evt_1/waitlist',
      method: 'POST',
      body: JSON.stringify({
        ticketTypeId: 'tt_1',
        email: 'buyer@example.com',
        quantity: 2,
      }),
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      url: 'https://api.test/v1/public/waitlist/claims/claim%20token',
      method: 'GET',
    });
  });

  it('exposes admin marketing integration helpers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'mkt_1', provider: 'ga4', status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.events.listMarketingIntegrations('evt_1');
    await client.events.upsertMarketingIntegration('evt_1', 'ga4', {
      config: { measurementId: 'G-TEST123' },
      consentRequired: true,
      status: 'active',
    });

    expect(getCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/marketing-integrations',
      method: 'GET',
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/marketing-integrations/ga4',
      method: 'PUT',
      body: JSON.stringify({
        config: { measurementId: 'G-TEST123' },
        consentRequired: true,
        status: 'active',
      }),
    });
  });

  it('exposes public marketing integration helper', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ provider: 'meta_pixel', status: 'active' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await client.public.listMarketingIntegrations('evt_1');

    expect(getCall(fetchMock)).toMatchObject({
      url: 'https://api.test/v1/public/events/evt_1/marketing-integrations',
      method: 'GET',
    });
  });

  it('does not send Authorization when no API key is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [],
          nextCursor: null,
          prevCursor: null,
          total: 0,
          filterTotal: 0,
          applied: { sort: [], filters: {} },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const page = await client.events.list({
      limit: 10,
      cursor: 'evt_1',
      direction: 'prev',
      search: 'showcase',
      sort: 'createdAt:desc',
      includeFacets: true,
      includeTotal: true,
      status: 'published',
    });
    expectTypeOf(page).toEqualTypeOf<AdminTablePage<Event>>();

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe(
      'https://api.test/v1/events?cursor=evt_1&limit=10&direction=prev&search=showcase&sort=createdAt%3Adesc&includeFacets=true&includeTotal=true&status=published',
    );
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('sends Content-Type only when a JSON body is present', async () => {
    const fetchMock = mockFetch(200, { id: 'evt_1', title: 'Updated' });
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await client.events.update('evt_1', {
      title: 'Updated',
      expectedVersion: 1,
    });

    expect(getCall(fetchMock).headers['Content-Type']).toBe('application/json');
  });

  it('sends caller supplied confirm idempotency key only as a header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: 'cs_1',
          status: 'pending_payment',
          totalCents: 5000,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.confirm('cs_1', {
      idempotencyKey: 'idem_confirm_1',
      clientToken: 'cstok_1',
      paymentMethodId: 'pm_1',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(String(url)).toBe('https://api.test/v1/checkout/sessions/cs_1/confirm');
    expect(headers['Idempotency-Key']).toBe('idem_confirm_1');
    expect(headers['X-Checkout-Session-Token']).toBe('cstok_1');
    expect(body).toEqual({ paymentMethodId: 'pm_1' });
  });

  it('checkout.createBoxOfficeOrder sends POS tender body with idempotency', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          order: {
            id: 'ord_box',
            salesChannel: 'box_office',
            tenderType: 'cash',
          },
          sessionId: 'cs_box',
          status: 'completed',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.createBoxOfficeOrder('evt_box', {
      idempotencyKey: 'box_cash_1',
      tenderType: 'cash',
      amountCents: 2500,
      buyer: { email: 'door@example.com', dateOfBirth: '1990-01-01' },
      items: [
        {
          ticketTypeId: 'tt_ga',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(String(url)).toBe('https://api.test/v1/events/evt_box/box-office/orders');
    expect(headers['Idempotency-Key']).toBe('box_cash_1');
    expect(body).toEqual({
      tenderType: 'cash',
      amountCents: 2500,
      buyer: { email: 'door@example.com', dateOfBirth: '1990-01-01' },
      items: [
        {
          ticketTypeId: 'tt_ga',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
      ],
    });
  });

  it('checkout.get can recover pending sessions with a payment intent client secret', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', status: 'pending_payment' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.get('cs_1', {
      paymentIntentClientSecret: 'pi_secret_123',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;

    expect(String(url)).toBe(
      'https://api.test/v1/checkout/sessions/cs_1?payment_intent_client_secret=pi_secret_123',
    );
    expect(headers).not.toHaveProperty('X-Checkout-Session-Token');
  });

  it('checkout.get keeps the legacy token argument for session reads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', status: 'open' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.get('cs_1', 'cstok_1');

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;

    expect(String(url)).toBe('https://api.test/v1/checkout/sessions/cs_1');
    expect(headers['X-Checkout-Session-Token']).toBe('cstok_1');
  });

  it('does not retry unsafe mutations without an idempotency key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'try later',
            requestId: 'req_1',
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 2,
    });
    await expect(
      client.events.create({
        organizationId: 'org_1',
        brandId: 'brd_1',
        slug: 'launch',
        title: 'Launch',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries idempotent mutations when an idempotency key is supplied', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'try later',
              requestId: 'req_1',
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'cs_1',
            eventId: 'evt_1',
            status: 'open',
            currency: 'USD',
            quote: {
              totalCents: 1000,
              subtotalCents: 1000,
              discountCents: 0,
              taxCents: 0,
              feeCents: 0,
            },
            expiresAt: '2026-07-01T00:10:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 2,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_retry',
      eventId: 'evt_1',
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '1990-01-01' }],
        },
      ],
      buyer: { email: 'buyer@example.com', dateOfBirth: '1990-01-01' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('browser-target bundle does not contain bundled secret credentials', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tixkit-js-bundle-'));
    const outFile = path.join(tempDir, 'tixkit-js.browser.js');

    try {
      execFileSync(
        'bun',
        [
          'build',
          fileURLToPath(new URL('../index.ts', import.meta.url)),
          '--target=browser',
          '--format=esm',
          '--outfile',
          outFile,
        ],
        { stdio: 'pipe' },
      );

      const bundle = readFileSync(outFile, 'utf8');

      expect(bundle).not.toMatch(/\btk_(live|test)_[A-Za-z0-9_-]{8,}\b/);
      expect(bundle).not.toContain('tixkit-manifest-secret-dev-only');
      expect(bundle).not.toContain('tixkit-qr-secret-dev-only');
      expect(bundle).not.toContain('whsec_');
      expect(bundle).toContain('Secret Tixkit API keys are server-only');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe('TixkitClient new resource methods', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('events.update sends PATCH with body', async () => {
    const fm = mockFetch(200, { id: 'evt_1', title: 'Updated' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.update('evt_1', { title: 'Updated', expectedVersion: 1 });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({
      title: 'Updated',
      expectedVersion: 1,
    });
  });

  it('events.create includes required currency in the request body', async () => {
    const fm = mockFetch(201, {
      id: 'evt_1',
      title: 'Launch',
      currency: 'EUR',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.create({
      organizationId: 'org_1',
      brandId: 'brd_1',
      slug: 'launch',
      title: 'Launch',
      currency: 'EUR',
      timezone: 'Europe/Paris',
      startsAt: '2026-07-01T00:00:00.000Z',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toMatchObject({ currency: 'EUR' });
  });

  it('events.update sends mutable event fields without status changes', async () => {
    const fm = mockFetch(200, {
      id: 'evt_1',
      status: 'published',
      currency: 'GBP',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.update('evt_1', {
      currency: 'GBP',
      minimumAge: 18,
      expectedVersion: 1,
    });
    const call = getCall(fm);
    expect(JSON.parse(call.body)).toEqual({
      currency: 'GBP',
      minimumAge: 18,
      expectedVersion: 1,
    });
  });

  it('events.pause sends POST', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'paused' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.pause('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/pause');
    expect(call.method).toBe('POST');
  });

  it('events.archive sends POST', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'archived' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.archive('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/archive');
    expect(call.method).toBe('POST');
  });

  it('events exposes resale policy and listing reads', async () => {
    const fm = mockFetch(200, { enabled: true, maxMultiplier: 1.1 });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.updateResalePolicy('evt_1', {
      enabled: true,
      maxMultiplier: 1.1,
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/events/evt_1/resale-policy');
    expect(getCall(fm).method).toBe('PUT');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      enabled: true,
      maxMultiplier: 1.1,
    });

    fm.mockClear();
    await c.events.listResaleListings('evt_1', { limit: 25, cursor: 'lst_1' });
    expect(getCall(fm).url).toBe(
      'https://api.test/v1/events/evt_1/resale-listings?cursor=lst_1&limit=25',
    );
    expect(getCall(fm).method).toBe('GET');
  });

  it('events exposes fee policy reads and updates', async () => {
    const fm = mockFetch(200, {
      eventId: 'evt_1',
      passFeesToBuyer: true,
      rules: [
        {
          id: 'fee_1',
          eventId: 'evt_1',
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          appliedTo: 'per_ticket',
          absorbIntoPrice: false,
        },
      ],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const policy = await c.events.getFeePolicy('evt_1');
    expect(policy.rules[0]?.absorbIntoPrice).toBe(false);
    expect(getCall(fm).url).toBe('https://api.test/v1/events/evt_1/fee-policy');
    expect(getCall(fm).method).toBe('GET');

    fm.mockClear();
    await c.events.updateFeePolicy('evt_1', {
      expectedVersion: 1,
      passFeesToBuyer: false,
      rules: [
        {
          name: 'Order fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
        },
      ],
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/events/evt_1/fee-policy');
    expect(getCall(fm).method).toBe('PUT');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      expectedVersion: 1,
      passFeesToBuyer: false,
      rules: [
        {
          name: 'Order fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
        },
      ],
    });
  });

  it('tickets creates, delists, and completes resale listings with idempotency keys', async () => {
    const fm = mockFetch(201, { id: 'lst_1', status: 'listed' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.tickets.createResaleListing('tkt_1', {
      priceCents: 5500,
      idempotencyKey: 'resale_1',
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/tickets/tkt_1/resale-listings');
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('resale_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({ priceCents: 5500 });

    fm.mockClear();
    await c.tickets.delistResaleListing('lst_1', {
      idempotencyKey: 'delist_1',
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/ticket-listings/lst_1/delist');
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('delist_1');

    fm.mockClear();
    await c.tickets.completeResaleListing('lst_1', {
      buyerId: 'usr_buyer',
      buyerEmail: 'buyer@example.com',
      buyerDateOfBirth: '1990-01-01',
      externalPaymentReference: 'stripe_pi_1',
      idempotencyKey: 'complete_1',
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/ticket-listings/lst_1/complete');
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('complete_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      buyerId: 'usr_buyer',
      buyerEmail: 'buyer@example.com',
      buyerDateOfBirth: '1990-01-01',
      externalPaymentReference: 'stripe_pi_1',
    });
  });

  it('tickets forwards recipient DOB for age-restricted transfers', async () => {
    const fm = mockFetch(200, { id: 'tkt_1', ownerEmail: 'adult@example.com' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.tickets.transfer('tkt_1', {
      toEmail: 'adult@example.com',
      dateOfBirth: '1990-01-01',
      idempotencyKey: 'transfer_1',
    });

    expect(getCall(fm).url).toBe('https://api.test/v1/tickets/tkt_1/transfer');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('transfer_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      toEmail: 'adult@example.com',
      dateOfBirth: '1990-01-01',
    });
  });

  it('checkout creates buyer-owned resale listings with session token and idempotency', async () => {
    const fm = mockFetch(201, { id: 'lst_1', status: 'listed' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.checkout.createTicketResaleListing('cs_1', 'tkt_1', {
      clientToken: 'client_1',
      priceCents: 5500,
      expiresAt: '2026-06-30T00:00:00.000Z',
      idempotencyKey: 'buyer_resale_1',
    });
    expect(getCall(fm).url).toBe(
      'https://api.test/v1/checkout/sessions/cs_1/tickets/tkt_1/resale-listing',
    );
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['X-Checkout-Session-Token']).toBe('client_1');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('buyer_resale_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      priceCents: 5500,
      expiresAt: '2026-06-30T00:00:00.000Z',
    });
  });

  it('checkout.walletPasses requires and sends the checkout session token', async () => {
    const fm = mockFetch(200, { tickets: [] });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    expectTypeOf<Parameters<typeof c.checkout.walletPasses>[1]>().toEqualTypeOf<string>();

    await c.checkout.walletPasses('cs_1', 'client_1');

    expect(getCall(fm).url).toBe('https://api.test/v1/checkout/sessions/cs_1/wallet-passes');
    expect(getCall(fm).method).toBe('GET');
    expect(getCall(fm).headers['X-Checkout-Session-Token']).toBe('client_1');
  });

  it('privacy request inputs require a subject identifier', () => {
    expectTypeOf<{
      organizationId: string;
      subjectType: 'buyer';
      subjectEmail: string;
    }>().toExtend<PrivacyRequestInput>();
    expectTypeOf<{
      organizationId: string;
      subjectType: 'attendee';
      subjectId: string;
    }>().toExtend<PrivacyRequestInput>();
    expectTypeOf<{
      organizationId: string;
      subjectType: 'buyer';
    }>().not.toExtend<PrivacyRequestInput>();
  });

  it('organizations.update sends PATCH', async () => {
    const fm = mockFetch(200, { id: 'org_1', name: 'Updated' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.organizations.update('org_1', {
      name: 'Updated',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/organizations/org_1');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({
      name: 'Updated',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
    });
  });

  it('organizations.updateMember sends the scoped member update contract', async () => {
    const fm = mockFetch(200, {
      id: 'mem_1',
      organizationId: 'org_1',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      role: 'door_staff',
      status: 'invited',
      invitedAt: '2026-01-01T00:00:00.000Z',
      joinedAt: null,
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
    });

    await c.organizations.updateMember('org_1', 'mem_1', {
      role: 'door_staff',
      eventIds: ['evt_1'],
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/organizations/org_1/members/mem_1');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({
      role: 'door_staff',
      eventIds: ['evt_1'],
    });
  });

  it('organizations lists and idempotently invites members', async () => {
    const fm = mockFetch(200, []);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
    });

    await c.organizations.listMembers('org_1');
    await c.organizations.inviteMember('org_1', {
      email: 'door@example.test',
      eventIds: ['evt_1'],
      returnTo: '/kiosk/evt_1',
      idempotencyKey: 'invite_1',
    });

    expect(getCall(fm, 0).url).toBe('https://api.test/v1/organizations/org_1/members');
    const invite = getCall(fm, 1);
    expect(invite.url).toBe('https://api.test/v1/organizations/org_1/members/invitations');
    expect(invite.method).toBe('POST');
    expect(invite.headers['Idempotency-Key']).toBe('invite_1');
    expect(JSON.parse(invite.body)).toEqual({
      email: 'door@example.test',
      eventIds: ['evt_1'],
      returnTo: '/kiosk/evt_1',
    });
  });

  it('tenant settings list methods return runtime arrays without pagination params', async () => {
    const fm = mockFetch(200, [{ id: 'org_1', name: 'Org' }]);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(c.organizations.list()).resolves.toEqual([{ id: 'org_1', name: 'Org' }]);
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/organizations');
    expect(call.method).toBe('GET');
  });

  it('brands.list returns a runtime array without pagination params', async () => {
    const fm = mockFetch(200, [{ id: 'brd_1', name: 'Brand' }]);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(c.brands.list()).resolves.toEqual([{ id: 'brd_1', name: 'Brand' }]);
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/brands');
    expect(call.method).toBe('GET');
  });

  it('paymentAccounts.list returns a runtime array without pagination params', async () => {
    const fm = mockFetch(200, [{ id: 'pa_1', provider: 'stripe_connect' }]);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(c.paymentAccounts.list('org_1')).resolves.toEqual([
      { id: 'pa_1', provider: 'stripe_connect' },
    ]);
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/organizations/org_1/payment-accounts');
    expect(call.method).toBe('GET');
  });

  it('attendees.listAll sends GET to /attendees with query params', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.attendees.listAll({
      eventId: 'evt_1',
      status: 'active',
      checkInStatus: 'checked_in',
      direction: 'next',
      sort: 'createdAt:desc',
      includeFacets: true,
      limit: 50,
    });
    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/attendees?limit=50&eventId=evt_1&status=active&checkInStatus=checked_in&direction=next&sort=createdAt%3Adesc&includeFacets=true',
    );
    expect(call.method).toBe('GET');
  });

  it('checkInLists.list forwards scanner headers with pagination', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.checkInLists.list('evt_1', {
      cursor: 'cil_0',
      limit: 25,
      headers: {
        'X-Device-Id': 'sd_public_1',
        'X-Device-Secret': 'scanner-secret',
      },
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/check-in-lists?cursor=cil_0&limit=25');
    expect(call.method).toBe('GET');
    expect(call.headers.Authorization).toBeUndefined();
    expect(call.headers['X-Device-Id']).toBe('sd_public_1');
    expect(call.headers['X-Device-Secret']).toBe('scanner-secret');
  });

  it('checkInLists.getManifest exposes the bounded single-download manifest contract', async () => {
    expect(MAX_OFFLINE_MANIFEST_TICKETS).toBe(50_000);
    const manifest: OfflineManifest = {
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      generatedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2026-06-02T00:00:00.000Z',
      keyId: 'manifest:v1',
      signature: 'a'.repeat(64),
      tickets: [
        {
          ticketId: 'tkt_1',
          ticketTypeId: 'tt_1',
          attendeeName: 'Ada Lovelace',
          qrHash: 'hash_1',
          status: 'valid',
        },
      ],
    };
    const fm = mockFetch(200, manifest);
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(
      c.checkInLists.getManifest('evt_1', 'cil_1', {
        'X-Device-Id': 'sd_public_1',
        'X-Device-Secret': 'scanner-secret',
      }),
    ).resolves.toEqual(manifest);

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/check-in-lists/cil_1/manifest');
    expect(call.method).toBe('GET');
    expect(call.headers.Authorization).toBeUndefined();
    expect(call.headers['X-Device-Id']).toBe('sd_public_1');
    expect(call.headers['X-Device-Secret']).toBe('scanner-secret');
  });

  it('checkInLists exposes durable activity history and resumable SSE', async () => {
    const fm = mockFetch(200, {
      items: [],
      summary: { checkedIn: 0, remaining: 1, total: 1, acceptedScans: 0 },
    });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const scannerHeaders = {
      'X-Device-Id': 'sd_public_1',
      'X-Device-Secret': 'scanner-secret',
    };

    await c.checkInLists.listActivity('evt_1', 'cil_1', {
      since: '2026-06-01T00:00:00.000Z',
      afterId: 'scan_1',
      limit: 100,
      headers: scannerHeaders,
    });
    await c.checkInLists.getActivityStream('evt_1', 'cil_1', {
      lastEventId: 'scan_1',
      headers: scannerHeaders,
    });

    const historyCall = getCall(fm, 0);
    expect(historyCall.url).toBe(
      'https://api.test/v1/events/evt_1/check-in-lists/cil_1/activity?since=2026-06-01T00%3A00%3A00.000Z&afterId=scan_1&limit=100',
    );
    expect(historyCall.headers['X-Device-Secret']).toBe('scanner-secret');
    const streamCall = getCall(fm, 1);
    expect(streamCall.url).toBe(
      'https://api.test/v1/events/evt_1/check-in-lists/cil_1/activity/stream',
    );
    expect(streamCall.headers.Accept).toBe('text/event-stream');
    expect(streamCall.headers['Last-Event-ID']).toBe('scan_1');
    expect(streamCall.headers['X-Device-Secret']).toBe('scanner-secret');
  });

  it('checkIns.syncBacklog uses the synchronous route when the whole backlog fits', async () => {
    const fm = mockFetch(200, {
      accepted: 1,
      duplicates: 0,
      invalid: 0,
      results: [{ qrHash: 'hash_1', outcome: 'accepted' }],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.checkIns.syncBacklog({
      idempotencyKey: 'idem_sync_backlog',
      headers: { 'X-Scanner-Device-Secret': 'secret' },
      checkInListId: 'cil_1',
      scans: [
        {
          qrHash: 'hash_1',
          scannedAt: '2026-06-01T12:00:00.000Z',
          offline: true,
        },
      ],
    });

    const call = getCall(fm);
    expect(result.mode).toBe('sync');
    expect(fm).toHaveBeenCalledTimes(1);
    expect(call.url).toBe('https://api.test/v1/check-ins/sync');
    expect(call.method).toBe('POST');
    expect(call.headers['Idempotency-Key']).toBe('idem_sync_backlog');
    expect(JSON.parse(call.body)).toEqual({
      checkInListId: 'cil_1',
      scans: [
        {
          qrHash: 'hash_1',
          scannedAt: '2026-06-01T12:00:00.000Z',
          offline: true,
        },
      ],
    });
  });

  it('checkIns.syncBacklog creates one async job, uploads chunks, and polls with backoff', async () => {
    const job = {
      id: 'bcs_1',
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      deviceId: 'sd_1',
      totalChunks: 2,
      totalScans: 3,
      chunksReceived: 0,
      chunksProcessed: 0,
      status: 'receiving',
      attemptCount: 0,
      accepted: 0,
      duplicates: 0,
      invalid: 0,
      processingMetrics: {
        processingDurationMs: 0,
        transactionDurationMs: 0,
        lockWaitMs: 0,
        scanLogInsertDurationMs: 0,
        ticketUpdateDurationMs: 0,
        attendeeUpdateDurationMs: 0,
        rowsProcessed: 0,
        clockWarnings: 0,
      },
      sampleErrors: [],
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-06-01T12:00:00.000Z',
      completedAt: null,
    };
    const completedJob = {
      ...job,
      status: 'completed',
      chunksReceived: 2,
      chunksProcessed: 2,
      accepted: 3,
      processingMetrics: { ...job.processingMetrics, rowsProcessed: 3 },
      completedAt: '2026-06-01T12:01:00.000Z',
    };
    const fm = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(job), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'bch_1', jobId: 'bcs_1', sequence: 1 }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'bch_2', jobId: 'bcs_1', sequence: 2 }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...job, status: 'processing', chunksReceived: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completedJob), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.checkIns.syncBacklog({
      idempotencyKey: 'idem_bulk_backlog',
      headers: { 'X-Scanner-Device-Secret': 'secret' },
      checkInListId: 'cil_1',
      scans: [
        {
          qrHash: 'hash_1',
          scannedAt: '2026-06-01T12:00:00.000Z',
          offline: true,
        },
        {
          qrHash: 'hash_2',
          scannedAt: '2026-06-01T12:00:01.000Z',
          offline: true,
        },
        {
          qrHash: 'hash_3',
          scannedAt: '2026-06-01T12:00:02.000Z',
          offline: true,
        },
      ],
      forceAsync: true,
      chunkSize: 2,
      pollInitialDelayMs: 0,
      pollMaxDelayMs: 0,
    });

    expect(result).toMatchObject({
      mode: 'async',
      job: { status: 'completed', accepted: 3 },
    });
    expect(fm).toHaveBeenCalledTimes(5);
    expect(getCall(fm, 0).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs');
    expect(getCall(fm, 0).method).toBe('POST');
    expect(getCall(fm, 0).headers['Idempotency-Key']).toBe('idem_bulk_backlog:job');
    expect(getCall(fm, 1).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs/bcs_1/chunks/1');
    expect(getCall(fm, 1).headers['Idempotency-Key']).toBe('idem_bulk_backlog:chunk:1');
    expect(getCall(fm, 2).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs/bcs_1/chunks/2');
    expect(getCall(fm, 3).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs/bcs_1');
    expect(getCall(fm, 3).method).toBe('GET');
  });

  it('exports.get sends GET', async () => {
    const fm = mockFetch(200, { exportId: 'exp_1', status: 'completed' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.exports.get('exp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/exports/exp_1');
    expect(call.method).toBe('GET');
  });

  it('exports.getEvents returns the raw SSE response without JSON parsing', async () => {
    const fm = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('event: export.updated\ndata: {"status":"completed"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const response = await c.exports.getEvents('exp_1', {
      lastEventId: 'evt_99',
    });

    const call = getCall(fm);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    await expect(response.text()).resolves.toContain('export.updated');
    expect(call.url).toBe('https://api.test/v1/exports/exp_1/events');
    expect(call.method).toBe('GET');
    expect(call.headers.Accept).toBe('text/event-stream');
    expect(call.headers['Last-Event-ID']).toBe('evt_99');
  });

  it('exports.download returns the raw redirect response without JSON parsing', async () => {
    const fm = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://s3.example/file.csv' },
      }),
    );
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const response = await c.exports.download('exp_1');

    const call = getCall(fm);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://s3.example/file.csv');
    expect(call.url).toBe('https://api.test/v1/exports/exp_1/download');
    expect(call.method).toBe('GET');
  });

  it('reports.conversion returns persisted widget view counts from the API contract', async () => {
    const fm = mockFetch(200, {
      eventId: 'evt_1',
      widgetViews: 18,
      checkoutStarted: 12,
      checkoutCompleted: 6,
      conversionRate: 0.5,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const report = await c.reports.conversion('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/reports/conversion');
    expect(report.widgetViews).toBe(18);
  });

  it('reports.sales returns sales-channel gross totals from the API contract', async () => {
    const fm = mockFetch(200, {
      eventId: 'evt_1',
      currency: 'USD',
      grossSalesCents: 12500,
      grossSalesByChannelCents: { online: 9000, boxOffice: 3500 },
      netRevenueCents: 10000,
      refundsCents: 2000,
      feesCents: 500,
      taxCents: 1000,
      ticketsSold: 8,
      checkIns: 4,
      ordersCount: 6,
      paidOrdersCount: 5,
      range: { from: '2026-06-01', to: '2026-06-30' },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const report = await c.reports.sales('evt_1', {
      from: '2026-06-01',
      to: '2026-06-30',
    });
    const call = getCall(fm);

    expect(call.url).toBe(
      'https://api.test/v1/events/evt_1/reports/sales?from=2026-06-01&to=2026-06-30',
    );
    expect(report.grossSalesByChannelCents).toEqual({
      online: 9000,
      boxOffice: 3500,
    });
  });

  it('products resource sends category and product management requests', async () => {
    const fm = mockFetch(201, {
      id: 'prd_1',
      eventId: 'evt_1',
      name: 'T-shirt',
      priceCents: 2500,
      currency: 'USD',
      maxPerOrder: 3,
      status: 'active',
      sortOrder: 1,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.products.createCategory('evt_1', { name: 'Merch', sortOrder: 1 });
    expect(getCall(fm).url).toBe('https://api.test/v1/events/evt_1/product-categories');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      name: 'Merch',
      sortOrder: 1,
    });

    await c.products.create('evt_1', {
      name: 'T-shirt',
      priceCents: 2500,
      currency: 'USD',
      categoryId: 'pcat_1',
      maxPerOrder: 3,
      status: 'active',
      sortOrder: 1,
    });
    expect(getCall(fm, 1).url).toBe('https://api.test/v1/events/evt_1/products');
    expect(JSON.parse(getCall(fm, 1).body)).toMatchObject({
      name: 'T-shirt',
      categoryId: 'pcat_1',
    });

    await c.products.update('prd_1', { description: null, status: 'inactive' });
    expect(getCall(fm, 2).url).toBe('https://api.test/v1/products/prd_1');
    expect(getCall(fm, 2).method).toBe('PATCH');
    expect(JSON.parse(getCall(fm, 2).body)).toEqual({
      description: null,
      status: 'inactive',
    });
  });

  it('messages.list sends GET without pagination params', async () => {
    const fm = mockFetch(200, { items: [] });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const result = await c.messages.list('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages');
    expect(result).toEqual({ items: [] });
  });

  it('messages.previewRecipients sends POST body', async () => {
    const fm = mockFetch(200, {
      audience: 'checked_in',
      audienceCount: 12,
      eligibleCount: 10,
      suppressedRecipients: 1,
      consentExclusions: 1,
      skippedRecipients: 1,
      recipients: [],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.messages.previewRecipients('evt_1', {
      audience: 'checked_in',
      channel: 'email',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages/preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      audience: 'checked_in',
      channel: 'email',
    });
  });

  it('messages.renderPreview sends the documented event-scoped preview body', async () => {
    const fm = mockFetch(200, {
      channel: 'sms',
      subject: 'Hi Ada',
      html: '',
      text: 'Hi Ada. Reply STOP to opt out',
      segments: {
        segments: 1,
        encoding: 'gsm',
        charsPerSegment: 160,
        unitsUsed: 29,
        remaining: 131,
      },
      validation: { valid: true, unknownTags: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.messages.renderPreview('evt_1', {
      channel: 'sms',
      subjectTemplate: 'Hi {{recipient.name}}',
      textTemplate: 'Hi {{recipient.name}}',
      context: { recipient: { name: 'Ada' } },
      optOutToken: 'Reply STOP to opt out',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages/render-preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      channel: 'sms',
      subjectTemplate: 'Hi {{recipient.name}}',
      textTemplate: 'Hi {{recipient.name}}',
      context: { recipient: { name: 'Ada' } },
      optOutToken: 'Reply STOP to opt out',
    });
    expect(result.segments?.segments).toBe(1);
  });

  it('messages.send sends split template keys with idempotency', async () => {
    const fm = mockFetch(202, {
      campaignId: 'cmp_1',
      eventId: 'evt_1',
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      channel: 'both',
      status: 'queued',
      audienceCount: 2,
      queuedEmailJobs: 2,
      queuedSmsJobs: 2,
      suppressedRecipients: 0,
      consentExclusions: 0,
      skippedRecipients: 0,
      scheduledAt: '2026-07-02T15:00:00.000Z',
      emailJobIds: ['email_1', 'email_2'],
      smsJobIds: ['sms_1', 'sms_2'],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.messages.send('evt_1', {
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      audience: 'all',
      channel: 'both',
      scheduledAt: '2026-07-02T15:00:00.000Z',
      idempotencyKey: 'idem_msg_1',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages');
    expect(call.method).toBe('POST');
    expect(call.headers).toMatchObject({ 'Idempotency-Key': 'idem_msg_1' });
    expect(JSON.parse(call.body)).toEqual({
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      audience: 'all',
      channel: 'both',
      scheduledAt: '2026-07-02T15:00:00.000Z',
    });
    expect(result.scheduledAt).toBe('2026-07-02T15:00:00.000Z');
  });

  it('content resource sends lifecycle requests', async () => {
    const fm = mockFetch(200, {
      id: 'cdoc_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmed',
      status: 'draft',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.content.create({
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmed',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/content-documents');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toMatchObject({
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'order-confirmed',
    });

    await c.content.update('cdoc_1', { name: 'Order receipt' });
    const updateCall = getCall(fm, 1);
    expect(updateCall.url).toBe('https://api.test/v1/content-documents/cdoc_1');
    expect(updateCall.method).toBe('PATCH');
    expect(JSON.parse(updateCall.body)).toEqual({ name: 'Order receipt' });

    await c.content.duplicate('cdoc_1', {
      key: 'order-confirmed-copy',
      name: 'Order confirmed copy',
    });
    const duplicateCall = getCall(fm, 2);
    expect(duplicateCall.url).toBe('https://api.test/v1/content-documents/cdoc_1/duplicate');
    expect(duplicateCall.method).toBe('POST');
    expect(JSON.parse(duplicateCall.body)).toEqual({
      key: 'order-confirmed-copy',
      name: 'Order confirmed copy',
    });
  });

  it('content list sends only backend-supported filters', async () => {
    const fm = mockFetch(200, {
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.content.list({
      limit: 25,
      channel: 'email',
      brandId: 'brd_1',
      eventId: 'evt_1',
      cursor: 'unsupported',
    } as Parameters<typeof c.content.list>[0] & { cursor: string });

    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/content-documents?limit=25&channel=email&brandId=brd_1&eventId=evt_1',
    );
    expect(call.method).toBe('GET');
  });

  it('content preview and public content page use documented paths', async () => {
    const fm = mockFetch(200, {
      channel: 'sms',
      output: { text: 'Hi Ada', segments: 1 },
      validation: { valid: true, severity: 'warning', issues: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.content.preview('cdoc_1', {
      versionId: 'cver_1',
      contentJson: {
        schemaVersion: 1,
        editor: {
          provider: '@tixkit/content-message/sms-composer',
          body: 'Hi {{recipient.name}}',
        },
        settings: {
          templateKey: 'attendee-message',
          locale: 'en',
          category: 'bulk',
          consentCategory: 'marketing',
          segmentLimit: 3,
          estimatedCostPerSegmentCents: 2,
          optOutText: 'Reply STOP to opt out',
        },
        shortLinks: [],
      },
      context: { buyer: { first_name: 'Ada' } },
    });
    expect(getCall(fm, 0).url).toBe('https://api.test/v1/content-documents/cdoc_1/preview');
    expect(getCall(fm, 0).method).toBe('POST');

    await c.public.getContentPage('evt_1', { locale: 'en' });
    expect(getCall(fm, 1).url).toBe(
      'https://api.test/v1/public/events/evt_1/content-page?locale=en',
    );

    await c.public.getEventPage('evt_1', { locale: 'en' });
    expect(getCall(fm, 2).url).toBe('https://api.test/v1/public/events/evt_1/page?locale=en');

    await c.public.getEventPageBySlug('all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    expect(getCall(fm, 3).url).toBe(
      'https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en',
    );

    await c.public.getEventDiscoveryCard('evt_1');
    expect(getCall(fm, 4).url).toBe('https://api.test/v1/public/events/evt_1/discovery-card');
  });

  it('content preview sends canonical React Email document JSON without narrowing to generic objects', async () => {
    const fm = mockFetch(200, {
      channel: 'email',
      output: {
        subject: 'Your All Access Chicago tickets are ready',
        html: '<h1>All Access Chicago</h1>',
        text: 'All Access Chicago',
      },
      validation: { valid: true, severity: 'warning', issues: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const contentJson: EmailTemplateDocument = {
      schemaVersion: 1,
      editor: {
        provider: '@react-email/editor',
        contentHtml:
          '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, your tickets are ready.</p>',
      },
      settings: {
        templateKey: 'order-confirmed',
        subject: 'Your {{event.title}} tickets are ready',
        previewText: 'Everything you need before arrival.',
        locale: 'en',
        category: 'transactional',
        sender: {
          fromEmail: 'tickets@example.test',
          fromName: '{{brand.name}}',
          replyToEmail: 'support@example.test',
        },
      },
      blocks: [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your order is confirmed.',
          ctaLabel: 'View tickets',
          ctaUrl: '{{event.checkoutUrl}}',
        },
        {
          type: 'ticket_summary',
          title: 'Ticket summary',
          body: '{{ticket.type}} - {{order.total}}',
        },
        {
          type: 'unsubscribe_footer',
          body: 'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
          unsubscribeUrl: '{{brand.supportUrl}}',
        },
      ],
    };

    await c.content.preview('cdoc_email', {
      versionId: 'cver_email',
      contentJson,
      context: { recipient: { name: 'Ada Lovelace' } },
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/content-documents/cdoc_email/preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      versionId: 'cver_email',
      contentJson,
      context: { recipient: { name: 'Ada Lovelace' } },
    });
  });

  it('content preview sends canonical SMS document JSON without narrowing to generic objects', async () => {
    const fm = mockFetch(200, {
      channel: 'sms',
      output: {
        text: 'Hi Ada, All Access starts 2026-07-17 19:00. Reply STOP to opt out',
        segments: 1,
        estimatedCostCents: 4,
      },
      validation: { valid: true, severity: 'warning', issues: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const contentJson: SmsTemplateDocument = {
      schemaVersion: 1,
      editor: {
        provider: '@tixkit/content-message/sms-composer',
        body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.',
      },
      settings: {
        templateKey: 'event-reminder-sms',
        locale: 'en',
        category: 'bulk',
        consentCategory: 'marketing',
        segmentLimit: 2,
        estimatedCostPerSegmentCents: 4,
        optOutText: 'Reply STOP to opt out',
      },
      shortLinks: [
        {
          originalUrl: '{{event.checkoutUrl}}',
          reason: 'long_url',
          field: 'editor.body',
        },
      ],
    };

    await c.content.preview('cdoc_sms', {
      versionId: 'cver_sms',
      contentJson,
      context: {
        event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
        recipient: { name: 'Ada' },
      },
      optOutToken: 'Reply STOP to opt out',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/content-documents/cdoc_sms/preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      versionId: 'cver_sms',
      contentJson,
      context: {
        event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
        recipient: { name: 'Ada' },
      },
      optOutToken: 'Reply STOP to opt out',
    });
  });

  it('content testSend returns render artifact metadata from the documented path', async () => {
    const acceptedSendArtifact: ContentRenderArtifact = {
      id: 'cra_send_1',
      tenantId: 'tnt_1',
      documentId: 'cdoc_1',
      versionId: 'cver_1',
      channel: 'sms',
      outputType: 'send',
      artifactRef: 'sms-delivery:smd_1',
      checksum: 'b'.repeat(64),
      createdAt: '2026-06-29T00:00:00.000Z',
    };
    expect(acceptedSendArtifact.outputType).toBe('send');

    const fm = mockFetch(202, {
      testSend: {
        id: 'ctsend_1',
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'sms',
        recipient: '+15550000001',
        status: 'captured',
        renderedText: 'Hi Ada',
        createdAt: '2026-06-29T00:00:00.000Z',
      },
      output: { text: 'Hi Ada', segments: 1 },
      renderArtifact: {
        id: 'cra_1',
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'sms',
        outputType: 'test_send',
        artifactRef: 'content-test-send:ctsend_1',
        checksum: 'a'.repeat(64),
        createdAt: '2026-06-29T00:00:00.000Z',
      },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.content.testSend('cdoc_1', {
      versionId: 'cver_1',
      recipient: '+15550000001',
      context: { recipient: { name: 'Ada' } },
    });

    expect(getCall(fm).url).toBe('https://api.test/v1/content-documents/cdoc_1/test-sends');
    expect(getCall(fm).method).toBe('POST');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      versionId: 'cver_1',
      recipient: '+15550000001',
      context: { recipient: { name: 'Ada' } },
    });
    expect(result.renderArtifact).toMatchObject({
      outputType: 'test_send',
      artifactRef: 'content-test-send:ctsend_1',
      checksum: 'a'.repeat(64),
    });
  });

  it('messages.getCampaign sends GET', async () => {
    const fm = mockFetch(200, {
      id: 'cmp_1',
      eventId: 'evt_1',
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      channel: 'both',
      status: 'sent',
      audience: 'custom',
      audienceKey: 'specific',
      audienceAttendeeIds: ['att_1', 'att_2'],
      audienceLabel: 'Custom (2 attendees)',
      audienceCount: 1,
      queuedEmailJobs: 1,
      queuedSmsJobs: 0,
      suppressedRecipients: 0,
      consentExclusions: 0,
      skippedRecipients: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const campaign = await c.messages.getCampaign('evt_1', 'cmp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages/cmp_1');
    expect(campaign).toMatchObject({
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      queuedEmailJobs: 1,
      suppressedRecipients: 0,
      audience: 'custom',
      audienceKey: 'specific',
      audienceAttendeeIds: ['att_1', 'att_2'],
      audienceLabel: 'Custom (2 attendees)',
    });
    expect(campaign).not.toHaveProperty('queued');
  });

  it('message sub-resource list methods use live item-list envelopes', async () => {
    const fm = mockFetch(200, { items: [] });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.messages.jobs('evt_1', 'cmp_1');
    await c.messages.deliveryLogs('evt_1', 'cmp_1');
    await c.messages.providerEvents('evt_1', 'cmp_1');

    expect(getCall(fm, 0).url).toBe('https://api.test/v1/events/evt_1/messages/cmp_1/jobs');
    expect(getCall(fm, 1).url).toBe(
      'https://api.test/v1/events/evt_1/messages/cmp_1/delivery-logs',
    );
    expect(getCall(fm, 2).url).toBe(
      'https://api.test/v1/events/evt_1/messages/cmp_1/provider-events',
    );
  });

  it('ticketTypes access-rule methods send typed requests', async () => {
    const fm = mockFetch(201, {
      id: 'acr_1',
      ticketTypeId: 'tt_1',
      type: 'code',
      value: 'VIP123',
      usesCount: 0,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.ticketTypes.createAccessRule('tt_1', {
      type: 'code',
      value: 'VIP123',
      maxUses: 5,
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/ticket-types/tt_1/access-rules');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      type: 'code',
      value: 'VIP123',
      maxUses: 5,
    });
  });

  it('ticketTypes batch methods send atomic ticket and access-rule requests', async () => {
    const fm = mockFetch(201, {
      ticketType: {
        id: 'tt_1',
        name: 'VIP',
        kind: 'paid',
        currency: 'USD',
        priceCents: 5000,
      },
      accessRules: [
        {
          id: 'acr_1',
          ticketTypeId: 'tt_1',
          type: 'code',
          value: 'VIP123',
          usesCount: 0,
        },
      ],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.ticketTypes.createBatch('evt_1', {
      ticketType: {
        name: 'VIP',
        kind: 'paid',
        currency: 'USD',
        priceCents: 5000,
      },
      inventoryPool: { name: 'VIP Pool', totalCapacity: 25 },
      accessRules: [{ type: 'code', value: 'VIP123' }],
    });
    let call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/ticket-types/batch');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toMatchObject({
      inventoryPool: { totalCapacity: 25 },
      accessRules: [{ value: 'VIP123' }],
    });

    await c.ticketTypes.updateBatch('tt_1', {
      ticketType: { name: 'VIP 2' },
      accessRules: [{ type: 'code', value: 'VIP456' }],
    });
    call = getCall(fm, 1);
    expect(call.url).toBe('https://api.test/v1/ticket-types/tt_1/batch');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({
      ticketType: { name: 'VIP 2' },
      accessRules: [{ type: 'code', value: 'VIP456' }],
    });
  });

  it('apiKeys.create returns a required one-time api key', async () => {
    const fm = mockFetch(201, {
      id: 'ak_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      name: 'Server key',
      keyPrefix: 'tk_live',
      scopes: ['events.read'],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      apiKey: 'tk_live_secret',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const created = await c.apiKeys.create({
      organizationId: 'org_1',
      name: 'Server key',
      scopes: ['events.read'],
    });
    const call = getCall(fm);

    expect(created.apiKey).toBe('tk_live_secret');
    expectTypeOf(created.apiKey).toEqualTypeOf<string>();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test/v1/api-keys');
  });

  it('agentControl binds mutation intent to idempotency keys and server-owned fields', async () => {
    const fm = mockFetch(201, { id: 'agt_1' });
    const c = new TixkitClient({
      accessToken: 'human-bearer-token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.agentControl.registerPrincipal({
      id: 'external_agent_1',
      kind: 'third_party',
      capabilities: ['events.read'],
      maximumAutonomy: 'read',
      idempotencyKey: 'agent-register-0001',
    });
    await c.agentControl.getPrincipal('agt_1');
    await c.agentControl.revokePrincipal('agt_1', 'agent-revoke-000001');
    await c.agentControl.createOAuthClient({
      agentPrincipalId: 'agt_1',
      organizationId: 'org_1',
      name: 'Automation client',
      idempotencyKey: 'agent-oauth-create-0001',
    });
    await c.agentControl.revokeOAuthClient(
      'agt_1',
      'oapp_aaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'agent-oauth-revoke-0001',
    );
    await c.agentControl.grantDelegation({
      id: 'external_delegation_1',
      agentPrincipalId: 'agt_1',
      capabilities: ['events.execute'],
      resourceScopes: ['event:evt_1'],
      expiresAt: '2026-08-01T00:00:00.000Z',
      idempotencyKey: 'agent-delegate-0001',
    });
    await c.agentControl.revokeDelegation('dlg_1', 'agent-delegation-revoke-0001');

    const calls = fm.mock.calls.map((_, index) => getCall(fm, index));
    expect(calls).toMatchObject([
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-principals',
        headers: { 'Idempotency-Key': 'agent-register-0001' },
      },
      { method: 'GET', url: 'https://api.test/v1/agent-principals/agt_1' },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-principals/agt_1/revoke',
        headers: { 'Idempotency-Key': 'agent-revoke-000001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-principals/agt_1/oauth-clients',
        headers: { 'Idempotency-Key': 'agent-oauth-create-0001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-principals/agt_1/oauth-clients/oapp_aaaaaaaaaaaaaaaaaaaaaaaaaaa/revoke',
        headers: { 'Idempotency-Key': 'agent-oauth-revoke-0001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-delegations',
        headers: { 'Idempotency-Key': 'agent-delegate-0001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-delegations/dlg_1/revoke',
        headers: { 'Idempotency-Key': 'agent-delegation-revoke-0001' },
      },
    ]);
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty('tenantId');
    expect(JSON.parse(calls[3]!.body)).toEqual({
      organizationId: 'org_1',
      name: 'Automation client',
    });
    expect(JSON.parse(calls[5]!.body)).not.toHaveProperty('permissionSnapshot');
    expect(JSON.parse(calls[5]!.body)).not.toHaveProperty('issuedAt');
  });

  it('agentAuth exchanges server-side credentials and inspects explicit agent identity', async () => {
    const fm = mockFetch(200, {
      access_token: 'tk_aat_token',
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'agent.invoke',
    });
    const unauthenticated = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await unauthenticated.agentAuth.exchangeClientCredentials({
      clientId: 'tk_agent_client',
      clientSecret: 'tk_agent_secret_once',
    });
    const credentialCall = getCall(fm);
    expect(credentialCall).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/oauth/token',
    });
    expect(JSON.parse(credentialCall.body)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'tk_agent_client',
      client_secret: 'tk_agent_secret_once',
    });
    expect(credentialCall.headers).not.toHaveProperty('Authorization');

    const agentClient = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await agentClient.agentAuth.session();
    const sessionCall = getCall(fm, 1);
    expect(sessionCall).toMatchObject({
      method: 'GET',
      url: 'https://api.test/v1/agent/session',
      headers: { Authorization: 'Bearer tk_aat_token' },
    });
  });

  it('agentAuth refuses client-secret exchange in browser runtimes', async () => {
    const runtime = globalThis as typeof globalThis & {
      window?: unknown;
      document?: unknown;
    };
    runtime.window = {};
    runtime.document = {};
    try {
      const client = new TixkitClient({
        apiBaseUrl: 'https://api.test',
        maxRetries: 0,
      });
      await expect(
        client.agentAuth.exchangeClientCredentials({
          clientId: 'tk_agent_client',
          clientSecret: 'tk_agent_secret_once',
        }),
      ).rejects.toThrow('Agent OAuth client secrets are server-only');
    } finally {
      delete runtime.window;
      delete runtime.document;
    }
  });

  it('agentActions derives identity and material payload server-side', async () => {
    const fm = mockFetch(201, {});
    const c = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.agentActions.prepare({
      kind: 'event.publish',
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      idempotencyKey: 'agent-action-prepare-0001',
    });
    const actionId = 'act_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const actionDigest = 'b'.repeat(64);
    await c.agentActions.get(actionId);
    await c.agentActions.approve({
      actionId,
      actionDigest,
      idempotencyKey: 'agent-action-approval-0001',
    });
    const approvalId = 'apr_cccccccccccccccccccccccccccccccccccccccccccccccc';
    await c.agentActions.revokeApproval({
      actionId,
      approvalId,
      actionDigest,
      idempotencyKey: 'agent-action-revocation-0001',
    });
    await c.agentActions.execute({ actionId, approvalId, actionDigest });
    const executionId = `exec_${'d'.repeat(48)}`;
    await c.agentActions.getExecution(actionId, executionId);

    const prepare = getCall(fm);
    expect(prepare).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/actions',
      headers: { 'Idempotency-Key': 'agent-action-prepare-0001' },
    });
    expect(JSON.parse(prepare.body)).toEqual({
      kind: 'event.publish',
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
    });
    expect(JSON.parse(prepare.body)).not.toHaveProperty('agentPrincipalId');
    expect(JSON.parse(prepare.body)).not.toHaveProperty('sponsorPrincipalId');
    expect(JSON.parse(prepare.body)).not.toHaveProperty('payload');
    expect(getCall(fm, 1)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/actions/${actionId}`,
    });
    expect(getCall(fm, 2)).toMatchObject({
      method: 'POST',
      url: `https://api.test/v1/agent/actions/${actionId}/approvals`,
      headers: {
        'Idempotency-Key': 'agent-action-approval-0001',
        'X-Tixkit-Confirmation': `approve:${actionId}:${actionDigest}`,
      },
    });
    expect(JSON.parse(getCall(fm, 2).body)).toEqual({ actionDigest });
    expect(getCall(fm, 3)).toMatchObject({
      method: 'POST',
      url: `https://api.test/v1/agent/actions/${actionId}/approvals/${approvalId}/revoke`,
      headers: {
        'Idempotency-Key': 'agent-action-revocation-0001',
        'X-Tixkit-Confirmation': `revoke:${actionId}:${approvalId}:${actionDigest}`,
      },
    });
    expect(JSON.parse(getCall(fm, 3).body)).toEqual({ actionDigest });
    expect(getCall(fm, 4)).toMatchObject({
      method: 'POST',
      url: `https://api.test/v1/agent/actions/${actionId}/executions`,
      headers: {
        'Idempotency-Key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'X-Tixkit-Confirmation': `execute:${actionId}:${approvalId}:${actionDigest}`,
      },
    });
    expect(JSON.parse(getCall(fm, 4).body)).toEqual({ approvalId, actionDigest });
    expect(getCall(fm, 5)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/actions/${actionId}/executions/${executionId}`,
    });
  });

  it('agentActions prepares the direct readiness.read adapter without an approval payload', async () => {
    const fm = mockFetch(201, {});
    const client = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const prepared = await client.agentActions.readReadiness({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      idempotencyKey: 'agent-readiness-read-0001',
    });
    const assertReadinessResponseType = (value: typeof prepared) => {
      void value.resultSha256;
      void value.result.status;
    };
    void assertReadinessResponseType;
    const assertPublishResponseType = async () => {
      const publishPrepared = await client.agentActions.prepare({
        kind: 'event.publish',
        delegationGrantId: 'dlg_1',
        resourceId: 'evt_1',
        idempotencyKey: 'agent-publish-type-only-0001',
      });
      // @ts-expect-error event.publish responses cannot carry direct readiness results.
      void publishPrepared.result;
    };
    void assertPublishResponseType;
    expect(getCall(fm)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/readiness',
      headers: { 'Idempotency-Key': 'agent-readiness-read-0001' },
    });
    expect(JSON.parse(getCall(fm).body)).toEqual({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
    });
    const actionId = `act_${'a'.repeat(48)}`;
    const inspected = await client.agentActions.getReadiness(actionId);
    const assertInspectedReadinessType = (value: typeof inspected) => {
      void value.resultSha256;
    };
    void assertInspectedReadinessType;
    expect(getCall(fm, 1)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/readiness/${actionId}`,
    });
  });

  it('agentActions reads a direct version-bound event projection', async () => {
    const fm = mockFetch(201, {});
    const client = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const prepared = await client.agentActions.readEvent({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      idempotencyKey: 'agent-event-read-0001',
    });
    const assertEventResponseType = (value: typeof prepared) => {
      void value.result.event.title;
      const paths: ['event.title', 'event.description'] = value.result.untrustedContentPaths;
      void paths;
      // @ts-expect-error direct reads never expose approval dry-run evidence.
      void value.dryRun;
    };
    void assertEventResponseType;
    expect(getCall(fm)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/events',
      headers: { 'Idempotency-Key': 'agent-event-read-0001' },
    });
    expect(JSON.parse(getCall(fm).body)).toEqual({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
    });
    const actionId = `act_${'a'.repeat(48)}`;
    const inspected = await client.agentActions.getEvent(actionId);
    const assertInspectedEventType = (value: typeof inspected) => {
      void value.result.eventSnapshotSha256;
    };
    void assertInspectedEventType;
    expect(getCall(fm, 1)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/events/${actionId}`,
    });
  });

  it('agentActions prepares and retrieves a direct normalized event patch preview', async () => {
    const fm = mockFetch(201, {});
    const client = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const prepared = await client.agentActions.prepareEvent({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      changes: { title: 'Prepared title', description: 'Prepared description' },
      idempotencyKey: 'agent-event-prepare-0001',
    });
    const assertEventPrepareResponseType = (value: typeof prepared) => {
      void value.result.changePreviewSha256;
      void value.result.after.title;
      const nullableExistingDescription: string | null | undefined =
        value.result.before.description;
      void nullableExistingDescription;
      const resolvedDescription: string | undefined = value.result.after.description;
      void resolvedDescription;
      // @ts-expect-error direct preparations never expose approval dry-run evidence.
      void value.dryRun;
    };
    void assertEventPrepareResponseType;
    expect(getCall(fm)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/event-preparations',
      headers: { 'Idempotency-Key': 'agent-event-prepare-0001' },
    });
    expect(JSON.parse(getCall(fm).body)).toEqual({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      changes: { title: 'Prepared title', description: 'Prepared description' },
    });
    const actionId = `act_${'a'.repeat(48)}`;
    const inspected = await client.agentActions.getEventPreparation(actionId);
    const assertInspectedEventPrepareType = (value: typeof inspected) => {
      void value.result.changedFields;
    };
    void assertInspectedEventPrepareType;
    expect(getCall(fm, 1)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/event-preparations/${actionId}`,
    });
  });

  it('agentActions prepares and retrieves an approval-bound event update', async () => {
    const fm = mockFetch(201, {});
    const client = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const prepared = await client.agentActions.prepareEventUpdate({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      changes: { title: 'Approved update' },
      idempotencyKey: 'agent-event-update-0001',
    });
    const assertEventUpdateResponseType = (value: typeof prepared) => {
      const kind: 'event.update' = value.action.kind;
      const autonomy: 'execute_with_approval' = value.action.autonomy;
      void kind;
      void autonomy;
      void value.preview.changePreviewSha256;
      void value.previewSha256;
      // @ts-expect-error update preparation is not a completed direct result.
      void value.result;
    };
    void assertEventUpdateResponseType;
    expect(getCall(fm)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/event-updates',
      headers: { 'Idempotency-Key': 'agent-event-update-0001' },
    });
    expect(JSON.parse(getCall(fm).body)).toEqual({
      delegationGrantId: 'dlg_1',
      resourceId: 'evt_1',
      changes: { title: 'Approved update' },
    });
    const actionId = `act_${'a'.repeat(48)}`;
    const inspected = await client.agentActions.getEventUpdate(actionId);
    const assertInspectedEventUpdateType = (value: typeof inspected) => {
      void value.preview.after.title;
    };
    void assertInspectedEventUpdateType;
    expect(getCall(fm, 1)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/event-updates/${actionId}`,
    });
    const actionDigest = 'b'.repeat(64);
    const approvalId = `apr_${'c'.repeat(48)}`;
    const executionId = `exec_${'d'.repeat(48)}`;
    await client.agentActions.approveEventUpdate({
      actionId,
      actionDigest,
      idempotencyKey: 'agent-event-update-approval-0001',
    });
    expect(getCall(fm, 2)).toMatchObject({
      method: 'POST',
      url: `https://api.test/v1/agent/event-updates/${actionId}/approvals`,
      headers: {
        'Idempotency-Key': 'agent-event-update-approval-0001',
        'X-Tixkit-Confirmation': `approve:${actionId}:${actionDigest}`,
      },
    });
    await client.agentActions.revokeEventUpdateApproval({
      actionId,
      approvalId,
      actionDigest,
      idempotencyKey: 'agent-event-update-revocation-0001',
    });
    expect(getCall(fm, 3).url).toBe(
      `https://api.test/v1/agent/event-updates/${actionId}/approvals/${approvalId}/revoke`,
    );
    await client.agentActions.executeEventUpdate({ actionId, approvalId, actionDigest });
    expect(getCall(fm, 4)).toMatchObject({
      method: 'POST',
      url: `https://api.test/v1/agent/event-updates/${actionId}/executions`,
      headers: {
        'Idempotency-Key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'X-Tixkit-Confirmation': `execute:${actionId}:${approvalId}:${actionDigest}`,
      },
    });
    await client.agentActions.getEventUpdateExecution(actionId, executionId);
    expect(getCall(fm, 5)).toMatchObject({
      method: 'GET',
      url: `https://api.test/v1/agent/event-updates/${actionId}/executions/${executionId}`,
    });
  });

  it('agentActions binds planned approval intent to the plan digest', async () => {
    const fm = mockFetch(201, {});
    const client = new TixkitClient({
      accessToken: 'tk_user_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const actionId = 'act_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const actionDigest = 'b'.repeat(64);
    const planSha256 = 'c'.repeat(64);
    await client.agentActions.approve({
      actionId,
      actionDigest,
      planSha256,
      idempotencyKey: 'agent-plan-approval-0001',
    });
    expect(getCall(fm)).toMatchObject({
      method: 'POST',
      url: `https://api.test/v1/agent/actions/${actionId}/approvals`,
      headers: {
        'Idempotency-Key': 'agent-plan-approval-0001',
        'X-Tixkit-Confirmation': `approve:${actionId}:${actionDigest}:${planSha256}`,
      },
    });
    expect(JSON.parse(getCall(fm).body)).toEqual({ actionDigest, planSha256 });
  });

  it('agentPlans preserves canonical definitions and versioned transition intent', async () => {
    const fm = mockFetch(201, {});
    const client = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const definition: AgentPlanDefinition = {
      id: 'plan_primary',
      protocolVersion: '2026-07-27',
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      sponsorPrincipalId: 'sponsor_primary',
      delegationGrantId: 'delegation_primary',
      purpose: 'Publish the reviewed event',
      assumptions: [],
      steps: [
        {
          id: 'step_publish',
          actionKind: 'event.publish',
          actionProtocolVersion: '2026-07-22',
          actionDigest: 'a'.repeat(64),
          dependsOnStepIds: [],
          projectedChanges: [],
          costs: [],
          readinessImpact: {
            beforeSnapshotSha256: 'b'.repeat(64),
            projectedSnapshotSha256: 'c'.repeat(64),
            introducedReasonCodes: [],
            resolvedReasonCodes: [],
          },
          approvalRequirement: { mode: 'fresh_action', riskClass: 'high' },
          reversibility: { mode: 'none' },
        },
      ],
      createdAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T12:30:00.000Z',
      planSha256: 'd'.repeat(64),
    };
    await client.agentPlans.create({
      definition,
      actionBindings: [{ stepId: 'step_publish', actionId: 'action_publish' }],
      idempotencyKey: 'agent-plan-sdk-create-0001',
    });
    await client.agentPlans.get(definition.id);
    await client.agentPlans.transition({
      planId: definition.id,
      expectedStateVersion: 1,
      status: 'awaiting_approval',
      stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
      reasonCode: 'approval_requested',
      idempotencyKey: 'agent-plan-sdk-transition-0001',
    });

    expect(getCall(fm)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/plans',
      headers: {
        'Idempotency-Key': 'agent-plan-sdk-create-0001',
        'X-Tixkit-Version': '2026-08-01',
      },
    });
    expect(JSON.parse(getCall(fm).body)).toEqual({
      definition,
      actionBindings: [{ stepId: 'step_publish', actionId: 'action_publish' }],
    });
    expect(getCall(fm, 1)).toMatchObject({
      method: 'GET',
      url: 'https://api.test/v1/agent/plans/plan_primary',
    });
    expect(getCall(fm, 2)).toMatchObject({
      method: 'POST',
      url: 'https://api.test/v1/agent/plans/plan_primary/transitions',
      headers: { 'Idempotency-Key': 'agent-plan-sdk-transition-0001' },
    });
    expect(JSON.parse(getCall(fm, 2).body)).toEqual({
      expectedStateVersion: 1,
      status: 'awaiting_approval',
      stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
      reasonCode: 'approval_requested',
    });
  });

  it('retries approved agent execution with the exact immutable execution key', async () => {
    const actionId = `act_${'a'.repeat(48)}`;
    const approvalId = `apr_${'b'.repeat(48)}`;
    const actionDigest = 'c'.repeat(64);
    const executionKey = `execute:${actionId}:${approvalId}:${actionDigest}`;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'execution result is temporarily unavailable',
              requestId: 'req_agent_execute',
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: `exec_${'d'.repeat(48)}`,
            actionId,
            approvalId,
            actionDigest,
            state: 'succeeded',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const client = new TixkitClient({
      accessToken: 'tk_aat_token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 1,
    });
    await expect(
      client.agentActions.execute({ actionId, approvalId, actionDigest }),
    ).resolves.toMatchObject({ state: 'succeeded' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 2; index++) {
      expect(getCall(fetchMock, index)).toMatchObject({
        method: 'POST',
        headers: {
          'Idempotency-Key': executionKey,
          'X-Tixkit-Confirmation': executionKey,
        },
      });
      expect(JSON.parse(getCall(fetchMock, index).body)).toEqual({ approvalId, actionDigest });
    }
  });

  it('agentMemory binds inspectable, correctable, exportable, and deletable memory to audited requests', async () => {
    const fm = mockFetch(200, {});
    const c = new TixkitClient({
      accessToken: 'human-bearer-token',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const namespace = {
      scopeType: 'event' as const,
      scopeId: 'evt_1',
      purpose: 'project_context' as const,
    };
    const content = {
      kind: 'project_context' as const,
      summary: 'Keep the event family friendly',
      facts: [{ kind: 'constraint' as const, text: 'Doors open at six' }],
    };

    await c.agentMemory.create({
      namespace,
      key: 'event_context',
      content,
      retentionExpiresAt: '2026-08-20T00:00:00.000Z',
      idempotencyKey: 'memory-create-000001',
    });
    await c.agentMemory.inspect(namespace, 'memory-inspect-00001');
    await c.agentMemory.export(namespace, 'memory-export-000001');
    await c.agentMemory.correct('mem_1', {
      expectedVersion: 1,
      content,
      retentionExpiresAt: '2026-09-20T00:00:00.000Z',
      idempotencyKey: 'memory-correct-00001',
    });
    await c.agentMemory.remove('mem_1', namespace, 2, 'memory-delete-000001');

    const calls = fm.mock.calls.map((_, index) => getCall(fm, index));
    expect(calls).toMatchObject([
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-memory',
        headers: { 'Idempotency-Key': 'memory-create-000001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-memory/inspect',
        headers: { 'Idempotency-Key': 'memory-inspect-00001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-memory/export',
        headers: { 'Idempotency-Key': 'memory-export-000001' },
      },
      {
        method: 'PATCH',
        url: 'https://api.test/v1/agent-memory/mem_1',
        headers: { 'Idempotency-Key': 'memory-correct-00001' },
      },
      {
        method: 'POST',
        url: 'https://api.test/v1/agent-memory/mem_1/delete',
        headers: { 'Idempotency-Key': 'memory-delete-000001' },
      },
    ]);
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty('tenantId');
    expect(JSON.parse(calls[0]!.body)).not.toHaveProperty('sponsorPrincipalId');
    expect(JSON.parse(calls[3]!.body)).toMatchObject({ expectedVersion: 1 });
    expect(JSON.parse(calls[4]!.body)).toMatchObject({
      expectedVersion: 2,
      namespace,
    });
  });

  it('webhookEndpoints.create returns a required one-time signing secret', async () => {
    const fm = mockFetch(201, {
      id: 'wh_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      url: 'https://hooks.example.com/tixkit',
      events: ['order.paid'],
      status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      secret: 'whsec_123',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const created = await c.webhookEndpoints.create({
      organizationId: 'org_1',
      url: 'https://hooks.example.com/tixkit',
      events: ['order.paid'],
    });
    const call = getCall(fm);

    expect(created.secret).toBe('whsec_123');
    expectTypeOf(created.secret).toEqualTypeOf<string>();
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test/v1/webhook-endpoints');
  });

  it('webhookEndpoints.listEvents sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.webhookEndpoints.listEvents('ep_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/webhook-endpoints/ep_1/events');
  });

  it('webhookEndpoints.replayEvent sends POST to the endpoint-scoped replay route', async () => {
    const fm = mockFetch(202, {
      queued: true,
      eventId: 'whe_1',
      endpointId: 'ep_1',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.webhookEndpoints.replayEvent('ep_1', 'whe_1');
    const call = getCall(fm);

    expect(result).toEqual({
      queued: true,
      eventId: 'whe_1',
      endpointId: 'ep_1',
    });
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test/v1/webhook-endpoints/ep_1/events/whe_1/replay');
  });

  it('webhookEndpoints.sendTest queues a synthetic signed delivery', async () => {
    const fetcher = mockFetch(202, {
      queued: true,
      test: true,
      eventId: 'whe_test',
      endpointId: 'ep_1',
    });
    const c = new TixkitClient({
      apiKey: 'tk_test',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const result = await c.webhookEndpoints.sendTest('ep_1');
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/webhook-endpoints/ep_1/test'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({
      queued: true,
      test: true,
      eventId: 'whe_test',
      endpointId: 'ep_1',
    });
  });

  it('webhookEndpoints.replay sends POST to the whole-event replay route', async () => {
    const fm = mockFetch(202, { queued: true, eventId: 'whe_1', endpoints: 2 });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.webhookEndpoints.replay('whe_1');
    const call = getCall(fm);

    expect(result).toEqual({ queued: true, eventId: 'whe_1', endpoints: 2 });
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test/v1/webhook-events/whe_1/replay');
  });

  it('webhookEndpoints.listEvents supports missing-endpoint dead letters', async () => {
    mockFetch(200, {
      items: [
        {
          id: 'whe_1',
          eventId: 'whe_1',
          deliveryId: 'whd_deleted',
          endpointId: null,
          requestedEndpointId: 'wh_deleted',
          deliveryKey: 'live',
          eventType: 'order.paid',
          status: 'dead_lettered',
          attemptCount: 1,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.webhookEndpoints.listEvents('wh_deleted');
    const event: WebhookEvent = result.items[0]!;
    const endpointId: string | null = event.endpointId;

    expect(endpointId).toBeNull();
    expect(event.deliveryId).toBe('whd_deleted');
    expect(event.eventId).toBe(event.id);
    expect(event.requestedEndpointId).toBe('wh_deleted');
    expect(event.statusCode).toBeUndefined();
  });

  it('questions.list sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.list('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions');
  });

  it('questions.create sends POST with body', async () => {
    const fm = mockFetch(201, {
      id: 'q_1',
      label: 'Name',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      isConsentField: false,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.create('evt_1', {
      label: 'Name',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      ticketTypeId: 'tt_1',
      placeholder: 'Ada Lovelace',
      conditionalVisibility: {
        field: 'q_opt_in',
        operator: 'equals',
        value: 'yes',
      },
      isConsentField: false,
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      label: 'Name',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      ticketTypeId: 'tt_1',
      placeholder: 'Ada Lovelace',
      conditionalVisibility: {
        field: 'q_opt_in',
        operator: 'equals',
        value: 'yes',
      },
      isConsentField: false,
    });
  });

  it('questions.update sends PATCH', async () => {
    const fm = mockFetch(200, { id: 'q_1', label: 'Updated' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.update('q_1', { label: 'Updated' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/questions/q_1');
    expect(call.method).toBe('PATCH');
  });

  it('questions.reorder sends POST to the event-scoped reorder endpoint', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.reorder('evt_1', [
      { id: 'q_second', sortOrder: 0 },
      { id: 'q_first', sortOrder: 1 },
    ]);
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions/reorder');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      questions: [
        { id: 'q_second', sortOrder: 0 },
        { id: 'q_first', sortOrder: 1 },
      ],
    });
  });

  it('questions.delete sends DELETE', async () => {
    const fm = mockFetch(204, null);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.delete('q_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/questions/q_1');
    expect(call.method).toBe('DELETE');
  });

  it('oauthApplications.list sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.list();
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth-applications');
  });

  it('oauthApplications.create sends POST with body and exposes tenant metadata', async () => {
    const fm = mockFetch(201, {
      id: 'app_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      name: 'Test',
      clientId: 'cli_1',
      redirectUris: ['https://example.com/cb'],
      scopes: ['read'],
      status: 'active',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const created = await c.oauthApplications.create({
      organizationId: 'org_1',
      name: 'Test',
      redirectUris: ['https://example.com/cb'],
      scopes: ['read'],
    });
    const call = getCall(fm);
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      organizationId: 'org_1',
      name: 'Test',
      redirectUris: ['https://example.com/cb'],
      scopes: ['read'],
    });
    expect(created.tenantId).toBe('tnt_1');
    expectTypeOf(created).toEqualTypeOf<OAuthApplication>();
    expectTypeOf(created.tenantId).toEqualTypeOf<string>();
  });

  it('oauthApplications.delete sends DELETE', async () => {
    const fm = mockFetch(204, null);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.delete('app_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth-applications/app_1');
    expect(call.method).toBe('DELETE');
  });

  it('oauthApplications.token exchanges authorization codes', async () => {
    const fm = mockFetch(200, {
      access_token: 'tk_oat_test',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'events.read',
      refresh_token: 'tk_ort_test',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.token({
      grantType: 'authorization_code',
      clientId: 'client_1',
      clientSecret: 'secret_1',
      code: 'code_1',
      redirectUri: 'https://example.com/cb',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth/token');
    expect(JSON.parse(call.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client_1',
      client_secret: 'secret_1',
      code: 'code_1',
      redirect_uri: 'https://example.com/cb',
    });
  });

  it('oauthApplications.revoke sends token revocation body', async () => {
    const fm = mockFetch(200, { revoked: true });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.revoke({
      clientId: 'client_1',
      clientSecret: 'secret_1',
      token: 'tk_oat_test',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth/revoke');
    expect(JSON.parse(call.body)).toEqual({
      client_id: 'client_1',
      client_secret: 'secret_1',
      token: 'tk_oat_test',
    });
  });

  it('brands.listSenderIdentities sends GET to the brand sender identity endpoint', async () => {
    const identities: BrandSenderIdentity[] = [
      {
        id: 'bsi_1',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        email: 'tickets@example.com',
        name: 'Tickets',
        replyToEmail: 'support@example.com',
        verified: true,
        verifiedAt: '2026-06-01T00:00:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ];
    const fm = mockFetch(200, identities);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(c.brands.listSenderIdentities('brd_1')).resolves.toEqual(identities);

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/brands/brd_1/email-sender-identities');
    expect(call.method).toBe('GET');
  });

  it('paymentAccounts.refreshStripeConnect sends POST to the account refresh endpoint', async () => {
    const fm = mockFetch(200, {
      id: 'pa_1',
      status: 'active',
      onboardingUrl: 'https://connect.stripe.test/update',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.paymentAccounts.refreshStripeConnect('org_1', 'pa_1');
    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/organizations/org_1/payment-accounts/pa_1/stripe-connect/refresh',
    );
    expect(call.method).toBe('POST');
  });

  it('orders.list sends organization and event filters with pagination', async () => {
    const fm = mockFetch(200, {
      items: [],
      nextCursor: null,
      prevCursor: null,
      facets: { status: { rows: [{ value: 'paid', total: 0 }] } },
      applied: {
        sort: [{ field: 'createdAt', direction: 'desc' }],
        filters: {},
      },
    });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const page = await c.orders.list({
      limit: 50,
      organizationId: 'org_1',
      eventId: 'evt_1',
      status: 'paid',
      refundState: false,
      includeFacets: true,
      direction: 'prev',
      cursor: 'ord_2',
    });
    expectTypeOf(page).toEqualTypeOf<AdminTablePage<Order>>();
    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/orders?cursor=ord_2&limit=50&organizationId=org_1&eventId=evt_1&status=paid&refundState=false&includeFacets=true&direction=prev',
    );
  });

  it('orders.get returns the enriched order detail contract', async () => {
    expectTypeOf<TixkitClient['orders']['get']>().returns.resolves.toEqualTypeOf<OrderDetail>();
    const fm = mockFetch(200, {
      id: 'ord_1',
      eventId: 'evt_1',
      checkoutSessionId: 'cs_1',
      orderNumber: '1001',
      status: 'paid',
      currency: 'USD',
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
      refundedCents: 0,
      buyerEmail: 'buyer@example.com',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      lineItems: [],
      attendees: [],
      taxSnapshots: [],
      checkoutAnswers: { buyerFields: {}, attendeeFields: {} },
      consentSnapshots: {},
      refunds: [],
      timeline: [],
      deliveryStatus: { email: 'pending', tickets: 'not_issued' },
    });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.orders.get('ord_1');
    const call = getCall(fm);

    expect(call.url).toBe('https://api.test/v1/orders/ord_1');
    expect(result.checkoutAnswers).toEqual({
      buyerFields: {},
      attendeeFields: {},
    });
    expect(result.deliveryStatus).toEqual({
      email: 'pending',
      tickets: 'not_issued',
    });
    expect(result.refunds).toEqual([]);
  });

  it('orders.refund sends lifecycle flags and returns queued refund status', async () => {
    const fm = mockFetch(202, {
      orderId: 'ord_1',
      refundAmount: 2500,
      status: 'pending',
      message: 'Refund workflow queued',
    });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.orders.refund('ord_1', {
      amountCents: 2500,
      reason: 'customer_request',
      voidTickets: true,
      restoreInventory: true,
      idempotencyKey: 'idem_refund_1',
    });
    const call = getCall(fm);

    expect(call.url).toBe('https://api.test/v1/orders/ord_1/refunds');
    expect(call.method).toBe('POST');
    expect(call.headers['Idempotency-Key']).toBe('idem_refund_1');
    expect(JSON.parse(call.body)).toEqual({
      amountCents: 2500,
      reason: 'customer_request',
      voidTickets: true,
      restoreInventory: true,
    });
    expect(result).toEqual({
      orderId: 'ord_1',
      refundAmount: 2500,
      status: 'pending',
      message: 'Refund workflow queued',
    });
  });

  it('orders.cancel sends required idempotency header without a body', async () => {
    const fm = mockFetch(200, { id: 'ord_1', status: 'cancelled' });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.orders.cancel('ord_1', { idempotencyKey: 'idem_cancel_1' });
    const call = getCall(fm);

    expect(call.url).toBe('https://api.test/v1/orders/ord_1/cancel');
    expect(call.method).toBe('POST');
    expect(call.headers['Idempotency-Key']).toBe('idem_cancel_1');
    expect(call.body).toBeUndefined();
  });

  it('public.getEvent sends GET without auth', async () => {
    const fm = mockFetch(200, {
      id: 'evt_1',
      slug: 'summer-show',
      title: 'Event',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-07T20:00:00.000Z',
      brandId: 'brd_1',
      marketingIntegrations: [
        {
          provider: 'ga4',
          config: { measurementId: 'G-TEST1234' },
          consentRequired: true,
          status: 'active',
        },
      ],
    });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const event = await c.public.getEvent('evt_1');
    expectTypeOf(event).toEqualTypeOf<PublicEvent>();
    expect(event).toMatchObject({
      id: 'evt_1',
      slug: 'summer-show',
      brandId: 'brd_1',
      marketingIntegrations: [{ provider: 'ga4' }],
    });
    expect(event).not.toHaveProperty('currency');
    expect(event).not.toHaveProperty('resalePolicy');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1');
  });

  it('public.getEventBySlug sends host-scoped public event GET without auth', async () => {
    const fm = mockFetch(200, {
      id: 'evt_1',
      slug: 'all-access',
      title: 'All Access',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-07T20:00:00.000Z',
      brandId: 'brd_1',
      marketingIntegrations: [],
    });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const event = await c.public.getEventBySlug('all-access', {
      host: 'events.example.com',
    });

    expectTypeOf(event).toEqualTypeOf<PublicEvent>();
    expect(getCall(fm).url).toBe(
      'https://api.test/v1/public/events/by-slug/all-access?host=events.example.com',
    );
    expect(getCall(fm).method).toBe('GET');
  });

  it('public.getEventRevision sends GET without auth', async () => {
    const fm = mockFetch(200, { revision: '2026-07-07T04:31:00.000Z' });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const revision = await c.public.getEventRevision('evt_1');

    expect(revision).toEqual({ revision: '2026-07-07T04:31:00.000Z' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1/revision');
    expect(call.method).toBe('GET');
  });

  it('public.listResaleListings sends public GET with pagination', async () => {
    const fm = mockFetch(200, { items: [{ id: 'lst_1', status: 'listed' }] });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.public.listResaleListings('evt_1', { cursor: 'lst_0', limit: 25 });
    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/public/events/evt_1/resale-listings?cursor=lst_0&limit=25',
    );
    expect(call.method).toBe('GET');
  });

  it('public bootstrap helpers send documented public GET routes without auth', async () => {
    const fm = mockFetch(200, {});
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const checkoutBootstrap = await c.public.getCheckoutBootstrap('evt_1', {
      products: ['tt_1', 'prd_1'],
      resaleListingId: 'tl_1',
    });
    expectTypeOf(checkoutBootstrap).toEqualTypeOf<PublicCheckoutBootstrap>();
    expect(getCall(fm, 0).url).toBe(
      'https://api.test/v1/public/events/evt_1/bootstrap?products=tt_1%2Cprd_1&resaleListingId=tl_1',
    );
    expect(getCall(fm, 0).method).toBe('GET');

    await c.public.getCheckoutBootstrap('evt_1', { products: 'tt_1' });
    expect(getCall(fm, 1).url).toBe(
      'https://api.test/v1/public/events/evt_1/bootstrap?products=tt_1',
    );

    const pageBootstrap = await c.public.getEventPageBootstrap('evt_1', {
      locale: 'en',
    });
    expectTypeOf(pageBootstrap).toEqualTypeOf<PublicEventPageBootstrap>();
    expectTypeOf<PublicContentPage['page']['puckData']>().toEqualTypeOf<PuckData>();
    expectTypeOf<EventPageDocumentV2['editor']['data']>().toEqualTypeOf<PuckData>();
    expect(getCall(fm, 2).url).toBe(
      'https://api.test/v1/public/events/evt_1/page-bootstrap?locale=en',
    );

    const slugPageBootstrap = await c.public.getEventPageBootstrapBySlug('all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    expectTypeOf(slugPageBootstrap).toEqualTypeOf<PublicEventPageBootstrap>();
    expect(getCall(fm, 3).url).toBe(
      'https://api.test/v1/public/events/by-slug/all-access/page-bootstrap?host=events.example.com&locale=en',
    );
  });

  it('public.getAvailability sends product filters and returns product rows', async () => {
    const fm = mockFetch(200, [
      {
        type: 'product',
        productId: 'prd_1',
        name: 'T-shirt',
        kind: 'product',
        priceCents: 2500,
        currency: 'USD',
        minPerOrder: 1,
        maxPerOrder: 3,
        available: 3,
        status: 'active',
        requiresAccessCode: false,
      },
    ]);
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const availability = await c.public.getAvailability('evt_1', ['tt_hidden', 'prd_1']);
    expectTypeOf(availability).toEqualTypeOf<PublicAvailabilityItem[]>();

    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/public/events/evt_1/availability?products=tt_hidden%2Cprd_1',
    );
    expect(call.method).toBe('GET');
    expect(availability[0]).toMatchObject({
      type: 'product',
      productId: 'prd_1',
      kind: 'product',
    });
  });

  it('public.validateAccessCode sends POST with ticketTypeIds and accessCode', async () => {
    const fm = mockFetch(200, { valid: true, ticketTypeIds: ['tt_1'] });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.public.validateAccessCode('evt_1', {
      ticketTypeIds: ['tt_1'],
      accessCode: 'CODE123',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1/access-code');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      ticketTypeIds: ['tt_1'],
      accessCode: 'CODE123',
    });
  });

  it('uploads.create sends a signed upload ticket request', async () => {
    expectTypeOf<'content_email_image'>().toExtend<UploadPurpose>();
    const validMigrationUpload: CreateUploadArtifactInput = {
      purpose: 'migration_import',
      organizationId: 'org_1',
      fileName: 'portable.tixkit.json',
      contentType: 'application/vnd.tixkit.portable+json',
      sizeBytes: 1234,
    };
    expectTypeOf(validMigrationUpload).toMatchTypeOf<CreateUploadArtifactInput>();
    // @ts-expect-error migration imports require an organization scope.
    const unscopedMigrationUpload: CreateUploadArtifactInput = {
      purpose: 'migration_import',
      fileName: 'portable.tixkit.json',
      contentType: 'application/vnd.tixkit.portable+json',
      sizeBytes: 1234,
    };
    // @ts-expect-error non-migration uploads must not carry an organization scope.
    const crossPurposeOrganizationUpload: CreateUploadArtifactInput = {
      purpose: 'user_avatar',
      organizationId: 'org_1',
      fileName: 'avatar.png',
      contentType: 'image/png',
      sizeBytes: 1234,
    };
    void unscopedMigrationUpload;
    void crossPurposeOrganizationUpload;

    const fm = mockFetch(201, {
      artifactId: 'upl_1',
      uploadUrl: 'https://s3.test/upload',
      uploadHeaders: { 'Content-Type': 'image/png' },
      completeUrl: '/v1/upload-artifacts/upl_1/complete',
      expiresAt: '2026-01-01T00:15:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.uploads.create({
      purpose: 'migration_import',
      fileName: 'portable.tixkit.json',
      contentType: 'application/vnd.tixkit.portable+json',
      sizeBytes: 1234,
      organizationId: 'org_1',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/upload-artifacts');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      purpose: 'migration_import',
      fileName: 'portable.tixkit.json',
      contentType: 'application/vnd.tixkit.portable+json',
      sizeBytes: 1234,
      organizationId: 'org_1',
    });
  });

  it('uploads.download returns durable relative URLs from the API contract', async () => {
    expectTypeOf<UploadArtifactDownload>().toMatchTypeOf<{
      downloadUrl: string;
      durable?: boolean;
    }>();
    const fm = mockFetch(200, {
      downloadUrl: '/v1/public/brand-logos/upl_logo_clean',
      durable: true,
    });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const download = await c.uploads.download('upl_logo_clean');

    expect(download).toEqual({
      downloadUrl: '/v1/public/brand-logos/upl_logo_clean',
      durable: true,
    });
    expect(getCall(fm)).toMatchObject({
      url: 'https://api.test/v1/upload-artifacts/upl_logo_clean/download',
      method: 'GET',
    });
  });

  it('public upload helpers create and complete checkout upload artifacts', async () => {
    const fm = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactId: 'upl_1',
            uploadUrl: 'https://s3.test/upload',
            uploadHeaders: { 'Content-Type': 'application/pdf' },
            completeUrl: '/v1/public/upload-artifacts/upl_1/complete',
            completeToken: 'complete-token',
            expiresAt: '2026-01-01T00:15:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactId: 'upl_1',
            status: 'uploaded',
            scanStatus: 'clean',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.public.createUploadArtifact('evt_1', {
      fileName: 'waiver.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4321,
      questionId: 'q_file',
    });
    await c.public.completeUploadArtifact('upl_1', 'complete-token');

    expect(getCall(fm, 0).url).toBe('https://api.test/v1/public/events/evt_1/upload-artifacts');
    expect(JSON.parse(getCall(fm, 0).body)).toEqual({
      fileName: 'waiver.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4321,
      questionId: 'q_file',
    });
    expect(getCall(fm, 1).url).toBe('https://api.test/v1/public/upload-artifacts/upl_1/complete');
    expect(JSON.parse(getCall(fm, 1).body)).toEqual({
      token: 'complete-token',
    });
  });

  it('public.recordWidgetImpression sends PII-safe impression metadata', async () => {
    const fm = mockFetch(201, { tracked: true, deduped: false });
    const c = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.public.recordWidgetImpression('evt_1', {
      visitorId: 'visitor_123456',
      trackingId: 'utm-widget',
      host: 'example.com',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1/widget-impressions');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      visitorId: 'visitor_123456',
      trackingId: 'utm-widget',
      host: 'example.com',
    });
  });

  it('auth.me sends GET to /me', async () => {
    const fm = mockFetch(200, { userId: 'u_1', email: 'test@example.com' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.auth.me();
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/me');
  });
});
