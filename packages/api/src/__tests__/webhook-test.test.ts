import { describe, expect, it } from 'vitest';
import {
  createWebhookTestPayload,
  isWebhookTestPayload,
  WEBHOOK_TEST_EVENT_TYPE,
} from '../services/webhook-test.js';

describe('synthetic webhook fixture', () => {
  it('contains only delivery metadata and an explicit test marker', () => {
    const payload = createWebhookTestPayload('wh_1', new Date('2026-07-10T12:00:00.000Z'));
    expect(payload).toEqual({
      type: WEBHOOK_TEST_EVENT_TYPE,
      test: true,
      apiVersion: '2026-08-19',
      createdAt: '2026-07-10T12:00:00.000Z',
      data: { endpointId: 'wh_1' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/buyer|email|payment|order|ticket/iu);
  });

  it('fails closed for fabricated or cross-endpoint fixtures', () => {
    const payload = createWebhookTestPayload('wh_1');
    expect(isWebhookTestPayload(payload, 'wh_1')).toBe(true);
    expect(isWebhookTestPayload(payload, 'wh_2')).toBe(false);
    expect(isWebhookTestPayload({ ...payload, test: false }, 'wh_1')).toBe(false);
    expect(isWebhookTestPayload({ ...payload, type: 'order.paid' }, 'wh_1')).toBe(false);
  });

  it('accepts the retained 2026-07-17 fixture while emitting the current version', () => {
    const current = createWebhookTestPayload('wh_1', new Date('2026-07-10T12:00:00.000Z'));
    const retained = { ...current, apiVersion: '2026-07-17' };

    expect(isWebhookTestPayload(retained, 'wh_1')).toBe(true);
    expect(current.apiVersion).toBe('2026-08-19');
    expect(isWebhookTestPayload({ ...retained, apiVersion: '2026-07-16' }, 'wh_1')).toBe(false);
  });
});
