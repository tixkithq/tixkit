import { describe, expect, it, vi } from 'vitest';
import { adminApi } from '@/lib/api';

describe('Webhook create/update', () => {
  it('listWebhookEndpoints returns fixture endpoints', async () => {
    const result = await adminApi.listWebhookEndpoints();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0].url).toBeDefined();
      expect(result.data[0].events).toBeInstanceOf(Array);
    }
  });

  it('createWebhookEndpoint returns a new endpoint with active status', async () => {
    const result = await adminApi.createWebhookEndpoint({
      idempotencyKey: 'webhook-create-000001',
      url: 'https://example.com/new-webhook',
      description: 'Test endpoint',
      events: ['order.created', 'order.paid'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.url).toBe('https://example.com/new-webhook');
      expect(result.data.status).toBe('active');
      expect(result.data.events).toEqual(['order.created', 'order.paid']);
      expect(result.data.id).toBeDefined();
    }
  });

  it('updateWebhookEndpoint updates fields', async () => {
    // Create a webhook first
    const createResult = await adminApi.createWebhookEndpoint({
      idempotencyKey: 'webhook-update-setup-000001',
      url: 'https://example.com/update-test',
      events: ['order.created'],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const webhookId = createResult.data.id;
    const updateResult = await adminApi.updateWebhookEndpoint(webhookId, {
      status: 'disabled',
      description: 'Updated description',
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.status).toBe('disabled');
      expect(updateResult.data.description).toBe('Updated description');
    }
  });

  it('updateWebhookEndpoint returns error for nonexistent endpoint', async () => {
    const result = await adminApi.updateWebhookEndpoint('nonexistent_wh', {
      status: 'disabled',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      expect(result.error.status).toBe(404);
    }
  });

  it('replayWebhookEvent returns queued true for a webhook event id', async () => {
    const events = await adminApi.listWebhookEvents('wh_001');
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.data.length).toBeGreaterThan(0);
    const eventId = events.data[0].id;
    const result = await adminApi.replayWebhookEvent('wh_001', eventId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.queued).toBe(true);
    }
  });

  it('replayWebhookEvent posts to the endpoint-scoped replay URL', async () => {
    vi.resetModules();
    const requestMock = vi.fn(async () => ({ ok: true as const, data: { queued: true as const } }));
    vi.doMock('@/lib/api-http', () => ({
      getAdminApiBaseUrl: vi.fn(() => 'https://api.test'),
      getAdminApiAuthHeaders: vi.fn(async () => ({})),
      request: requestMock,
      withFixture: async (call: () => Promise<unknown>) => call(),
    }));

    try {
      const { adminApi: isolatedAdminApi } = await import('@/lib/api');

      const result = await isolatedAdminApi.replayWebhookEvent('wh_001', 'whe_001');

      expect(result.ok).toBe(true);
      expect(requestMock).toHaveBeenCalledWith(
        '/v1/webhook-endpoints/wh_001/events/whe_001/replay',
        { method: 'POST' },
      );
    } finally {
      vi.doUnmock('@/lib/api-http');
      vi.resetModules();
    }
  });

  it('createWebhookEndpoint sends the caller-owned idempotency key only as a header', async () => {
    vi.resetModules();
    const requestMock = vi.fn(async () => ({
      ok: true as const,
      data: { id: 'wh_002', secret: 'whsec_once' },
    }));
    vi.doMock('@/lib/api-http', () => ({
      getAdminApiBaseUrl: vi.fn(() => 'https://api.test'),
      getAdminApiAuthHeaders: vi.fn(async () => ({})),
      request: requestMock,
      withFixture: async (call: () => Promise<unknown>) => call(),
    }));

    try {
      const { adminApi: isolatedAdminApi } = await import('@/lib/api');
      const result = await isolatedAdminApi.createWebhookEndpoint({
        organizationId: 'org_1',
        idempotencyKey: 'webhook-create-stable-000001',
        url: 'https://hooks.example.test/tixkit',
        events: ['order.created'],
      });

      expect(result.ok).toBe(true);
      expect(requestMock).toHaveBeenCalledWith('/v1/webhook-endpoints', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'webhook-create-stable-000001' },
        body: JSON.stringify({
          organizationId: 'org_1',
          url: 'https://hooks.example.test/tixkit',
          events: ['order.created'],
        }),
      });
    } finally {
      vi.doUnmock('@/lib/api-http');
      vi.resetModules();
    }
  });

  it('updateWebhookEndpoint sends only strict update fields', async () => {
    vi.resetModules();
    const requestMock = vi.fn(async () => ({
      ok: true as const,
      data: { id: 'wh_002', status: 'active' as const },
    }));
    vi.doMock('@/lib/api-http', () => ({
      getAdminApiBaseUrl: vi.fn(() => 'https://api.test'),
      getAdminApiAuthHeaders: vi.fn(async () => ({})),
      request: requestMock,
      withFixture: async (call: () => Promise<unknown>) => call(),
    }));

    try {
      const { adminApi: isolatedAdminApi } = await import('@/lib/api');
      const result = await isolatedAdminApi.updateWebhookEndpoint('wh_002', {
        url: 'https://hooks.example.test/updated',
        description: 'Updated endpoint',
        events: ['order.paid'],
      });

      expect(result.ok).toBe(true);
      expect(requestMock).toHaveBeenCalledWith('/v1/webhook-endpoints/wh_002', {
        method: 'PATCH',
        body: JSON.stringify({
          url: 'https://hooks.example.test/updated',
          description: 'Updated endpoint',
          events: ['order.paid'],
        }),
      });
    } finally {
      vi.doUnmock('@/lib/api-http');
      vi.resetModules();
    }
  });

  it('listWebhookEvents returns events scoped to the endpoint', async () => {
    const result = await adminApi.listWebhookEvents('wh_001');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.every((e) => e.endpointId === 'wh_001')).toBe(true);
      expect(result.data.every((e) => e.deliveryId.startsWith('whd_'))).toBe(true);
      expect(result.data.every((e) => e.eventId === e.id)).toBe(true);
      expect(result.data.map((e) => e.status)).toContain('delivered');
      expect(result.data.map((e) => e.status)).toContain('dead_lettered');
    }
  });

  it('listWebhookEvents returns an empty list for an endpoint with no events', async () => {
    const result = await adminApi.listWebhookEvents('wh_unknown');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });
});
