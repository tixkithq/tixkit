import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@tixkit/domain';
import {
  API_JSON_BODY_LIMIT_BYTES,
  registerErrorHandler,
  registerHealthRoute,
  registerJsonBodyParser,
} from '../app.js';
import {
  pageEnvelope,
  parsePagination,
  serializeBrandTheme,
  serializeMarketingIntegration,
  serializeOrder,
} from '../http/contracts.js';
import { MAX_OFFLINE_SYNC_SCANS, OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES } from '../http/schemas.js';

describe('API contract helpers', () => {
  it('parses cursor pagination with documented defaults and max limit', () => {
    expect(parsePagination(undefined)).toEqual({ cursor: undefined, limit: 50 });
    expect(parsePagination({ limit: '25', cursor: 'evt_01' })).toEqual({
      cursor: 'evt_01',
      limit: 25,
    });
    expect(parsePagination({ limit: '001' })).toEqual({ cursor: undefined, limit: 1 });
    expect(parsePagination({ limit: '500' })).toEqual({ cursor: undefined, limit: 100 });
  });

  it('rejects invalid pagination limits with the shared validation error', () => {
    expect(() => parsePagination({ limit: '0' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: 'not-a-number' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: '1abc' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: '1.9' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: 1.9 })).toThrow(ValidationError);
  });

  it('returns the documented page envelope and cursor from the last emitted item', () => {
    expect(pageEnvelope([{ id: 'row_1' }, { id: 'row_2' }, { id: 'row_3' }], 2)).toEqual({
      items: [{ id: 'row_1' }, { id: 'row_2' }],
      nextCursor: 'row_2',
      hasMore: true,
    });

    expect(pageEnvelope([{ id: 'row_1' }], 2)).toEqual({
      items: [{ id: 'row_1' }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('derives durable brand logo URLs from logo artifact IDs', () => {
    expect(
      serializeBrandTheme({
        primaryColor: '#222222',
        logoArtifactId: 'upl_logo',
        logoUrl: 'https://s3.test/logo.png?X-Amz-Signature=expired',
      }),
    ).toEqual({
      primaryColor: '#222222',
      logoArtifactId: 'upl_logo',
      logoUrl: '/v1/public/brand-logos/upl_logo',
    });
  });

  it('redacts non-public marketing integration config fields for anonymous contracts', () => {
    expect(
      serializeMarketingIntegration(
        {
          provider: 'ga4',
          config: JSON.stringify({
            measurementId: 'G-PUBLIC',
            apiKey: 'secret-key',
            accessToken: 'secret-token',
          }),
          consent_required: true,
          status: 'active',
        },
        { public: true },
      ),
    ).toEqual({
      provider: 'ga4',
      config: { measurementId: 'G-PUBLIC' },
      consentRequired: true,
      status: 'active',
    });

    expect(
      serializeMarketingIntegration(
        {
          provider: 'meta_pixel',
          config: JSON.stringify({ pixelId: '123456', secret: 'do-not-return' }),
          consent_required: false,
          status: 'active',
        },
        { public: true },
      ),
    ).toMatchObject({
      provider: 'meta_pixel',
      config: { pixelId: '123456' },
    });
  });

  it('serializes order sales attribution with online defaults for legacy rows', () => {
    const serialized = serializeOrder({
      id: 'ord_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      checkout_session_id: 'chk_1',
      order_number: 'TK-1001',
      status: 'paid',
      currency: 'USD',
      subtotal_cents: 2500,
      discount_cents: 0,
      tax_cents: 200,
      fee_cents: 125,
      total_cents: 2825,
      refunded_cents: 0,
      buyer_email: 'buyer@example.com',
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
      payment_intent_id: null,
      payment_provider: 'stripe',
      paid_at: '2026-06-01T12:00:00.000Z',
      refunded_at: null,
      cancelled_at: null,
      created_at: '2026-06-01T12:00:00.000Z',
      updated_at: '2026-06-01T12:00:00.000Z',
    });

    expect(serialized).toMatchObject({
      id: 'ord_1',
      salesChannel: 'online',
      operatorId: undefined,
      tenderType: undefined,
    });
  });

  it('serializes box-office operator and tender attribution', () => {
    const serialized = serializeOrder({
      id: 'ord_pos',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      checkout_session_id: 'chk_pos',
      order_number: 'TK-POS-1',
      status: 'paid',
      currency: 'USD',
      subtotal_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
      fee_cents: 0,
      total_cents: 0,
      refunded_cents: 0,
      buyer_email: 'guest@example.com',
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
      payment_intent_id: null,
      payment_provider: 'manual',
      sales_channel: 'box_office',
      operator_id: 'usr_operator',
      tender_type: 'cash',
      paid_at: '2026-06-01T12:00:00.000Z',
      refunded_at: null,
      cancelled_at: null,
      created_at: '2026-06-01T12:00:00.000Z',
      updated_at: '2026-06-01T12:00:00.000Z',
    });

    expect(serialized).toMatchObject({
      id: 'ord_pos',
      paymentProvider: 'manual',
      salesChannel: 'box_office',
      operatorId: 'usr_operator',
      tenderType: 'cash',
    });
  });
});

describe('API error envelope', () => {
  it('accepts the documented offline sync payload size with the route-specific body limit', async () => {
    const app = Fastify({ logger: false, bodyLimit: OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES });
    registerJsonBodyParser(app);
    app.post('/offline-sync-payload', async (request) => ({
      scans: (request.body as { scans: unknown[] }).scans.length,
      rawBodyLength: (request as unknown as { rawBody: string }).rawBody.length,
    }));
    const payload = {
      checkInListId: 'cil_1',
      deviceId: 'sd_public',
      scans: Array.from({ length: MAX_OFFLINE_SYNC_SCANS }, (_, index) => ({
        qrHash: index.toString(16).padStart(64, '0'),
        scannedAt: '2026-06-01T12:00:00.000Z',
        offline: true,
      })),
    };
    const rawPayload = JSON.stringify(payload);

    expect(Buffer.byteLength(rawPayload)).toBeGreaterThan(API_JSON_BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(rawPayload)).toBeLessThanOrEqual(OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES);

    const response = await app.inject({
      method: 'POST',
      url: '/offline-sync-payload',
      headers: { 'content-type': 'application/json' },
      payload: rawPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scans: MAX_OFFLINE_SYNC_SCANS,
      rawBodyLength: rawPayload.length,
    });
    await app.close();
  });

  it('accepts empty JSON POST bodies without throwing parser errors', async () => {
    const app = Fastify({ logger: false });
    registerJsonBodyParser(app);
    app.post('/empty', async (request) => ({
      body: request.body ?? null,
      rawBody: (request as unknown as { rawBody: string }).rawBody,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/empty',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: null, rawBody: '' });
    await app.close();
  });

  it('serializes domain errors with code, message, details, and requestId', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_contract' });
    registerErrorHandler(app);
    app.get('/validation', async () => {
      throw new ValidationError('limit must be a positive integer', {
        fields: { limit: 'must be a positive integer' },
        buyerEmail: 'buyer@example.com',
        metadata: {
          token: 'tk_live_secret',
          notes: ['contact buyer@example.com before retry'],
        },
      });
    });

    const response = await app.inject({ method: 'GET', url: '/validation' });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'limit must be a positive integer',
        details: {
          fields: { limit: 'must be a positive integer' },
          buyerEmail: '[REDACTED]',
          metadata: {
            token: '[REDACTED]',
            notes: ['contact [REDACTED] before retry'],
          },
        },
        requestId: 'req_contract',
      },
    });
    expect(JSON.stringify(body)).not.toContain('buyer@example.com');
    expect(JSON.stringify(body)).not.toContain('tk_live_secret');
    await app.close();
  });

  it('redacts exposed exception messages in the error envelope', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_contract' });
    registerErrorHandler(app);
    app.get('/validation', async () => {
      throw new ValidationError('buyer buyer@example.com used token=tk_live_secret');
    });

    const response = await app.inject({ method: 'GET', url: '/validation' });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body.error.message).toBe('buyer [REDACTED] used token=[REDACTED]');
    expect(JSON.stringify(body)).not.toContain('buyer@example.com');
    expect(JSON.stringify(body)).not.toContain('tk_live_secret');
    await app.close();
  });

  it('serializes unhandled errors without leaking details', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_contract' });
    registerErrorHandler(app);
    app.get('/internal', async () => {
      throw new Error('database password leaked in stack');
    });

    const response = await app.inject({ method: 'GET', url: '/internal' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        requestId: 'req_contract',
      },
    });
    await app.close();
  });

  it('logs sanitized unhandled error details', async () => {
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        stream: {
          write: (message) => logs.push(message),
        },
      },
      genReqId: () => 'req_contract',
    });
    registerErrorHandler(app);
    app.get('/internal', async () => {
      throw new Error('provider failed for buyer@example.com with Bearer tk_live_secret');
    });

    const response = await app.inject({ method: 'GET', url: '/internal' });
    const serializedLogs = logs.join('');

    expect(response.statusCode).toBe(500);
    expect(serializedLogs).not.toContain('buyer@example.com');
    expect(serializedLogs).not.toContain('tk_live_secret');
    expect(serializedLogs).toContain('[REDACTED]');
    await app.close();
  });

  it('exempts health checks from global rate limiting', async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 1, timeWindow: '1 minute' });
    registerHealthRoute(app);
    app.get('/normal', async () => ({ ok: true }));

    const firstHealth = await app.inject({ method: 'GET', url: '/health' });
    const secondHealth = await app.inject({ method: 'GET', url: '/health' });
    const firstNormal = await app.inject({ method: 'GET', url: '/normal' });
    const secondNormal = await app.inject({ method: 'GET', url: '/normal' });

    expect(firstHealth.statusCode).toBe(200);
    expect(secondHealth.statusCode).toBe(200);
    expect(firstNormal.statusCode).toBe(200);
    expect(secondNormal.statusCode).toBe(429);
    await app.close();
  });
});
