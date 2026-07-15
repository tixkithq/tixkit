import type { EventLaunchReadiness, Permission } from '@tixkit/domain';
import { EventRepository, type Database } from '@tixkit/db';
import type { Transaction } from 'kysely';
import type { ReadinessService } from './readiness.js';

type Executor = Database | Transaction<import('@tixkit/db').DB>;

export type EventPublicationInput = {
  tenantId: string;
  eventId: string;
  permissions: ReadonlySet<Permission>;
  expectedResourceVersion?: number;
  authorizeEvent?: (
    event: Awaited<ReturnType<EventRepository['findById']>> & {},
  ) => Promise<void> | void;
  beforePublish?: (input: {
    readiness: EventLaunchReadiness;
    event: Awaited<ReturnType<EventRepository['findById']>> & {};
  }) => Promise<void> | void;
  onPublished?: (input: {
    readiness: EventLaunchReadiness;
    event: Awaited<ReturnType<EventRepository['findById']>> & {};
    published: NonNullable<Awaited<ReturnType<EventRepository['publishIfVersion']>>>;
  }) => Promise<void> | void;
};

/**
 * The single product mutation boundary for event publication. Callers retain
 * transport-specific authorization and response mapping, while readiness,
 * optimistic concurrency, and the publication side effect stay identical.
 */
export async function publishEvent(
  db: Executor,
  readinessService: ReadinessService,
  input: EventPublicationInput,
) {
  const event = await db
    .selectFrom('events')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('id', '=', input.eventId)
    .forUpdate()
    .executeTakeFirst();
  if (!event) return { kind: 'not_found' as const };
  await input.authorizeEvent?.(event);
  if (event.status === 'published') return { kind: 'already_published' as const, event };
  if (event.status === 'archived') return { kind: 'archived' as const, event };

  const readiness = await readinessService.getEventLaunchReadiness({
    tenantId: event.tenant_id,
    organizationId: event.organization_id,
    brandId: event.brand_id,
    eventId: event.id,
    permissions: new Set(input.permissions),
  });
  if (!readiness.launchable) return { kind: 'blocked' as const, event, readiness };

  const expectedResourceVersion = input.expectedResourceVersion ?? readiness.eventVersion;
  if (readiness.eventVersion !== expectedResourceVersion)
    return { kind: 'stale' as const, event, readiness };

  await input.beforePublish?.({ event, readiness });
  const published = await new EventRepository(db as Database).publishIfVersion(
    event.id,
    expectedResourceVersion,
  );
  if (!published) return { kind: 'stale' as const, event, readiness };

  await input.onPublished?.({ event, readiness, published });
  return { kind: 'published' as const, event, readiness, published };
}
