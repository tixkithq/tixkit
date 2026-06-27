import { createDb } from '@tixkit/db';
import { WebhookDeliveryRepository, WebhookEndpointRepository } from '@tixkit/db';
import { signWebhookPayload } from '@tixkit/domain/developer';
import { withSpan } from '@tixkit/shared';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

const WEBHOOK_API_VERSION = '2026-01-01';
const WEBHOOK_USER_AGENT = 'Tixkit-Webhook/1.0';

export async function deliverWebhookActivity(input: {
  apiVersion?: string;
  endpointId: string;
  eventId: string;
  eventType?: string;
  payload: string;
  secret: string;
  attempt: number;
  finalAttempt?: boolean;
}): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>> {
  const db = createDb();
  let deliveryId: string | undefined;
  try {
    const endpointRepo = new WebhookEndpointRepository(db);
    const endpoint = await endpointRepo.findById(input.endpointId);
    if (!endpoint) {
      return errResult('ENDPOINT_NOT_FOUND', 'Webhook endpoint not found', false);
    }
    if (endpoint.status !== 'active') {
      return errResult('ENDPOINT_INACTIVE', 'Webhook endpoint is not active', false);
    }

    const deliveryRepo = new WebhookDeliveryRepository(db);
    const delivery = await deliveryRepo.create({
      endpointId: input.endpointId,
      eventId: input.eventId,
      attempt: input.attempt,
    });
    deliveryId = delivery.id;
    const signature = signWebhookPayload({ payload: input.payload, secret: input.secret });
    const eventType = input.eventType ?? parseWebhookEventType(input.payload);
    const response = await withSpan(
      'provider.webhook.deliver',
      {
        'tixkit.provider': 'webhook',
        'tixkit.provider.operation': 'deliver',
        'tixkit.webhook.endpoint_id': input.endpointId,
        'tixkit.webhook.event_id': input.eventId,
        'tixkit.webhook.delivery_id': delivery.id,
        'tixkit.webhook.event_type': eventType,
      },
      async (span) => {
        const deliveredResponse = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': WEBHOOK_USER_AGENT,
            'X-Tixkit-API-Version': input.apiVersion ?? WEBHOOK_API_VERSION,
            'X-Tixkit-Delivery': delivery.id,
            'X-Tixkit-Event-ID': input.eventId,
            ...(eventType ? { 'X-Tixkit-Event-Type': eventType } : {}),
            'X-Tixkit-Signature': signature,
          },
          body: input.payload,
        });
        span.setAttribute('http.response.status_code', deliveredResponse.status);
        return deliveredResponse;
      },
    );
    const responseText = await response.text();
    const delivered = response.status >= 200 && response.status < 300;
    const terminalFailure = !delivered && input.finalAttempt === true;
    await deliveryRepo.update(delivery.id, {
      status_code: response.status,
      response: responseText,
      status: delivered ? 'delivered' : terminalFailure ? 'dead_lettered' : 'failed',
      delivered_at: delivered ? new Date() : null,
      next_retry_at:
        delivered || terminalFailure
          ? null
          : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
    });
    return okResult({ statusCode: response.status, response: responseText });
  } catch (err) {
    if (deliveryId) {
      try {
        const deliveryRepo = new WebhookDeliveryRepository(db);
        await deliveryRepo.update(deliveryId, {
          status_code: null,
          response: err instanceof Error ? err.message : 'Unknown error',
          status: input.finalAttempt === true ? 'dead_lettered' : 'failed',
          delivered_at: null,
          next_retry_at:
            input.finalAttempt === true
              ? null
              : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
        });
      } catch {
        // Preserve the original delivery failure so Temporal retries retain the
        // actionable endpoint/fetch error.
      }
    }
    return errResult('WEBHOOK_DELIVERY_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

function parseWebhookEventType(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}
