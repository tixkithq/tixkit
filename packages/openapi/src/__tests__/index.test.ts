import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OpenApiParameter } from '../index.js';
import { openApiSpec } from '../index.js';
import { ALL_PERMISSIONS } from '@tixkit/domain';

function exampleMatchesSchema(example: unknown, schema: any): boolean {
  if (!schema || typeof schema !== 'object') return true;
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').at(-1);
    const schemas = openApiSpec.components.schemas as Record<string, unknown>;
    return exampleMatchesSchema(example, name ? schemas[name] : undefined);
  }
  if (schema.oneOf)
    return schema.oneOf.some((entry: unknown) => exampleMatchesSchema(example, entry));
  if (schema.anyOf)
    return schema.anyOf.some((entry: unknown) => exampleMatchesSchema(example, entry));
  if (schema.allOf)
    return schema.allOf.every((entry: unknown) => exampleMatchesSchema(example, entry));
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (example === null) return types.includes('null');
  if (types.includes('array'))
    return (
      Array.isArray(example) && example.every((entry) => exampleMatchesSchema(entry, schema.items))
    );
  if (types.includes('object') || schema.properties) {
    if (!example || typeof example !== 'object' || Array.isArray(example)) return false;
    return Object.entries(example).every(([key, value]) =>
      schema.properties?.[key] ? exampleMatchesSchema(value, schema.properties[key]) : true,
    );
  }
  if (types.includes('string')) return typeof example === 'string';
  if (types.includes('boolean')) return typeof example === 'boolean';
  if (types.includes('integer')) return Number.isInteger(example);
  if (types.includes('number')) return typeof example === 'number';
  return true;
}

describe('openApiSpec', () => {
  it('documents event media purposes and safe test checkout tagging', () => {
    expect(openApiSpec.components.schemas.CreateUploadArtifact.properties.purpose.enum).toEqual(
      expect.arrayContaining(['event_cover', 'event_seo_image']),
    );
    expect(openApiSpec.components.schemas.Order.properties.isTest).toMatchObject({
      type: 'boolean',
    });
    expect(openApiSpec.paths['/checkout/sessions'].post.parameters).toContainEqual(
      expect.objectContaining({ name: 'X-Tixkit-Test-Order', in: 'header' }),
    );
  });
  it('publishes the documented API lifecycle version', () => {
    expect(openApiSpec.info.version).toBe('2026-01-01');
  });

  it('publishes the authoritative API-key permission scope catalog', () => {
    expect(openApiSpec.components.securitySchemes.ApiKey['x-api-key-scopes']).toEqual(
      ALL_PERMISSIONS,
    );
  });

  it('provides sanitized JSON examples for every documented request and response body', () => {
    const methods = new Set(['get', 'put', 'post', 'delete', 'patch']);
    const missing: string[] = [];
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.has(method) || !operation || typeof operation !== 'object') continue;
        const bodies = [
          'requestBody' in operation ? operation.requestBody : undefined,
          ...Object.values('responses' in operation ? operation.responses : {}),
        ];
        for (const body of bodies) {
          if (!body || typeof body !== 'object' || !('content' in body)) continue;
          const json = body.content?.['application/json'];
          if (json?.schema && json.example === undefined && json.examples === undefined) {
            missing.push(`${method.toUpperCase()} ${path}`);
          }
          if (json?.example !== undefined) {
            const serialized = JSON.stringify(json.example);
            expect(serialized).not.toMatch(/\btk_[A-Za-z0-9_-]+/);
            expect(serialized).not.toContain('one-time-secret');
            expect(
              exampleMatchesSchema(json.example, json.schema),
              `${method.toUpperCase()} ${path}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('documents workspace/event readiness, acknowledgements, and publish conflicts', () => {
    expect(openApiSpec.paths).toHaveProperty('/organizations/{organizationId}/readiness');
    expect(openApiSpec.paths).toHaveProperty('/events/{eventId}/launch-readiness');
    expect(openApiSpec.paths).toHaveProperty(
      '/events/{eventId}/readiness-acknowledgements/{stepId}',
    );
    expect(openApiSpec.components.schemas).toHaveProperty('WorkspaceReadiness');
    expect(openApiSpec.components.schemas).toHaveProperty('EventLaunchReadiness');
    expect(openApiSpec.components.schemas).toHaveProperty('ReadinessAcknowledgement');
    const readinessOperations = [
      openApiSpec.paths['/organizations/{organizationId}/readiness'].get,
      openApiSpec.paths['/events/{eventId}/launch-readiness'].get,
      openApiSpec.paths['/events/{eventId}/readiness-acknowledgements/{stepId}'].post,
      openApiSpec.paths['/events/{eventId}/readiness-acknowledgements/{stepId}'].delete,
    ];
    expect(readinessOperations.map((operation) => operation['x-required-permissions'])).toEqual([
      ['events.read'],
      ['events.read'],
      ['events.write'],
      ['events.write'],
    ]);
    for (const operation of readinessOperations)
      expect(operation.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    const launchExample = openApiSpec.components.schemas.EventLaunchReadiness.example;
    expect(launchExample.launchable).toBe(true);
    expect(launchExample.requiredBlockers).toEqual([]);
    expect(launchExample.recommendedWarnings).toEqual([]);
    expect(launchExample.steps.every((step) => String(step.id) !== 'workspace_selection')).toBe(
      true,
    );
    const failureExample = openApiSpec.components.schemas.LaunchReadinessFailedError.example;
    expect(failureExample.error.code).toBe('launch_readiness_failed');
    expect(failureExample.error.details.requiredBlockers).toEqual([
      expect.objectContaining({
        id: 'sellable_tickets',
        status: 'incomplete',
        priority: 'required',
      }),
    ]);
    expect(failureExample.error.details.recommendedWarnings).toEqual([]);
    expect(openApiSpec.paths['/events/{eventId}/publish'].post.responses).toHaveProperty('409');
    expect(
      openApiSpec.paths['/events/{eventId}/publish'].post.responses['409'].content[
        'application/json'
      ].schema,
    ).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/LaunchReadinessFailedError' },
        { $ref: '#/components/schemas/StaleEventVersionError' },
        { $ref: '#/components/schemas/EventArchivedError' },
      ],
    });
  });

  it('declares required path parameters for every templated path operation', () => {
    const pathTemplateParameterPattern = /\{([^}]+)\}/g;
    const operations = new Set([
      'get',
      'put',
      'post',
      'delete',
      'options',
      'head',
      'patch',
      'trace',
    ]);
    const missingParameters: string[] = [];

    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      const parameterNames = [...path.matchAll(pathTemplateParameterPattern)].map(
        (match) => match[1],
      );
      if (parameterNames.length === 0) continue;

      const pathParameters =
        'parameters' in pathItem && Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operations.has(method) || !operation || typeof operation !== 'object') continue;

        const operationParameters =
          'parameters' in operation && Array.isArray(operation.parameters)
            ? operation.parameters
            : [];
        const declaredParameters = [...pathParameters, ...operationParameters];
        for (const name of parameterNames) {
          const isDeclared = declaredParameters.some(
            (parameter) =>
              !('$ref' in parameter) &&
              parameter.name === name &&
              parameter.in === 'path' &&
              parameter.required === true,
          );
          if (!isDeclared)
            missingParameters.push(`${method.toUpperCase()} ${path} missing ${name}`);
        }
      }
    }

    expect(missingParameters).toEqual([]);
  });

  it('types normalized templated path operation parameters as exported runtime fields', () => {
    expectTypeOf(openApiSpec.paths['/checkout/sessions/{sessionId}'].get.parameters).toEqualTypeOf<
      OpenApiParameter[]
    >();
    expectTypeOf(openApiSpec.paths['/orders/{orderId}/cancel'].post.parameters).toEqualTypeOf<
      OpenApiParameter[]
    >();
  });

  it('documents the root-level health route outside the versioned API server', () => {
    expect(openApiSpec.paths['/health'].get).toBeDefined();
    expect(openApiSpec.paths['/health'].get.summary).toBe('Health check');
    expect(openApiSpec.paths['/health'].servers).toEqual([
      {
        url: 'https://api.tixkit.com',
        description: 'Production operational root',
      },
      { url: 'http://localhost:4000', description: 'Local operational root' },
    ]);
  });

  it('documents paginated private list endpoints as envelopes', () => {
    expect(
      openApiSpec.paths['/events'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/EventPage' });
    expect(
      openApiSpec.paths['/orders'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OrderPage' });
    expect(
      openApiSpec.paths['/api-keys'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/ApiKeyPage' });
  });

  it('documents tenant settings lists as runtime array responses', () => {
    expect(
      openApiSpec.paths['/bootstrap-context'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/BootstrapContext' });
    expect(openApiSpec.components.schemas.BootstrapContext.properties.organizations.items).toEqual({
      $ref: '#/components/schemas/BootstrapOrganization',
    });
    expect(openApiSpec.components.schemas.BootstrapOrganization.required).not.toContain(
      'boxOfficeSettings',
    );
    expect(
      openApiSpec.paths['/organizations'].get.responses['200'].content['application/json'].schema,
    ).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Organization' },
    });
    expect(openApiSpec.paths['/organizations'].get.parameters).toBeUndefined();
    expect(
      openApiSpec.paths['/brands'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Brand' } });
    expect(openApiSpec.paths['/brands'].get.parameters).toBeUndefined();
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/PaymentAccount' },
    });
  });

  it('uses implemented developer route paths', () => {
    expect(openApiSpec.paths['/api-keys']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices']).toBeDefined();
    expect(openApiSpec.paths['/oauth-applications']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post.responses).toHaveProperty(
      '200',
    );
    expect(
      openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post.responses,
    ).not.toHaveProperty('204');
    expect(openApiSpec.components.schemas.ScannerDevice.properties.scopes.items.enum).toEqual([
      'checkins.read',
      'checkins.write',
    ]);
    expect(openApiSpec.components.schemas.ScannerDevice.required).toContain('scopes');
    expect(
      openApiSpec.paths['/scanner-devices'].post.requestBody.content['application/json'].schema
        .properties.scopes.default,
    ).toEqual(['checkins.read', 'checkins.write']);
    const oauthApplicationFields = Object.keys(
      openApiSpec.paths['/oauth-applications'].post.requestBody.content['application/json'].schema
        .properties,
    );
    // eslint-disable-next-line unicorn/no-array-sort -- Sorting a fresh key array keeps this assertion stable without requiring ES2023 toSorted.
    oauthApplicationFields.sort();
    expect(oauthApplicationFields).toEqual(['name', 'organizationId', 'redirectUris', 'scopes']);
    expect(openApiSpec.paths).not.toHaveProperty('/developer/api-keys');
  });

  it('documents API-key authentication on scoped developer and audit automation routes', () => {
    const apiKeyCapableOperations = [
      openApiSpec.paths['/api-keys'].get,
      openApiSpec.paths['/api-keys'].post,
      openApiSpec.paths['/api-keys/{keyId}'].delete,
      openApiSpec.paths['/scanner-devices'].get,
      openApiSpec.paths['/scanner-devices'].post,
      openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post,
      openApiSpec.paths['/oauth-applications'].get,
      openApiSpec.paths['/oauth-applications'].post,
      openApiSpec.paths['/oauth-applications/{appId}'].delete,
      openApiSpec.paths['/webhook-endpoints'].get,
      openApiSpec.paths['/webhook-endpoints'].post,
      openApiSpec.paths['/webhook-endpoints/{endpointId}'].patch,
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events'].get,
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events/{eventId}/replay'].post,
      openApiSpec.paths['/webhook-events/{eventId}/replay'].post,
      openApiSpec.paths['/audit-logs'].get,
    ];

    for (const operation of apiKeyCapableOperations) {
      expect(operation.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    }
  });

  it('documents stable credential metadata returned by API serializers', () => {
    expect(openApiSpec.components.schemas.ApiKey.properties).toMatchObject({
      tenantId: { type: 'string' },
      organizationId: { type: 'string' },
      brandIds: { type: 'array', items: { type: 'string' } },
      eventIds: { type: 'array', items: { type: 'string' } },
      revokedAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    });
    expect(openApiSpec.components.schemas.ApiKey.required).toEqual([
      'id',
      'tenantId',
      'organizationId',
      'name',
      'keyPrefix',
      'scopes',
      'createdAt',
      'updatedAt',
    ]);

    expect(openApiSpec.components.schemas.ScannerDevice.properties).toMatchObject({
      tenantId: { type: 'string' },
      organizationId: { type: 'string' },
      updatedAt: { type: 'string', format: 'date-time' },
    });
    expect(openApiSpec.components.schemas.ScannerDevice.required).toEqual([
      'id',
      'tenantId',
      'organizationId',
      'name',
      'deviceId',
      'eventIds',
      'scopes',
      'status',
      'createdAt',
      'updatedAt',
    ]);

    expect(openApiSpec.components.schemas.WebhookEndpoint.required).toEqual([
      'id',
      'tenantId',
      'organizationId',
      'url',
      'events',
      'status',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('documents one-time webhook signing secrets on endpoint creation', () => {
    expect(
      openApiSpec.paths['/webhook-endpoints'].post.responses['201'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/WebhookEndpointCreated' });
    expect(openApiSpec.components.schemas.WebhookEndpointCreated).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          required: ['secret'],
        }),
      ]),
    });
    expect(openApiSpec.components.schemas.WebhookEventType).toEqual({
      type: 'string',
      enum: [
        'order.created',
        'order.paid',
        'order.refunded',
        'order.disputed',
        'ticket.issued',
        'ticket.checked_in',
        'attendee.updated',
        'event.published',
        'event.cancelled',
      ],
    });
    const createEventsSchema =
      openApiSpec.paths['/webhook-endpoints'].post.requestBody.content['application/json'].schema
        .properties.events;
    expect(createEventsSchema).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/WebhookEventType' },
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
    });
    const updateEventsSchema =
      openApiSpec.paths['/webhook-endpoints/{endpointId}'].patch.requestBody.content[
        'application/json'
      ].schema.properties.events;
    expect(updateEventsSchema).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/WebhookEventType' },
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
    });
  });

  it('documents whole-event webhook replay queued responses', () => {
    expect(openApiSpec.components.schemas.WebhookReplayQueued).toEqual({
      type: 'object',
      properties: {
        queued: { type: 'boolean' },
        eventId: { type: 'string' },
        endpoints: { type: 'integer' },
      },
      required: ['queued', 'eventId', 'endpoints'],
    });
    expect(
      openApiSpec.paths['/webhook-events/{eventId}/replay'].post.responses['202'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/WebhookReplayQueued' });
  });

  it('documents brand payment account binding on response schemas', () => {
    expect(openApiSpec.components.schemas.Brand.properties).toHaveProperty('paymentAccountId');
    expect(
      openApiSpec.paths['/brands/{brandId}'].patch.requestBody.content['application/json'].schema
        .properties,
    ).toHaveProperty('paymentAccountId');
  });

  it('documents brand sender identity list responses', () => {
    expect(openApiSpec.components.schemas.BrandSenderIdentity).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        tenantId: { type: 'string' },
        brandId: { type: 'string' },
        email: { type: 'string', format: 'email' },
        replyToEmail: { type: 'string', format: 'email' },
        verified: { type: 'boolean' },
        verifiedAt: { type: 'string', format: 'date-time' },
      }),
    });
    expect(openApiSpec.components.schemas.BrandSenderIdentity.required).toEqual([
      'id',
      'tenantId',
      'brandId',
      'email',
      'name',
      'verified',
      'createdAt',
      'updatedAt',
    ]);
    expect(
      openApiSpec.paths['/brands/{brandId}/email-sender-identities'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/BrandSenderIdentity' },
    });
  });

  it('documents order sales-channel attribution for box-office reporting', () => {
    expect(openApiSpec.components.schemas.Organization.properties.boxOfficeSettings).toEqual({
      $ref: '#/components/schemas/BoxOfficeSettings',
    });
    expect(openApiSpec.components.schemas.Organization.required).toContain('boxOfficeSettings');
    expect(openApiSpec.components.schemas.BoxOfficeSettings).toEqual({
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        allowedTenderTypes: {
          type: 'array',
          items: { type: 'string', enum: ['cash', 'manual_card', 'comp'] },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
        requireBuyerEmail: { type: 'boolean' },
        receiptMode: { type: 'string', enum: ['print', 'email', 'both'] },
      },
      required: ['enabled', 'allowedTenderTypes', 'requireBuyerEmail', 'receiptMode'],
    });
    expect(
      openApiSpec.paths['/organizations/{organizationId}'].patch.requestBody.content[
        'application/json'
      ].schema.properties.boxOfficeSettings,
    ).toEqual({ $ref: '#/components/schemas/BoxOfficeSettings' });
    expect(openApiSpec.components.schemas.Order.properties.salesChannel).toEqual({
      type: 'string',
      enum: ['online', 'box_office'],
    });
    expect(openApiSpec.components.schemas.Order.properties.operatorId).toEqual({
      type: 'string',
    });
    expect(openApiSpec.components.schemas.Order.properties.tenderType).toEqual({
      type: 'string',
      enum: ['comp', 'cash', 'manual_card'],
    });
    expect(openApiSpec.components.schemas.SalesReport.properties.grossSalesByChannelCents).toEqual({
      type: 'object',
      properties: {
        online: { type: 'integer' },
        boxOffice: { type: 'integer' },
      },
      required: ['online', 'boxOffice'],
    });
    expect(openApiSpec.components.schemas.SalesReport.required).toContain(
      'grossSalesByChannelCents',
    );
  });

  it('documents Stripe Connect onboarding URL responses', () => {
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'onboardingUrl',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'detailsSubmitted',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'chargesEnabled',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'payoutsEnabled',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('requirements');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'disabledReason',
    );
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts/stripe-connect'].post
        .responses,
    ).toHaveProperty('201');
    expect(
      openApiSpec.paths[
        '/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh'
      ].post.responses,
    ).toHaveProperty('200');
  });

  it('documents signed QR payloads for online check-in scans', () => {
    const schema =
      openApiSpec.paths['/check-ins/scan'].post.requestBody.content['application/json'].schema;
    expect(schema.required).toEqual(['checkInListId', 'qrPayload', 'scannedAt']);
    expect(schema.properties).toHaveProperty('qrPayload');
    expect(schema.properties).not.toHaveProperty('qrHash');
    expect(openApiSpec.paths['/check-ins/scan'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/ScannerDeviceSecret',
    });
  });

  it('documents scanner manifest and check-in list contracts', () => {
    expect(openApiSpec.paths['/events/{eventId}/check-in-lists']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/check-in-lists'].get.security).toEqual([
      { ScannerDeviceAuth: [] },
      { BearerAuth: [] },
    ]);
    expect(openApiSpec.paths['/events/{eventId}/check-in-lists'].get.parameters).toContainEqual({
      $ref: '#/components/parameters/OptionalScannerDeviceSecret',
    });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CheckInListPage' });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get.responses[
        '200'
      ].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OfflineManifest' });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get.responses,
    ).toHaveProperty('400');
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/activity'].get.parameters,
    ).toContainEqual({
      name: 'afterId',
      in: 'query',
      schema: { type: 'string' },
    });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/activity/stream'].get
        .parameters,
    ).toContainEqual({
      name: 'Last-Event-ID',
      in: 'header',
      schema: { type: 'string' },
    });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/activity/stream'].get
        .responses['200'].content,
    ).toHaveProperty('text/event-stream');
    expect(openApiSpec.components.schemas.OfflineManifest.required).toContain('tickets');
    expect(openApiSpec.components.schemas.OfflineManifest.properties.tickets.maxItems).toBe(50_000);
    expect(openApiSpec.components.schemas.OfflineManifest.properties.tickets.description).toContain(
      '50,000 tickets',
    );
    expect(
      openApiSpec.components.schemas.OfflineManifest.properties.tickets.items.properties,
    ).toHaveProperty('eventOccurrenceId');
    expect(
      openApiSpec.components.schemas.OfflineManifest.properties.tickets.items.required,
    ).not.toContain('eventOccurrenceId');
    expect(openApiSpec.paths['/check-ins/sync'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(
      openApiSpec.paths['/check-ins/sync'].post.requestBody.content['application/json'].schema
        .properties.scans.maxItems,
    ).toBe(100_000);
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(
      openApiSpec.paths['/check-ins/bulk-sync-jobs'].post.requestBody.content['application/json']
        .schema.properties.totalScans.maximum,
    ).toBe(250_000);
    expect(
      openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}/chunks/{sequence}'].put.requestBody
        .content['application/json'].schema.properties.scans.maxItems,
    ).toBe(50_000);
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs'].post.description).toContain(
      'checkins.write',
    );
    expect(
      openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}/chunks/{sequence}'].put.description,
    ).toContain('checkins.write');
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}'].get.description).toContain(
      'checkins.read',
    );
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}/chunks'].get.description).toContain(
      'checkins.read',
    );
    expect(openApiSpec.components.schemas.BulkSyncJob.properties).not.toHaveProperty('results');
    expect(openApiSpec.components.schemas.BulkSyncJob.properties.sampleErrors.maxItems).toBe(25);
    expect(openApiSpec.components.schemas.BulkSyncErrorSample.properties).not.toHaveProperty(
      'qrHash',
    );
    expect(openApiSpec.components.schemas.BulkSyncErrorSample.required).not.toContain('qrHash');
  });

  it('documents remaining implemented backend route groups', () => {
    expect(openApiSpec.paths['/events/{eventId}/attendees']).toBeDefined();
    expect(openApiSpec.paths['/attendees/{attendeeId}']).toBeDefined();
    expect(openApiSpec.paths['/tickets/{ticketId}/transfer']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/resale-policy']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/resale-listings']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/resale-listings']).toBeDefined();
    expect(openApiSpec.paths['/tickets/{ticketId}/resale-listings']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/delist']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/complete']).toBeDefined();
    expect(
      openApiSpec.paths['/checkout/sessions/{sessionId}/tickets/{ticketId}/resale-listing'],
    ).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/inventory-pools']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/product-categories']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/products']).toBeDefined();
    expect(openApiSpec.paths['/products/{productId}']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/ticket-types/batch']).toBeDefined();
    expect(openApiSpec.paths['/ticket-types/{ticketTypeId}/batch']).toBeDefined();
    expect(openApiSpec.paths['/ticket-types/{ticketTypeId}/access-rules']).toBeDefined();
    expect(openApiSpec.paths['/access-rules/{accessRuleId}']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/questions/reorder']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/reports/sales']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/reports/tax']).toBeDefined();
    expect(openApiSpec.paths['/exports']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/messages']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/messages/preview']).toBeDefined();
    expect(openApiSpec.paths['/content-documents']).toBeDefined();
    expect(openApiSpec.paths['/content-documents/{documentId}/duplicate']).toBeDefined();
    expect(openApiSpec.paths['/content-documents/{documentId}/versions']).toBeDefined();
    expect(openApiSpec.paths['/content-documents/{documentId}/preview']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/page']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/content-page']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/revision']).toBeDefined();
    expect(openApiSpec.paths['/public/events/by-slug/{slug}/page']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/discovery-card']).toBeDefined();
    expect(openApiSpec.paths['/public/brand-logos/{artifactId}']).toBeDefined();
    expect(openApiSpec.paths['/webhook-events/{eventId}/replay']).toBeDefined();
    expect(
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events/{eventId}/replay'],
    ).toBeDefined();
    expect(openApiSpec.components.schemas.TicketTypeBatchResult.required).toEqual([
      'ticketType',
      'accessRules',
    ]);
    expect(openApiSpec.components.schemas.CreateTicketTypeBatch.required).toContain('ticketType');
  });

  it('documents type-specific permissions for export creation', () => {
    const postExport = openApiSpec.paths['/exports'].post;

    expect(postExport.description).toContain('reports.read');
    expect(postExport.description).toContain('attendees.read');
    expect(postExport.description).toContain('orders.read');
    expect(postExport.description).toContain('checkins.read');
    expect(postExport['x-required-permissions']).toEqual({
      base: ['reports.read'],
      byType: {
        attendees: ['attendees.read'],
        orders: ['orders.read'],
        sales: ['orders.read'],
        tax: ['orders.read'],
        tickets: ['checkins.read'],
        scan_logs: ['checkins.read'],
      },
    });
  });

  it('documents public event revisions and immutable brand logo streams', () => {
    expect(openApiSpec.components.schemas.PublicEventRevision).toEqual({
      type: 'object',
      properties: {
        revision: { type: 'string', nullable: true, format: 'date-time' },
      },
      required: ['revision'],
    });
    expect(
      openApiSpec.paths['/public/events/{eventId}/revision'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventRevision' });
    expect(openApiSpec.paths['/public/events/{eventId}/revision'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'eventId',
          in: 'path',
          required: true,
        }),
      ]),
    );

    const brandLogoResponse =
      openApiSpec.paths['/public/brand-logos/{artifactId}'].get.responses['200'];
    expect(brandLogoResponse.content['application/octet-stream'].schema).toEqual({
      type: 'string',
      format: 'binary',
    });
    expect(brandLogoResponse.headers['Cache-Control'].description).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(openApiSpec.paths['/public/brand-logos/{artifactId}'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'artifactId',
          in: 'path',
          required: true,
        }),
      ]),
    );
  });

  it('documents live export job statuses separately from queued export responses', () => {
    expect(openApiSpec.components.schemas.ExportJobQueued.properties.status.enum).toEqual([
      'pending',
    ]);
    expect(openApiSpec.components.schemas.ExportJob.properties.status.enum).toEqual([
      'pending',
      'processing',
      'completed',
      'failed',
    ]);
    expect(
      openApiSpec.paths['/exports/{exportId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/ExportJob' });
  });

  it('documents public availability ticket and product rows', () => {
    const schemas = openApiSpec.components.schemas;
    expect(schemas.PublicAvailabilityItem).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/PublicAvailabilityTicketItem' },
        { $ref: '#/components/schemas/PublicAvailabilityProductItem' },
      ],
    });

    expect(schemas.PublicAvailabilityTicketItem).toMatchObject({
      properties: {
        ticketTypeId: { type: 'string' },
        kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
      },
    });
    expect(schemas.PublicAvailabilityTicketItem.required).toContain('ticketTypeId');

    expect(schemas.PublicAvailabilityProductItem).toMatchObject({
      properties: {
        type: { type: 'string', enum: ['product'] },
        productId: { type: 'string' },
        kind: { type: 'string', enum: ['product'] },
      },
    });
    expect(schemas.PublicAvailabilityProductItem.required).toContain('productId');
    expect(schemas.PublicAvailabilityProductItem.required).not.toContain('ticketTypeId');

    const parameters = openApiSpec.paths['/public/events/{eventId}/availability'].get.parameters;
    expect(parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'eventId',
          in: 'path',
          required: true,
        }),
        expect.objectContaining({
          name: 'products',
          in: 'query',
          required: false,
        }),
      ]),
    );
  });

  it('documents public resale listings without internal seller or ticket fields', () => {
    const schema = openApiSpec.components.schemas.PublicTicketListing;
    expect(schema.properties).toMatchObject({
      id: { type: 'string' },
      eventId: { type: 'string' },
      priceCents: { type: 'integer', minimum: 0 },
      currency: { type: 'string', minLength: 3, maxLength: 3 },
      faceValueCents: { type: 'integer', minimum: 0 },
    });
    expect(schema.properties).not.toHaveProperty('tenantId');
    expect(schema.properties).not.toHaveProperty('sellerId');
    expect(schema.properties).not.toHaveProperty('ticketId');
    expect(openApiSpec.components.schemas.OrderLineItem.properties).toHaveProperty(
      'resaleListingId',
    );
    expect(
      openApiSpec.paths['/public/events/{eventId}/resale-listings'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicTicketListingPage' });
    expect(openApiSpec.paths['/public/events/{eventId}/resale-listings'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'eventId',
          in: 'path',
          required: true,
        }),
        expect.objectContaining({ name: 'cursor', in: 'query' }),
        expect.objectContaining({
          name: 'limit',
          in: 'query',
          schema: expect.objectContaining({ maximum: 50 }),
        }),
      ]),
    );
    const checkoutItemBranches =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema
        .properties.items.items.oneOf;
    const resaleCheckoutItemBranch = checkoutItemBranches.at(-1);
    expect(resaleCheckoutItemBranch).toBeDefined();
    expect(resaleCheckoutItemBranch!.not.anyOf).toEqual(
      expect.arrayContaining([
        { required: ['occurrenceId'] },
        { required: ['unitAmountCents'] },
        { required: ['attendeeFields'] },
      ]),
    );
  });

  it('documents split-key message campaign request and response contracts', () => {
    const messagePost = openApiSpec.paths['/events/{eventId}/messages'].post;
    const requestSchema = messagePost.requestBody.content['application/json'].schema;
    expect(messagePost.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(requestSchema.oneOf).toHaveLength(3);
    expect(requestSchema.oneOf.map((schema) => [...schema.required])).toEqual([
      ['emailTemplateKey', 'audience', 'channel'],
      ['smsTemplateKey', 'audience', 'channel'],
      ['emailTemplateKey', 'smsTemplateKey', 'audience', 'channel'],
    ]);
    expect(requestSchema.oneOf[0].properties).not.toHaveProperty('templateKey');
    expect(requestSchema.oneOf[0].properties.emailTemplateKey.maxLength).toBe(128);
    expect(requestSchema.oneOf[0].properties.scheduledAt).toEqual({
      type: 'string',
      format: 'date-time',
    });
    expect(requestSchema.oneOf[1].properties.smsTemplateKey.maxLength).toBe(128);
    expect(requestSchema.oneOf.every((schema) => 'scheduledAt' in schema.properties)).toBe(true);
    expect(messagePost.responses['202'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/MessageQueued',
    });

    const messageQueued = openApiSpec.components.schemas.MessageQueued;
    expect(messageQueued.properties).toMatchObject({
      campaignId: { type: 'string' },
      eventId: { type: 'string' },
      emailTemplateKey: { type: 'string' },
      smsTemplateKey: { type: 'string' },
      status: { type: 'string' },
      queuedEmailJobs: { type: 'integer' },
      queuedSmsJobs: { type: 'integer' },
      scheduledAt: { type: 'string', format: 'date-time' },
    });
    expect(messageQueued.required).toEqual(
      expect.arrayContaining([
        'campaignId',
        'eventId',
        'channel',
        'status',
        'audienceCount',
        'queuedEmailJobs',
        'queuedSmsJobs',
        'emailJobIds',
        'smsJobIds',
      ]),
    );
    expect(messageQueued.properties).not.toHaveProperty('queued');
    expect(messageQueued.properties).not.toHaveProperty('jobIds');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('to_email');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('to_phone');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('body');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('variables');
    expect(openApiSpec.components.schemas.MessageProviderEvent.properties).not.toHaveProperty(
      'raw_payload',
    );

    const renderPreviewPost = openApiSpec.paths['/events/{eventId}/messages/render-preview'].post;
    expect(
      renderPreviewPost.requestBody.content['application/json'].schema.additionalProperties,
    ).toBe(false);
    expect(renderPreviewPost.responses).toHaveProperty('400');
  });

  it('documents message list envelopes and delivery-log schemas', () => {
    const messageListSchema =
      openApiSpec.paths['/events/{eventId}/messages'].get.responses['200'].content[
        'application/json'
      ].schema;
    expect(messageListSchema.required).toEqual(['items']);
    expect(messageListSchema.properties).not.toHaveProperty('nextCursor');
    expect(messageListSchema.properties).not.toHaveProperty('hasMore');

    const jobsSchema =
      openApiSpec.paths['/events/{eventId}/messages/{campaignId}/jobs'].get.responses['200']
        .content['application/json'].schema;
    expect(jobsSchema).toMatchObject({
      required: ['items'],
      properties: {
        items: { items: { $ref: '#/components/schemas/MessageJobEnvelope' } },
      },
    });
    expect(jobsSchema.properties).not.toHaveProperty('nextCursor');
    expect(jobsSchema.properties).not.toHaveProperty('hasMore');

    const deliveryLogsSchema =
      openApiSpec.paths['/events/{eventId}/messages/{campaignId}/delivery-logs'].get.responses[
        '200'
      ].content['application/json'].schema;
    expect(deliveryLogsSchema).toMatchObject({
      required: ['items'],
      properties: {
        items: {
          items: { $ref: '#/components/schemas/MessageDeliveryLogEnvelope' },
        },
      },
    });
    expect(
      openApiSpec.paths[
        '/events/{eventId}/messages/{campaignId}/delivery-logs/{channel}/{deliveryId}'
      ].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/MessageDeliveryLogEnvelope' });
    expect(openApiSpec.components.schemas.MessageDeliveryLogEnvelope.required).toEqual([
      'channel',
      'campaignId',
      'eventId',
      'delivery',
    ]);

    const providerEventsSchema =
      openApiSpec.paths['/events/{eventId}/messages/{campaignId}/provider-events'].get.responses[
        '200'
      ].content['application/json'].schema;
    expect(providerEventsSchema).toMatchObject({
      required: ['items'],
      properties: {
        items: {
          items: { $ref: '#/components/schemas/MessageProviderEventEnvelope' },
        },
      },
    });
    expect(providerEventsSchema.properties).not.toHaveProperty('nextCursor');
    expect(providerEventsSchema.properties).not.toHaveProperty('hasMore');
  });

  it('documents content-studio document lifecycle contracts', () => {
    expect(openApiSpec.components.schemas.ContentDocument.properties.channel.enum).toEqual([
      'event_page',
      'email',
      'sms',
      'imessage',
      'social_invite',
    ]);
    expect(openApiSpec.paths['/content-documents'].get.parameters).toEqual([
      { name: 'channel', in: 'query', schema: { type: 'string' } },
      { name: 'brandId', in: 'query', schema: { type: 'string' } },
      { name: 'eventId', in: 'query', schema: { type: 'string' } },
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ]);
    expect(openApiSpec.components.schemas.ContentDocumentVersion.properties.validation).toEqual({
      $ref: '#/components/schemas/ContentValidationResult',
    });
    expect(openApiSpec.components.schemas.ContentRenderOutput.properties.segments).toMatchObject({
      type: 'integer',
    });
    expect(openApiSpec.components.schemas.ContentPreview.properties.renderArtifact).toEqual({
      $ref: '#/components/schemas/ContentRenderArtifact',
    });
    expect(openApiSpec.components.schemas.ContentRenderArtifact.properties.outputType.enum).toEqual(
      ['preview', 'test_send', 'send'],
    );
    expect(openApiSpec.components.schemas.ContentRenderArtifact.required).toEqual([
      'id',
      'tenantId',
      'documentId',
      'versionId',
      'channel',
      'outputType',
      'artifactRef',
      'checksum',
      'createdAt',
    ]);
    expect(
      openApiSpec.components.schemas.EmailTemplateDocument.properties.editor.properties.provider
        .enum,
    ).toEqual(['@react-email/editor']);
    expect(openApiSpec.components.schemas.EmailTemplateDocument.example).toMatchObject({
      schemaVersion: 1,
      editor: { provider: '@react-email/editor' },
      settings: {
        templateKey: 'order-confirmed',
        category: 'transactional',
        sender: {
          fromEmail: 'tickets@example.test',
          replyToEmail: 'support@example.test',
        },
      },
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'event_hero' }),
        expect.objectContaining({ type: 'ticket_summary' }),
        expect.objectContaining({ type: 'unsubscribe_footer' }),
      ]),
    });
    expect(
      openApiSpec.components.schemas.SmsTemplateDocument.properties.editor.properties.provider.enum,
    ).toEqual(['@tixkit/content-message/sms-composer']);
    expect(openApiSpec.components.schemas.SmsTemplateDocument.example).toMatchObject({
      schemaVersion: 1,
      editor: {
        provider: '@tixkit/content-message/sms-composer',
        body: expect.stringContaining('{{event.title}}'),
      },
      settings: {
        templateKey: 'event-reminder-sms',
        category: 'bulk',
        consentCategory: 'marketing',
        optOutText: 'Reply STOP to opt out',
      },
      shortLinks: [
        {
          originalUrl: '{{event.checkoutUrl}}',
          reason: 'long_url',
          field: 'editor.body',
        },
      ],
    });
    expect(
      openApiSpec.paths['/content-documents/{documentId}/versions'].post.requestBody.content[
        'application/json'
      ].schema.properties.contentJson.oneOf,
    ).toEqual([
      { $ref: '#/components/schemas/EventPageDocumentV2' },
      { $ref: '#/components/schemas/EmailTemplateDocument' },
      { $ref: '#/components/schemas/SmsTemplateDocument' },
      { type: 'object', additionalProperties: true },
    ]);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/preview'].post.requestBody.content[
        'application/json'
      ].schema.properties.contentJson.oneOf,
    ).toEqual([
      { $ref: '#/components/schemas/EventPageDocumentV2' },
      { $ref: '#/components/schemas/EmailTemplateDocument' },
      { $ref: '#/components/schemas/SmsTemplateDocument' },
      { type: 'object', additionalProperties: true },
    ]);
    expect(openApiSpec.paths['/content-documents'].post.responses['400'].description).toContain(
      'unavailable',
    );
    expect(
      openApiSpec.paths['/content-documents/{documentId}/versions/{versionId}/publish'].post
        .responses['200'].content['application/json'].schema.required,
    ).toEqual(['document', 'version']);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/duplicate'].post.responses['201'].content[
        'application/json'
      ].schema.required,
    ).toEqual(['document', 'versions']);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/test-sends'].post.responses['202'].content[
        'application/json'
      ].schema.required,
    ).toEqual(['testSend', 'output', 'renderArtifact']);
    expect(
      openApiSpec.paths['/public/events/{eventId}/content-page'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicContentPage' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/page'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicContentPage' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/bootstrap'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicCheckoutBootstrap' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/page-bootstrap'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventPageBootstrap' });
    expect(
      openApiSpec.paths['/public/events/{eventId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEvent' });
    expect(
      openApiSpec.paths['/public/events/by-slug/{slug}'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEvent' });
    expect(openApiSpec.components.schemas.PublicCheckoutBootstrap.properties.event).toEqual({
      $ref: '#/components/schemas/PublicEvent',
    });
    expect(openApiSpec.components.schemas.PublicEventPageBootstrap.properties.event).toEqual({
      $ref: '#/components/schemas/PublicEvent',
    });
    expect(openApiSpec.components.schemas.PublicEvent.required).toEqual([
      'id',
      'slug',
      'title',
      'description',
      'status',
      'timezone',
      'startsAt',
      'endsAt',
      'venue',
      'brandId',
      'minimumAge',
      'marketingIntegrations',
    ]);
    expect(openApiSpec.components.schemas.PublicEvent.properties).not.toHaveProperty('currency');
    expect(openApiSpec.components.schemas.PublicEvent.properties).not.toHaveProperty('visibility');
    expect(openApiSpec.components.schemas.PublicEvent.properties).not.toHaveProperty(
      'resalePolicy',
    );
    expect(
      openApiSpec.components.schemas.PublicEvent.properties.marketingIntegrations.items,
    ).toEqual({
      $ref: '#/components/schemas/PublicMarketingIntegration',
    });
    expect(openApiSpec.components.schemas.PublicMarketingIntegration.properties).not.toHaveProperty(
      'tenantId',
    );
    expect(
      openApiSpec.paths['/public/events/by-slug/{slug}/page-bootstrap'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventPageBootstrap' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/discovery-card'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventDiscoveryCard' });
    expect(openApiSpec.paths).not.toHaveProperty('/public/events/{eventId}/draft-preview');
    expect(openApiSpec.paths).not.toHaveProperty('/content-documents/{documentId}/preview-token');
    expect(openApiSpec.paths).toHaveProperty('/content-documents/migrate-event-page-puck');
    expect(openApiSpec.paths).toHaveProperty('/public/content-event-page-images/{artifactId}');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.document.properties,
    ).not.toHaveProperty('tenantId');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('contentJson');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('renderedHtml');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('renderedText');
    expect(openApiSpec.components.schemas.PublicContentPage.properties.page.required).toEqual([
      'provider',
      'puckData',
      'settings',
      'discovery',
    ]);
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties.puckData,
    ).toEqual({ $ref: '#/components/schemas/PuckData' });
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties.provider.enum,
    ).toEqual(['@puckeditor/core']);
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('html');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('text');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('headless');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('renderModel');
    expect(openApiSpec.components.schemas.EventPageDocumentV2.required).toEqual([
      'schemaVersion',
      'editor',
    ]);
    expect(openApiSpec.components.schemas.EventPageDocumentV2.properties.editor.required).toEqual([
      'provider',
      'data',
    ]);
    expect(
      openApiSpec.components.schemas.EventPageDocumentV2.properties.editor.properties.provider.enum,
    ).toEqual(['@puckeditor/core']);
    expect(openApiSpec.components.schemas.PuckData.required).toEqual(['content', 'root']);
    expect(openApiSpec.components.schemas.PuckData.properties.content.items).toEqual({
      $ref: '#/components/schemas/PuckComponentData',
    });
    expect(openApiSpec.components.schemas.PuckData.properties.zones.deprecated).toBe(true);
    expect(openApiSpec.components.schemas).not.toHaveProperty('PublicEventPageBlock');
    expect(openApiSpec.components.schemas).not.toHaveProperty('ResolvedEventPage');
    expect(openApiSpec.components.schemas).not.toHaveProperty('ResolvedEventPageBlock');
    expect(openApiSpec.components.schemas.DraftPreviewPage.required).toEqual([
      'document',
      'version',
      'contentJson',
      'context',
      'validation',
    ]);
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties.document.required).toEqual([
      'eventId',
      'channel',
      'key',
      'name',
      'locale',
      'updatedAt',
    ]);
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties.version.required).toEqual([
      'versionNumber',
      'status',
    ]);
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties).not.toHaveProperty(
      'versionId',
    );
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties.contentJson).toEqual({
      $ref: '#/components/schemas/EventPageDocumentV2',
    });
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties).not.toHaveProperty(
      'renderModel',
    );
  });

  it('documents checkout tracking separately from affiliate attribution', () => {
    const checkoutSessionBody =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema;
    expect(checkoutSessionBody.properties.affiliateCode).toEqual({
      type: 'string',
    });
    expect(checkoutSessionBody.properties.trackingId).toEqual({
      type: 'string',
    });
  });

  it('documents report contracts from live route shapes', () => {
    expect(openApiSpec.components.schemas.SalesReport.properties.range).toEqual({
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
      },
      required: ['from', 'to'],
    });
    expect(openApiSpec.components.schemas.SalesReport.required).toContain('range');
    expect(
      openApiSpec.components.schemas.TaxReport.properties.breakdown.items.properties.rate,
    ).toEqual({
      type: ['number', 'null'],
    });
    expect(openApiSpec.paths['/events/{eventId}/reports/tax'].get.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'from',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
        },
        {
          name: 'to',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
        },
      ]),
    );
    expect(
      openApiSpec.paths['/events/{eventId}/reports/attendance'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/AttendanceReport' });
    expect(
      openApiSpec.paths['/events/{eventId}/reports/promo'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PromoReport' });
    expect(
      openApiSpec.paths['/organizations/{organizationId}/reports/affiliate'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/AffiliateReport' });
    expect(openApiSpec.components.schemas.AttendanceReport.required).toEqual([
      'eventId',
      'totalAttendees',
      'checkedIn',
      'notCheckedIn',
      'checkInRate',
      'breakdownByTicketType',
    ]);
    expect(openApiSpec.components.schemas.PromoReport.required).toEqual([
      'eventId',
      'discountCodes',
    ]);
    expect(openApiSpec.components.schemas.AffiliateReport.required).toEqual([
      'organizationId',
      'affiliates',
    ]);
  });

  it('documents box-office order creation as an idempotent admin mutation', () => {
    const route = openApiSpec.paths['/events/{eventId}/box-office/orders'].post;
    expect(route.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    expect(route.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(route.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BoxOfficeOrderInput',
    });
    expect(route.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BoxOfficeOrderResult',
    });
    expect(openApiSpec.components.schemas.BoxOfficeOrderInput.properties.tenderType).toEqual({
      type: 'string',
      enum: ['comp', 'cash', 'manual_card'],
    });
  });

  it('documents checkout session recovery through token header or payment intent client secret', () => {
    expect(openApiSpec.components.parameters.OptionalCheckoutSessionToken).toMatchObject({
      name: 'X-Checkout-Session-Token',
      in: 'header',
      required: false,
    });
    expect(openApiSpec.components.parameters.PaymentIntentClientSecret).toMatchObject({
      name: 'payment_intent_client_secret',
      in: 'query',
      required: false,
    });
    expect(openApiSpec.paths['/checkout/sessions/{sessionId}'].get.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'sessionId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        { $ref: '#/components/parameters/OptionalCheckoutSessionToken' },
        { $ref: '#/components/parameters/PaymentIntentClientSecret' },
      ]),
    );
  });

  it('documents checkout session updates with their runtime request body', () => {
    const route = openApiSpec.paths['/checkout/sessions/{sessionId}'].patch;
    expect(route.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'sessionId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        { $ref: '#/components/parameters/CheckoutSessionToken' },
      ]),
    );
    expect(route.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CheckoutSessionUpdateInput',
    });
    expect(openApiSpec.components.schemas.CheckoutSessionUpdateInput.properties).toEqual({
      buyer: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      successUrl: { type: 'string', format: 'uri' },
      cancelUrl: { type: 'string', format: 'uri' },
    });
  });

  it('documents attendee updates with their runtime request body', () => {
    const route = openApiSpec.paths['/attendees/{attendeeId}'].patch;
    expect(route.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/AttendeeUpdateInput',
    });
    expect(openApiSpec.components.schemas.AttendeeUpdateInput.properties).toEqual({
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      email: { type: 'string', format: 'email' },
      phone: { type: ['string', 'null'] },
      status: {
        type: 'string',
        enum: ['pending', 'confirmed', 'cancelled', 'refunded', 'checked_in'],
      },
    });
  });

  it('documents admin table query params and runtime page envelopes', () => {
    for (const [path, pageSchema] of [
      ['/events', 'EventPage'],
      ['/orders', 'OrderPage'],
      ['/events/{eventId}/attendees', 'AttendeePage'],
      ['/attendees', 'AttendeePage'],
      ['/audit-logs', 'AuditLogPage'],
      ['/privacy/requests', 'PrivacyRequestPage'],
    ] as const) {
      const params = openApiSpec.paths[path].get.parameters;
      expect(params).toEqual(
        expect.arrayContaining([
          { $ref: '#/components/parameters/AdminTableCursor' },
          { $ref: '#/components/parameters/AdminTableDirection' },
          { $ref: '#/components/parameters/AdminTableLimit' },
          { $ref: '#/components/parameters/AdminTableSearch' },
          { $ref: '#/components/parameters/AdminTableSort' },
          { $ref: '#/components/parameters/AdminTableIncludeFacets' },
          { $ref: '#/components/parameters/AdminTableIncludeTotal' },
        ]),
      );
      expect(
        openApiSpec.paths[path].get.responses['200'].content['application/json'].schema,
      ).toEqual({ $ref: `#/components/schemas/${pageSchema}` });
      const schema = openApiSpec.components.schemas[pageSchema];
      expect(schema.properties).toMatchObject({
        nextCursor: { type: ['string', 'null'] },
        prevCursor: { type: ['string', 'null'] },
        total: { type: 'integer' },
        filterTotal: { type: 'integer' },
        facets: {
          type: 'object',
          additionalProperties: {
            $ref: '#/components/schemas/AdminTableFacet',
          },
        },
        applied: { $ref: '#/components/schemas/AdminTableAppliedQuery' },
      });
      expect(schema.properties).not.toHaveProperty('hasMore');
      expect(schema.required).toEqual(['items']);
    }

    expect(openApiSpec.paths['/orders'].get.parameters).toEqual(
      expect.arrayContaining([
        { name: 'organizationId', in: 'query', schema: { type: 'string' } },
        { name: 'eventId', in: 'query', schema: { type: 'string' } },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
        {
          name: 'refundState',
          in: 'query',
          required: false,
          schema: { type: 'boolean' },
        },
      ]),
    );
  });

  it('documents conversion widget impressions as persisted counts', () => {
    const schema =
      openApiSpec.paths['/events/{eventId}/reports/conversion'].get.responses['200'].content[
        'application/json'
      ].schema;
    expect(schema.required).toContain('widgetViews');
    expect(schema.properties.widgetViews).toEqual({ type: 'number' });
  });

  it('documents public widget impression ingestion', () => {
    const path = openApiSpec.paths['/public/events/{eventId}/widget-impressions'];
    expect(path.post).toBeDefined();
    expect(path.post.responses['201']).toBeDefined();
    const body = path.post.requestBody.content['application/json'].schema;
    expect(body.properties.visitorId).toMatchObject({ type: 'string' });
  });

  it('documents marketing integration management and public exposure', () => {
    expect(openApiSpec.components.schemas.MarketingIntegration.properties.provider.enum).toEqual([
      'ga4',
      'meta_pixel',
      'generic_tag',
    ]);
    expect(
      openApiSpec.paths['/events/{eventId}/marketing-integrations'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/MarketingIntegrationPage' });
    expect(openApiSpec.paths['/events/{eventId}/marketing-integrations'].get.parameters).toEqual([
      {
        name: 'eventId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ]);

    const upsertOperation =
      openApiSpec.paths['/events/{eventId}/marketing-integrations/{provider}'].put;
    expect(upsertOperation.parameters).toEqual([
      {
        name: 'eventId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'provider',
        in: 'path',
        required: true,
        schema: { type: 'string', enum: ['ga4', 'meta_pixel', 'generic_tag'] },
      },
    ]);
    const upsertBody = upsertOperation.requestBody.content['application/json'].schema;
    expect(upsertBody.required).toEqual(['config']);
    expect(Object.hasOwn(upsertBody.properties, 'provider')).toBe(false);
    expect(
      openApiSpec.paths['/public/events/{eventId}/marketing-integrations'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/MarketingIntegrationPage' });
  });

  it('requires public upload completion tokens without requiring them for authenticated completion', () => {
    expect(openApiSpec.components.schemas.CreateUploadArtifact).toMatchObject({
      required: ['purpose', 'fileName', 'contentType', 'sizeBytes'],
      properties: {
        purpose: {
          type: 'string',
          enum: [
            'checkout_answer',
            'brand_logo',
            'user_avatar',
            'content_email_image',
            'content_event_page_image',
            'migration_import',
            'event_cover',
            'event_seo_image',
          ],
        },
      },
    });

    expect(openApiSpec.components.schemas.PublicCreateUploadArtifact).toMatchObject({
      required: ['fileName', 'contentType', 'sizeBytes', 'questionId'],
      properties: {
        questionId: { type: 'string', minLength: 1 },
      },
    });

    expect(openApiSpec.components.schemas.PublicCompleteUploadArtifact).toMatchObject({
      required: ['token'],
      properties: {
        token: { type: 'string', minLength: 1 },
      },
    });

    expect(
      openApiSpec.paths['/public/upload-artifacts/{artifactId}/complete'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicCompleteUploadArtifact' });
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CompleteUploadArtifact' });
    expect(openApiSpec.components.schemas.CompleteUploadArtifact).not.toHaveProperty('required');
    expect(openApiSpec.components.schemas.CompleteUploadArtifact.properties).not.toHaveProperty(
      'token',
    );
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post.requestBody.required,
    ).toBe(false);
  });

  it('documents durable upload artifact download responses', () => {
    expect(openApiSpec.components.schemas.UploadArtifactDownload).toMatchObject({
      required: ['downloadUrl'],
      properties: {
        downloadUrl: {
          type: 'string',
          description: expect.stringContaining('durable relative API path'),
        },
        durable: { type: 'boolean' },
      },
    });
    expect(
      openApiSpec.components.schemas.UploadArtifactDownload.properties.downloadUrl,
    ).not.toHaveProperty('format');
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/download'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/UploadArtifactDownload' });
  });

  it('keeps offline sync outcomes in the generated schema source of truth', () => {
    expect(openApiSpec.components.schemas.ScanResult.properties.outcome.enum).toEqual([
      'accepted',
      'duplicate',
      'invalid',
      'revoked',
      'not_found',
      'wrong_event',
      'wrong_list',
    ]);
  });

  it('documents the atomic checkout-question reorder contract', () => {
    const path = openApiSpec.paths['/events/{eventId}/questions/reorder'];
    expect(path.post).toBeDefined();
    expect(path.post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ReorderQuestionsRequest',
    });
    expect(path.post.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/QuestionPage',
    });
    expect(openApiSpec.components.schemas.ReorderQuestionsRequest).toMatchObject({
      required: ['questions'],
      properties: {
        questions: expect.objectContaining({ minItems: 1 }),
      },
    });
  });

  it('documents supported question update fields', () => {
    const updateSchema =
      openApiSpec.paths['/questions/{questionId}'].patch.requestBody.content['application/json']
        .schema;

    expect(updateSchema.properties).toMatchObject({
      ticketTypeId: { type: ['string', 'null'] },
      conditionalVisibility: { type: ['object', 'null'] },
    });
  });

  it('documents validation patterns on public checkout questions', () => {
    expect(
      openApiSpec.paths['/public/events/{eventId}/questions'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicQuestionsResponse' });
    expect(openApiSpec.components.schemas.PublicQuestionsResponse.properties).toMatchObject({
      buyerQuestions: {
        type: 'array',
        items: { $ref: '#/components/schemas/Question' },
      },
      attendeeQuestions: {
        type: 'array',
        items: { $ref: '#/components/schemas/Question' },
      },
    });
    expect(openApiSpec.components.schemas.Question.properties.validationPattern).toEqual({
      type: 'string',
    });
  });

  it('documents audit logging and GDPR privacy request routes', () => {
    expect(
      openApiSpec.paths['/audit-logs'].get.responses['200'].content['application/json'].schema,
    ).toEqual({
      $ref: '#/components/schemas/AuditLogPage',
    });
    expect(openApiSpec.components.schemas.PrivacyRequestInput).toMatchObject({
      required: ['organizationId', 'subjectType'],
      anyOf: [{ required: ['subjectId'] }, { required: ['subjectEmail'] }],
      properties: {
        subjectId: { type: 'string' },
        subjectEmail: { type: 'string', format: 'email' },
      },
    });
    expect(openApiSpec.paths['/privacy/data-exports'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(
      openApiSpec.paths['/privacy/erasures'].post.requestBody.content['application/json'].schema,
    ).toEqual({
      $ref: '#/components/schemas/PrivacyRequestInput',
    });
  });

  it('documents implemented status codes and required idempotency headers', () => {
    expect(
      openApiSpec.paths['/orders/{orderId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/OrderDetail' });
    expect(openApiSpec.components.schemas.Order.properties).not.toHaveProperty('attendees');
    expect(openApiSpec.components.schemas.Order.properties).not.toHaveProperty('refunds');
    const orderDetailProperties = openApiSpec.components.schemas.OrderDetail.allOf[1].properties;
    expect(orderDetailProperties).toMatchObject({
      attendees: {
        type: 'array',
        items: { $ref: '#/components/schemas/Attendee' },
      },
      refunds: {
        type: 'array',
        items: { $ref: '#/components/schemas/Refund' },
      },
      checkoutAnswers: {
        type: 'object',
        properties: {
          buyerFields: { type: 'object', additionalProperties: true },
          attendeeFields: { type: 'object', additionalProperties: true },
        },
        required: ['buyerFields', 'attendeeFields'],
      },
      consentSnapshots: { type: 'object', additionalProperties: true },
      deliveryStatus: {
        type: 'object',
        properties: {
          email: { type: 'string', enum: ['pending', 'not_applicable'] },
          tickets: { type: 'string', enum: ['issued', 'not_issued'] },
        },
        required: ['email', 'tickets'],
      },
    });
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.responses).toHaveProperty('202');
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.responses).not.toHaveProperty('201');
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/orders/{orderId}/cancel'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/checkout/sessions'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
  });

  it('documents the durable organization invitation contract', () => {
    const operation = openApiSpec.paths['/organizations/{organizationId}/members/invitations'].post;
    const requestSchema = operation.requestBody.content['application/json'].schema;
    const responseSchema = operation.responses['201'].content['application/json'].schema;

    expect(operation.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(requestSchema.properties.returnTo).toMatchObject({
      type: 'string',
      maxLength: 500,
    });
    expect(
      openApiSpec.paths['/api-keys'].post.requestBody.content['application/json'].schema.properties,
    ).not.toHaveProperty('returnTo');
    expect(responseSchema.properties).toMatchObject({
      brandIds: { type: 'array', items: { type: 'string' } },
      eventIds: { type: 'array', items: { type: 'string' } },
      invitationDelivery: { type: 'string', enum: ['queued'] },
      invitationProvider: { type: 'string' },
    });
  });

  it('keeps event create/update schemas aligned with backend currency and status contracts', () => {
    const eventSchema = openApiSpec.components.schemas.Event;
    expect(eventSchema.required).toContain('currency');
    expect(eventSchema.properties).toHaveProperty('currency');
    expect(eventSchema.properties).toHaveProperty('status');
    expect(eventSchema.required).toEqual(
      expect.arrayContaining([
        'tenantId',
        'organizationId',
        'brandId',
        'minimumAge',
        'grossSalesCents',
        'ticketsSold',
        'checkIns',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(eventSchema.properties.minimumAge).toEqual({
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 120,
    });

    const createSchema =
      openApiSpec.paths['/events'].post.requestBody.content['application/json'].schema;
    expect(createSchema.required).toContain('currency');
    expect(createSchema.properties).toHaveProperty('currency');
    expect(createSchema.properties).toHaveProperty('minimumAge');
    expect(
      openApiSpec.paths['/events'].post.responses['201'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/Event' });
    expect(
      openApiSpec.paths['/events/{eventId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/Event' });

    const updateSchema =
      openApiSpec.paths['/events/{eventId}'].patch.requestBody.content['application/json'].schema;
    expect(updateSchema.properties).toHaveProperty('currency');
    expect(updateSchema.properties).toHaveProperty('minimumAge');
    expect(updateSchema.properties).not.toHaveProperty('status');
    expect(openApiSpec.paths['/events/{eventId}/publish'].post.responses['200']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/pause'].post.responses['200']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/archive'].post.responses['200']).toBeDefined();
  });

  it('assigns a unique stable operation ID and product tag to every operation', () => {
    const operations = Object.entries(openApiSpec.paths).flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) =>
          ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method),
        )
        .map(([method, operation]) => ({ path, method, operation })),
    );
    const operationIds = operations.map(({ operation }) => operation.operationId);
    expect(
      operationIds.every(
        (operationId) => typeof operationId === 'string' && operationId.length > 0,
      ),
    ).toBe(true);
    expect(new Set(operationIds).size).toBe(operations.length);
    expect(
      operations.every(
        ({ operation }) => Array.isArray(operation.tags) && operation.tags.length > 0,
      ),
    ).toBe(true);
    expect(openApiSpec.paths['/events/{eventId}'].get).toMatchObject({
      operationId: 'getEventsByEventId',
      tags: ['Events'],
    });
  });

  it('declares anonymous, authenticated, and provider-signature security explicitly', () => {
    expect(openApiSpec.paths['/public/events/{eventId}'].get.security).toEqual([]);
    expect(openApiSpec.paths['/checkout/sessions'].post.security).toEqual([]);
    expect(openApiSpec.paths['/events'].get.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    expect(openApiSpec.paths['/webhooks/stripe'].post.security).toEqual([{ StripeSignature: [] }]);
    expect(openApiSpec.components.securitySchemes).toHaveProperty('SvixSignature');
    expect(openApiSpec.components.securitySchemes).toHaveProperty('TelnyxSignature');
    expect(openApiSpec.components.securitySchemes).toHaveProperty('EmailProviderSignature');
  });

  it('documents migration credential references as write-only and scoped revocation inputs', () => {
    const create = openApiSpec.paths['/migration-credentials'].post;
    const schema = create.requestBody.content['application/json'].schema;
    expect(schema.properties.secretReference).toMatchObject({
      type: 'string',
      writeOnly: true,
      pattern: expect.stringContaining('secretmanager'),
    });

    const revoke = openApiSpec.paths['/migration-credentials/{credentialId}'].delete;
    expect(revoke.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'credentialId', in: 'path', required: true }),
        expect.objectContaining({ name: 'organizationId', in: 'query', required: true }),
      ]),
    );
  });
});
