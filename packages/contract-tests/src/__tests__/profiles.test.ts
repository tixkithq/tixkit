import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EMBED_LIFECYCLE_NAMES } from '@tixkit/embed-core';
import {
  testEmbedHostContract,
  testSdkConsumerContract,
  testWebhookConsumerContract,
  runWebhookConsumerContract,
  runSdkApiConsumerContract,
} from '../index.js';

describe('third-party contract profiles', () => {
  it('accepts a pinned SRI embed with strict CSP, fallback, and complete lifecycle coverage', () => {
    const artifact = new TextEncoder().encode('widget artifact');
    const sri = `sha384-${createHash('sha384').update(artifact).digest('base64')}`;
    const source = {} as MessageEventSource;
    expect(
      testEmbedHostContract({
        html: `<script src="https://cdn.example/v1.2.3/widget.js" integrity="${sri}" crossorigin="anonymous"></script><a href="https://checkout.example/event" aria-label="Open secure checkout">Checkout</a>`,
        csp: "default-src 'none'; script-src https://cdn.example; connect-src https://checkout.example; frame-src https://checkout.example",
        expectedOrigin: 'https://checkout.example',
        lifecycleEvents: EMBED_LIFECYCLE_NAMES.map((name) => `tixkit:v1:${name}`),
        // eslint-disable-next-line oxc/no-map-spread -- Each discriminated lifecycle fixture requires its own immutable shape.
        lifecycleDetails: EMBED_LIFECYCLE_NAMES.map((name) => ({
          contractVersion: '1.0',
          name,
          widgetId: 'widget_1',
          eventId: 'evt_1',
          mode: 'inline',
          timestamp: '2026-07-10T12:00:00.000Z',
          ...(name === 'closed' ? { reason: 'buyer' } : {}),
          ...(name === 'checkout-session-created' ? { sessionId: 'cs_1' } : {}),
          ...(name === 'order-completed' ? { orderId: 'ord_1' } : {}),
          ...(name === 'recoverable-error' || name === 'fatal-error'
            ? {
                errorCode: 'internal-error',
                message: 'Safe error',
                retryable: name === 'recoverable-error',
              }
            : {}),
        })),
        artifact,
        sri,
        fallbackAccessibleName: 'Open secure checkout',
        messageEvents: [
          {
            event: {
              origin: 'https://checkout.example',
              source,
              data: {
                source: 'tixkit-checkout',
                type: 'checkout:ready',
                contractVersion: '1.0',
                widgetId: 'widget_1',
                eventId: 'evt_1',
                nonce: '0123456789abcdef0123456789abcdef',
              },
            } as MessageEvent,
            expectation: {
              origin: 'https://checkout.example',
              source,
              widgetId: 'widget_1',
              eventId: 'evt_1',
              nonce: '0123456789abcdef0123456789abcdef',
            },
            valid: true,
          },
          ...[
            { origin: 'https://attacker.example' },
            { source: {} as MessageEventSource },
            { data: { widgetId: 'widget_2' } },
            { data: { nonce: 'fedcba9876543210fedcba9876543210' } },
            { data: { contractVersion: '2.0' } },
          ].map((override) => ({
            event: {
              origin: 'https://checkout.example',
              source,
              data: {
                source: 'tixkit-checkout',
                type: 'checkout:ready',
                contractVersion: '1.0',
                widgetId: 'widget_1',
                eventId: 'evt_1',
                nonce: '0123456789abcdef0123456789abcdef',
                ...override.data,
              },
              ...override,
            } as MessageEvent,
            expectation: {
              origin: 'https://checkout.example',
              source,
              widgetId: 'widget_1',
              eventId: 'evt_1',
              nonce: '0123456789abcdef0123456789abcdef',
            },
            valid: false,
          })),
        ],
      }).ok,
    ).toBe(true);
  });

  it('detects strict-CSP, SRI, fallback, and lifecycle host failures', () => {
    const output = testEmbedHostContract({
      html: '<script src="https://cdn.example/latest/widget.js"></script>',
      csp: "script-src 'unsafe-inline'; connect-src https://checkout.example.evil; img-src https://checkout.example",
      expectedOrigin: 'https://checkout.example',
      lifecycleEvents: [],
      lifecycleDetails: [],
      artifact: new Uint8Array(),
      sri: 'sha384-invalid',
      fallbackAccessibleName: '',
      messageEvents: [],
    });
    expect(output.ok).toBe(false);
    expect(output.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'EMBED_VERSION_UNPINNED',
        'EMBED_SRI_MISSING',
        'EMBED_FALLBACK_MISSING',
        'EMBED_CSP_BROAD',
        'EMBED_ORIGIN_MISSING',
        'EMBED_LIFECYCLE_MISSING',
      ]),
    );
  });

  it('verifies case-insensitive signed headers and executes idempotent duplicate handling', async () => {
    const secret = 'whsec_contract_fixture';
    const newer = JSON.stringify({
      type: 'test.ping',
      test: true,
      apiVersion: '2026-01-01',
      createdAt: '2026-07-10T12:01:00.000Z',
      data: { endpointId: 'wh_1' },
    });
    const older = JSON.stringify({
      type: 'test.ping',
      test: true,
      apiVersion: '2026-01-01',
      createdAt: '2026-07-10T12:00:00.000Z',
      data: { endpointId: 'wh_1' },
    });
    const signature = (timestamp: number, body: string) =>
      `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    const inputDeliveries = [
      {
        headers: {
          'X-Tixkit-Signature': signature(200, newer),
          'X-Tixkit-Delivery': 'd_1',
          'X-Tixkit-Event-ID': 'whe_new',
        },
        body: newer,
        receivedAtMs: 200_000,
        ordering: { key: 'order:ord_1', version: 2 },
      },
      {
        headers: {
          'X-Tixkit-Signature': signature(100, older),
          'X-Tixkit-Delivery': 'd_3',
          'X-Tixkit-Event-ID': 'whe_other_order',
        },
        body: older,
        receivedAtMs: 100_000,
        ordering: { key: 'order:ord_2', version: 1 },
      },
      {
        headers: {
          'X-Tixkit-Signature': signature(100, older),
          'X-Tixkit-Delivery': 'd_2',
          'X-Tixkit-Event-ID': 'whe_old',
        },
        body: older,
        receivedAtMs: 100_000,
        ordering: { key: 'order:ord_1', version: 1 },
      },
      {
        headers: {
          'X-Tixkit-Signature': signature(200, newer),
          'X-Tixkit-Delivery': 'd_1',
          'X-Tixkit-Event-ID': 'whe_new',
        },
        body: newer,
        receivedAtMs: 200_000,
        ordering: { key: 'order:ord_1', version: 2 },
      },
    ];
    const output = testWebhookConsumerContract({
      secret,
      deliveries: inputDeliveries,
    });
    expect(output.ok).toBe(true);
    const processed = new Set<string>();
    const executed = await runWebhookConsumerContract({
      secret,
      deliveries: inputDeliveries,
      consume: async (delivery) => {
        const id = delivery.headers['X-Tixkit-Delivery']!;
        const duplicate = processed.has(id);
        processed.add(id);
        return {
          acknowledged: true,
          duplicate,
          applied: (id === 'd_1' || id === 'd_3') && !duplicate,
          sideEffectId: `effect:${id}`,
        };
      },
    });
    expect(executed.ok).toBe(true);
  });

  it('checks API version, operation parity, uniqueness, and error envelopes', () => {
    expect(
      testSdkConsumerContract({
        apiVersion: '2026-01-01',
        expectedApiVersion: '2026-01-01',
        operationIds: ['getEvents', 'postCheckout'],
        requiredOperationIds: ['getEvents'],
        errorSamples: [{ error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req_1' } }],
      }).ok,
    ).toBe(true);
    expect(
      testSdkConsumerContract({
        apiVersion: 'old',
        expectedApiVersion: '2026-01-01',
        operationIds: ['getEvents', 'getEvents'],
        requiredOperationIds: ['postCheckout'],
        errorSamples: [{}],
      }).findings.map((finding) => finding.code),
    ).toEqual([
      'SDK_API_VERSION',
      'SDK_OPERATION_DUPLICATE',
      'SDK_OPERATION_MISSING',
      'SDK_ERROR_SCHEMA',
    ]);
  });

  it('executes the SDK/API synthetic-delivery operation with auth and version headers', async () => {
    const executed = vi.fn(async (request) => ({
      status: 202,
      headers: { 'Content-Type': 'application/json' },
      body: { queued: true, test: true, eventId: 'whe_test', endpointId: 'wh_1' },
      request,
    }));
    const output = await runSdkApiConsumerContract({
      apiVersion: '2026-01-01',
      apiKey: 'tk_sandbox',
      endpointId: 'wh_1',
      execute: executed,
    });
    expect(output.ok).toBe(true);
    expect(executed).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/webhook-endpoints/wh_1/test',
      headers: {
        authorization: 'Bearer tk_sandbox',
        accept: 'application/json',
        'X-Tixkit-Version': '2026-01-01',
      },
    });
  });
});
