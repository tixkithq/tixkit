import { WebhookEventRepository, WebhookEndpointRepository } from '@tixkit/db';
import { validateWebhookEventData } from '@tixkit/domain/developer';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import { getActivityDb } from './activity-clients.js';

export async function emitWebhookEventActivity(input: {
  tenantId: string;
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<
  WorkflowActivityResult<{
    eventId: string;
    deliveries: { endpointId: string; eventId: string; url: string }[];
  }>
> {
  const db = getActivityDb();
  try {
    const validation = validateWebhookEventData(input.eventType, input.payload);
    if (!validation.success) {
      return errResult('WEBHOOK_EVENT_INVALID', validation.issues.join('; '), false);
    }
    const endpointRepo = new WebhookEndpointRepository(db);
    const eventRepo = new WebhookEventRepository(db);

    const endpoints = await endpointRepo.findActiveByEvent(input.organizationId, input.eventType);
    const event = await eventRepo.create({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      type: input.eventType,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
    });

    const deliveries = endpoints.map((endpoint) => ({
      endpointId: endpoint.id,
      eventId: event.id,
      url: endpoint.url as string,
    }));

    return okResult({ eventId: event.id, deliveries });
  } catch (err) {
    return errResult(
      'WEBHOOK_EVENT_CREATE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}
