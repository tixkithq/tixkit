import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../index.js';

describe('openApiSpec', () => {
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
    expect(openApiSpec.paths['/events/{eventId}/questions/reorder']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/reports/sales']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/reports/tax']).toBeDefined();
    expect(openApiSpec.paths['/exports']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/messages']).toBeDefined();
    expect(openApiSpec.paths['/webhook-events/{eventId}/replay']).toBeDefined();
  });

  it('documents checkout tracking separately from affiliate attribution', () => {
    const checkoutSessionBody =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema;
    expect(checkoutSessionBody.properties.affiliateCode).toEqual({ type: 'string' });
    expect(checkoutSessionBody.properties.trackingId).toEqual({ type: 'string' });
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

  it('does not document unimplemented route groups', () => {
    expect(openApiSpec.paths).not.toHaveProperty('/audit-logs');
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
