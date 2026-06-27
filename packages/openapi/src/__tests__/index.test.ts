import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../index.js';

describe('openApiSpec', () => {
  it('publishes the documented API lifecycle version', () => {
    expect(openApiSpec.info.version).toBe('2026-01-01');
  });

  it('documents the root-level health route outside the versioned API server', () => {
    expect(openApiSpec.paths['/health'].get).toBeDefined();
    expect(openApiSpec.paths['/health'].get.summary).toBe('Health check');
  });

  it('documents paginated private list endpoints as envelopes', () => {
    expect(
      openApiSpec.paths['/events'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/EventPage' });
    expect(
      openApiSpec.paths['/organizations'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OrganizationPage' });
    expect(
      openApiSpec.paths['/brands'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/BrandPage' });
    expect(
      openApiSpec.paths['/orders'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OrderPage' });
    expect(
      openApiSpec.paths['/api-keys'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/ApiKeyPage' });
  });

  it('uses implemented developer route paths', () => {
    expect(openApiSpec.paths['/api-keys']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post.responses).toHaveProperty('200');
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post.responses).not.toHaveProperty('204');
    expect(openApiSpec.paths).not.toHaveProperty('/developer/api-keys');
  });

  it('documents one-time webhook signing secrets on endpoint creation', () => {
    expect(
      openApiSpec.paths['/webhook-endpoints'].post.responses['201'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/WebhookEndpointCreated' });
    expect(openApiSpec.components.schemas.WebhookEndpointCreated).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          required: ['secret'],
        }),
      ]),
    });
  });

  it('documents brand payment account binding on response schemas', () => {
    expect(openApiSpec.components.schemas.Brand.properties).toHaveProperty('paymentAccountId');
    expect(openApiSpec.paths['/brands/{brandId}'].patch.requestBody.content['application/json'].schema.properties).toHaveProperty(
      'paymentAccountId',
    );
  });

  it('documents Stripe Connect onboarding URL responses', () => {
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('onboardingUrl');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('detailsSubmitted');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('chargesEnabled');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('payoutsEnabled');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('requirements');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('disabledReason');
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts/stripe-connect'].post.responses,
    ).toHaveProperty('201');
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh'].post.responses,
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
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/CheckInListPage' });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OfflineManifest' });
    expect(openApiSpec.components.schemas.OfflineManifest.required).toContain('tickets');
    expect(openApiSpec.paths['/check-ins/sync'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
  });

  it('documents remaining implemented backend route groups', () => {
    expect(openApiSpec.paths['/events/{eventId}/attendees']).toBeDefined();
    expect(openApiSpec.paths['/attendees/{attendeeId}']).toBeDefined();
    expect(openApiSpec.paths['/tickets/{ticketId}/transfer']).toBeDefined();
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
    expect(openApiSpec.paths['/webhook-events/{eventId}/replay']).toBeDefined();
    expect(openApiSpec.components.schemas.TicketTypeBatchResult.required).toEqual(['ticketType', 'accessRules']);
    expect(openApiSpec.components.schemas.CreateTicketTypeBatch.required).toContain('ticketType');
  });

  it('documents checkout tracking separately from affiliate attribution', () => {
    const checkoutSessionBody =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema;
    expect(checkoutSessionBody.properties.affiliateCode).toEqual({ type: 'string' });
    expect(checkoutSessionBody.properties.trackingId).toEqual({ type: 'string' });
  });

  it('documents conversion widget impressions as persisted counts', () => {
    const schema =
      openApiSpec.paths['/events/{eventId}/reports/conversion'].get.responses['200'].content['application/json'].schema;
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
      openApiSpec.paths['/events/{eventId}/marketing-integrations'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/MarketingIntegrationPage' });
    expect(openApiSpec.paths['/events/{eventId}/marketing-integrations/{provider}'].put).toBeDefined();
    expect(
      openApiSpec.paths['/public/events/{eventId}/marketing-integrations'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/MarketingIntegrationPage' });
  });

  it('requires public upload completion tokens without requiring them for authenticated completion', () => {
    expect(openApiSpec.components.schemas.PublicCompleteUploadArtifact).toMatchObject({
      required: ['token'],
      properties: {
        token: { type: 'string', minLength: 1 },
      },
    });

    expect(
      openApiSpec.paths['/public/upload-artifacts/{artifactId}/complete'].post.requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicCompleteUploadArtifact' });
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post.requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/CompleteUploadArtifact' });
    expect(openApiSpec.components.schemas.CompleteUploadArtifact).not.toHaveProperty('required');
    expect(openApiSpec.components.schemas.CompleteUploadArtifact.properties).not.toHaveProperty('token');
    expect(openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post.requestBody.required).toBe(false);
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

  it('documents audit logging and GDPR privacy request routes', () => {
    expect(openApiSpec.paths['/audit-logs'].get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/AuditLogPage',
    });
    expect(openApiSpec.paths['/privacy/data-exports'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/privacy/erasures'].post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PrivacyRequestInput',
    });
  });

  it('documents implemented status codes and required idempotency headers', () => {
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.responses).toHaveProperty('202');
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.responses).not.toHaveProperty('201');
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/orders/{orderId}/cancel'].post).not.toHaveProperty('parameters');
    expect(openApiSpec.paths['/checkout/sessions'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
  });

  it('keeps event create/update schemas aligned with backend currency and status contracts', () => {
    const eventSchema = openApiSpec.components.schemas.Event;
    expect(eventSchema.required).toContain('currency');
    expect(eventSchema.properties).toHaveProperty('currency');

    const createSchema = openApiSpec.paths['/events'].post.requestBody.content['application/json'].schema;
    expect(createSchema.required).toContain('currency');
    expect(createSchema.properties).toHaveProperty('currency');

    const updateSchema = openApiSpec.paths['/events/{eventId}'].patch.requestBody.content['application/json'].schema;
    expect(updateSchema.properties).toHaveProperty('currency');
    expect(updateSchema.properties).toHaveProperty('status');
  });
});
