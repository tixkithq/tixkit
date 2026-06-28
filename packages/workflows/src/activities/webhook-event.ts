import { createDb } from '@tixkit/db';
import { WebhookEventRepository, WebhookEndpointRepository } from '@tixkit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

export async function emitWebhookEventActivity(input: {
  tenantId: string;
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<
  WorkflowActivityResult<{
    eventId: string;
    deliveries: { endpointId: string; eventId: string; url: string }[];
  }>
> {
  const db = createDb();
  try {
    const endpointRepo = new WebhookEndpointRepository(db);
    const eventRepo = new WebhookEventRepository(db);

    const endpoints = await endpointRepo.findActiveByEvent(input.organizationId, input.eventType);
    const event = await eventRepo.create({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      type: input.eventType,
      payload: input.payload,
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
  } finally {
    await db.destroy();
  }
}
