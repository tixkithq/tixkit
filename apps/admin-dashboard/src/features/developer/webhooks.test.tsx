import { describe, expect, it } from 'vitest';
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
      url: 'https://example.com/update-test',
      events: ['order.created'],
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const webhookId = createResult.data.id;
    const updateResult = await adminApi.updateWebhookEndpoint(webhookId, {
      status: 'paused',
      description: 'Updated description',
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.data.status).toBe('paused');
      expect(updateResult.data.description).toBe('Updated description');
    }
  });

  it('updateWebhookEndpoint returns error for nonexistent endpoint', async () => {
    const result = await adminApi.updateWebhookEndpoint('nonexistent_wh', {
      status: 'paused',
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
    const result = await adminApi.replayWebhookEvent(eventId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.queued).toBe(true);
    }
  });

  it('listWebhookEvents returns events scoped to the endpoint', async () => {
    const result = await adminApi.listWebhookEvents('wh_001');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.every((e) => e.endpointId === 'wh_001')).toBe(true);
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
