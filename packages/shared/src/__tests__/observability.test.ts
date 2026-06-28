import { afterEach, describe, expect, it } from 'vitest';
import {
  createTixkitMetrics,
  createTelemetryResource,
  redactObject,
  redactString,
  sanitizeSpanAttributes,
  startOpenTelemetry,
} from '../observability.js';

const originalOtelSdkDisabled = process.env.OTEL_SDK_DISABLED;

afterEach(() => {
  if (originalOtelSdkDisabled === undefined) {
    delete process.env.OTEL_SDK_DISABLED;
  } else {
    process.env.OTEL_SDK_DISABLED = originalOtelSdkDisabled;
  }
});

describe('observability redaction', () => {
  it('redacts PII and provider secrets from objects and span attributes', () => {
    const redacted = redactObject({
      buyerEmail: 'buyer@example.com',
      authorization: 'Bearer sk_test_secret',
      nested: {
        note: 'Contact attendee at attendee@example.com',
        providerToken: 'whsec_abc123',
      },
      safeId: 'ord_123',
    });

    expect(redacted).toEqual({
      buyerEmail: '[REDACTED]',
      authorization: '[REDACTED]',
      nested: {
        note: 'Contact attendee at [REDACTED]',
        providerToken: '[REDACTED]',
      },
      safeId: 'ord_123',
    });

    expect(
      sanitizeSpanAttributes({
        'tixkit.tenant_id': 'tnt_1',
        'http.request.header.authorization': 'Bearer sk_test_secret',
        'tixkit.buyer_email': 'buyer@example.com',
        'url.full':
          'https://checkout.example.test/return?payment_intent_client_secret=testvalue&state=safe&code=oauth-code#token=fragment-token&client_secret=client-secret',
      }),
    ).toEqual({
      'tixkit.tenant_id': 'tnt_1',
      'http.request.header.authorization': '[REDACTED]',
      'tixkit.buyer_email': '[REDACTED]',
      'url.full':
        'https://checkout.example.test/return?payment_intent_client_secret=[REDACTED]&state=safe&code=[REDACTED]#token=[REDACTED]&client_secret=[REDACTED]',
    });
  });

  it('redacts sensitive values from exception strings', () => {
    expect(
      redactString(
        'failed for buyer@example.com with Bearer tk_live_secret and client_secret=pi_secret',
      ),
    ).toBe('failed for [REDACTED] with Bearer [REDACTED] and client_secret=[REDACTED]');
  });
});

describe('OpenTelemetry runtime', () => {
  it('creates telemetry resources with service metadata', () => {
    const resource = createTelemetryResource({
      serviceName: 'test-service',
      serviceVersion: '1.2.3',
      environment: 'test',
    });

    expect(resource.attributes).toMatchObject({
      'service.name': 'test-service',
      'service.version': '1.2.3',
      'deployment.environment': 'test',
    });
  });

  it('does not start the SDK when OTEL_SDK_DISABLED is true', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';

    const runtime = startOpenTelemetry({ serviceName: 'disabled-service' });

    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('starts and shuts down the SDK when enabled', async () => {
    delete process.env.OTEL_SDK_DISABLED;

    const runtime = startOpenTelemetry({ serviceName: 'enabled-service', disabled: false });

    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});

describe('Tixkit Prometheus metrics', () => {
  it('exposes the documented metric families', async () => {
    const metrics = createTixkitMetrics('test-service');

    metrics.metrics.httpRequestDuration.observe(
      { method: 'GET', route: '/health', status_code: '200' },
      0.01,
    );
    metrics.metrics.checkoutEvents.inc({ operation: 'api', outcome: 'ok' });
    metrics.metrics.paymentEvents.inc({ operation: 'provider', provider: 'stripe', outcome: 'ok' });
    metrics.metrics.refundEvents.inc({ operation: 'provider', provider: 'stripe', outcome: 'ok' });
    metrics.metrics.webhookEvents.inc({ operation: 'outbound', outcome: 'ok' });
    metrics.metrics.exportEvents.inc({ operation: 'api', outcome: 'ok' });
    metrics.metrics.scanEvents.inc({ operation: 'api', outcome: 'ok' });
    metrics.metrics.inventoryActiveHolds.set({ scope: 'global' }, 2);
    metrics.metrics.temporalActivityEvents.inc({
      activity: 'finalizeOrderActivity',
      outcome: 'ok',
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain('tixkit_http_request_duration_seconds_bucket');
    expect(output).toContain('tixkit_checkout_events_total');
    expect(output).toContain('tixkit_payment_events_total');
    expect(output).toContain('tixkit_refund_events_total');
    expect(output).toContain('tixkit_webhook_events_total');
    expect(output).toContain('tixkit_export_events_total');
    expect(output).toContain('tixkit_scan_events_total');
    expect(output).toContain('tixkit_inventory_active_holds');
    expect(output).toContain('tixkit_temporal_activity_events_total');
  });
});
