import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OpenApiParameter } from '../index.js';
import { openApiSpec } from '../index.js';

describe('openApiSpec', () => {
  it('publishes the documented API lifecycle version', () => {
    expect(openApiSpec.info.version).toBe('2026-01-01');
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
      { url: 'https://api.tixkit.com', description: 'Production operational root' },
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
    ).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Organization' } });
    expect(openApiSpec.paths['/organizations'].get.parameters).toBeUndefined();
    expect(
      openApiSpec.paths['/brands'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Brand' } });
    expect(openApiSpec.paths['/brands'].get.parameters).toBeUndefined();
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ type: 'array', items: { $ref: '#/components/schemas/PaymentAccount' } });
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
    expect(
      Object.keys(
        openApiSpec.paths['/oauth-applications'].post.requestBody.content['application/json'].schema
          .properties,
      ).sort(),
    ).toEqual(['name', 'organizationId', 'redirectUris', 'scopes']);
    expect(openApiSpec.paths).not.toHaveProperty('/developer/api-keys');
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
      maxItems: 8,
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
      maxItems: 8,
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
    expect(openApiSpec.components.schemas.Order.properties.operatorId).toEqual({ type: 'string' });
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
        expect.objectContaining({ name: 'eventId', in: 'path', required: true }),
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
        expect.objectContaining({ name: 'artifactId', in: 'path', required: true }),
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
        expect.objectContaining({ name: 'eventId', in: 'path', required: true }),
        expect.objectContaining({ name: 'products', in: 'query', required: false }),
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
        expect.objectContaining({ name: 'eventId', in: 'path', required: true }),
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
        items: { items: { $ref: '#/components/schemas/MessageDeliveryLogEnvelope' } },
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
        items: { items: { $ref: '#/components/schemas/MessageProviderEventEnvelope' } },
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
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
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
      { $ref: '#/components/schemas/EmailTemplateDocument' },
      { $ref: '#/components/schemas/SmsTemplateDocument' },
      { type: 'object', additionalProperties: true },
    ]);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/preview'].post.requestBody.content[
        'application/json'
      ].schema.properties.contentJson.oneOf,
    ).toEqual([
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
      openApiSpec.paths['/public/events/{eventId}/discovery-card'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventDiscoveryCard' });
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.document.properties,
    ).not.toHaveProperty('tenantId');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('contentJson');
    expect(openApiSpec.components.schemas.PublicContentPage.properties.page.required).toEqual([
      'html',
      'text',
      'headless',
      'renderModel',
      'discovery',
    ]);
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties.renderModel,
    ).toEqual({ $ref: '#/components/schemas/ResolvedEventPage' });
  });

  it('documents checkout tracking separately from affiliate attribution', () => {
    const checkoutSessionBody =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema;
    expect(checkoutSessionBody.properties.affiliateCode).toEqual({ type: 'string' });
    expect(checkoutSessionBody.properties.trackingId).toEqual({ type: 'string' });
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
        { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
        { $ref: '#/components/parameters/OptionalCheckoutSessionToken' },
        { $ref: '#/components/parameters/PaymentIntentClientSecret' },
      ]),
    );
  });

  it('documents implemented order list filters', () => {
    expect(openApiSpec.paths['/orders'].get.parameters).toEqual([
      { $ref: '#/components/parameters/Cursor' },
      { $ref: '#/components/parameters/Limit' },
      { name: 'organizationId', in: 'query', schema: { type: 'string' } },
      { name: 'eventId', in: 'query', schema: { type: 'string' } },
    ]);
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
          enum: ['checkout_answer', 'brand_logo', 'user_avatar', 'content_email_image'],
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
      buyerQuestions: { type: 'array', items: { $ref: '#/components/schemas/Question' } },
      attendeeQuestions: { type: 'array', items: { $ref: '#/components/schemas/Question' } },
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
      attendees: { type: 'array', items: { $ref: '#/components/schemas/Attendee' } },
      refunds: { type: 'array', items: { $ref: '#/components/schemas/Refund' } },
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
    expect(openApiSpec.paths['/orders/{orderId}/cancel'].post.parameters).toEqual([
      { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(openApiSpec.paths['/checkout/sessions'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
  });

  it('keeps event create/update schemas aligned with backend currency and status contracts', () => {
    const eventSchema = openApiSpec.components.schemas.Event;
    expect(eventSchema.required).toContain('currency');
    expect(eventSchema.properties).toHaveProperty('currency');
    expect(eventSchema.properties).toHaveProperty('status');

    const createSchema =
      openApiSpec.paths['/events'].post.requestBody.content['application/json'].schema;
    expect(createSchema.required).toContain('currency');
    expect(createSchema.properties).toHaveProperty('currency');

    const updateSchema =
      openApiSpec.paths['/events/{eventId}'].patch.requestBody.content['application/json'].schema;
    expect(updateSchema.properties).toHaveProperty('currency');
    expect(updateSchema.properties).not.toHaveProperty('status');
    expect(openApiSpec.paths['/events/{eventId}/publish'].post.responses['200']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/pause'].post.responses['200']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/archive'].post.responses['200']).toBeDefined();
  });
});
