import { createDb } from '@gatekit/db';
import { WebhookDeliveryRepository, WebhookEndpointRepository } from '@gatekit/db';
import { signWebhookPayload } from '@gatekit/domain/developer';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

export async function deliverWebhookActivity(input: {
  endpointId: string;
  eventId: string;
  payload: string;
  secret: string;
  attempt: number;
}): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>> {
  const db = createDb();
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
    const signature = signWebhookPayload({ payload: input.payload, secret: input.secret });
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GateKit-Signature': signature,
        'X-GateKit-Event-ID': input.eventId,
      },
      body: input.payload,
    });
    const responseText = await response.text();
    await deliveryRepo.update(delivery.id, {
      status_code: response.status,
      response: responseText,
      status: response.status >= 200 && response.status < 300 ? 'delivered' : 'failed',
      delivered_at: response.status >= 200 && response.status < 300 ? new Date() : null,
      next_retry_at:
        response.status >= 200 && response.status < 300
          ? null
          : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
    });
    return okResult({ statusCode: response.status, response: responseText });
  } catch (err) {
    return errResult('WEBHOOK_DELIVERY_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}
