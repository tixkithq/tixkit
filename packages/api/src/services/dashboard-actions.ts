import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  DashboardAction,
  DashboardActionFeed,
  DashboardActionSeverity,
  Permission,
} from '@tixkit/domain';
import { ValidationError } from '@tixkit/domain';
import type { Database } from '@tixkit/db';

export const DASHBOARD_ACTION_DEFAULT_LIMIT = 20;
export const DASHBOARD_ACTION_MAX_LIMIT = 50;
export const DASHBOARD_ACTION_TTL_MS = 5 * 60_000;
export const DASHBOARD_ACTION_QUERY_BUDGET = 3;

type StreamCursor = {
  event?: { startsAt: string; id: string };
  export?: { id: string };
};

type FeedCursor = StreamCursor & {
  version: 1;
  asOf: string;
  expiresAt: string;
  scopeDigest: string;
  scopeRevision: string;
};

type EventCandidate = {
  id: string;
  organization_id: string;
  brand_id: string;
  title: string;
  status: string;
  starts_at: Date | string;
  updated_at: Date | string;
  version: number;
  check_in_count: number;
};

type ExportCandidate = {
  id: string;
  organization_id: string;
  brand_id: string;
  title: string;
  updated_at: Date | string;
  version: number;
  failure_count: number;
  oldest_created_at: Date | string;
};

type RankedCandidate = {
  action: DashboardAction;
  stream: 'event' | 'export';
  eventKey?: { startsAt: string; id: string };
  exportKey?: { id: string };
};

const severityOrder: Readonly<Record<DashboardActionSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

type DashboardRemediationPermission = Exclude<
  DashboardAction['remediation']['requiredPermission'],
  null
>;

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Dashboard action source date is invalid');
  return date.toISOString();
}

function evidenceRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertCursorSigningKey(signingKey: string): void {
  if (Buffer.byteLength(signingKey, 'utf8') < 32) {
    throw new Error('Dashboard action cursor signing key must contain at least 32 bytes');
  }
}

function encodeCursor(cursor: FeedCursor, signingKey: string): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const signature = createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeDashboardActionCursor(value: string, signingKey: string): FeedCursor {
  try {
    assertCursorSigningKey(signingKey);
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid cursor envelope');
    const [payload, signature] = parts;
    const expected = Buffer.from(
      createHmac('sha256', signingKey).update(payload).digest('base64url'),
      'base64url',
    );
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('invalid cursor signature');
    }
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FeedCursor;
    if (
      parsed.version !== 1 ||
      typeof parsed.asOf !== 'string' ||
      !Number.isFinite(Date.parse(parsed.asOf)) ||
      typeof parsed.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.expiresAt)) ||
      Date.parse(parsed.expiresAt) !== Date.parse(parsed.asOf) + DASHBOARD_ACTION_TTL_MS ||
      typeof parsed.scopeDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.scopeDigest) ||
      typeof parsed.scopeRevision !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.scopeRevision) ||
      (parsed.event !== undefined &&
        (typeof parsed.event.id !== 'string' ||
          typeof parsed.event.startsAt !== 'string' ||
          !Number.isFinite(Date.parse(parsed.event.startsAt)))) ||
      (parsed.export !== undefined && typeof parsed.export.id !== 'string')
    ) {
      throw new Error('invalid cursor shape');
    }
    return parsed;
  } catch {
    throw new ValidationError('Dashboard action cursor is invalid');
  }
}

function severityForDeadline(deadline: Date, asOf: Date): DashboardActionSeverity {
  const remaining = deadline.getTime() - asOf.getTime();
  if (remaining <= 0) return 'critical';
  if (remaining <= 24 * 60 * 60 * 1000) return 'high';
  if (remaining <= 7 * 24 * 60 * 60 * 1000) return 'medium';
  return 'low';
}

function availability(
  permissions: ReadonlySet<Permission>,
  required: DashboardRemediationPermission,
) {
  const available = permissions.has(required);
  return {
    requiredPermission: required,
    canRemediate: available,
    availability: available ? ('available' as const) : ('permission_required' as const),
  };
}

function eventAction(input: {
  event: EventCandidate;
  asOf: Date;
  expiresAt: string;
  permissions: ReadonlySet<Permission>;
}): DashboardAction {
  const startsAt = new Date(input.event.starts_at);
  const sourceUpdatedAt = iso(input.event.updated_at);
  const shared = {
    resource: {
      type: 'event' as const,
      organizationId: input.event.organization_id,
      brandId: input.event.brand_id,
      eventId: input.event.id,
      eventVersion: Number(input.event.version),
      eventTitle: input.event.title,
    },
    deadlineAt: startsAt.toISOString(),
    deadlinePolicy: 'event_start' as const,
    overdue: startsAt <= input.asOf,
    occurrenceCount: 1,
    staleness: {
      state: 'current' as const,
      consistency: 'repeatable_read' as const,
      evaluatedAt: input.asOf.toISOString(),
      expiresAt: input.expiresAt,
      sourceUpdatedAt,
      sourceVersion: Number(input.event.version),
      evidenceRevision: evidenceRevision({
        id: input.event.id,
        status: input.event.status,
        startsAt: input.event.starts_at,
        updatedAt: input.event.updated_at,
        version: input.event.version,
        checkInCount: Number(input.event.check_in_count),
      }),
    },
  };
  if (input.event.status === 'draft') {
    return {
      ...shared,
      id: `event:${input.event.id}:unpublished`,
      sourceType: 'event_launch',
      severity: severityForDeadline(startsAt, input.asOf),
      owner: 'organizer',
      reasonCode: 'event_unpublished',
      remediation: {
        id: 'continue_event_setup',
        readinessActionId: 'view_event',
        ...availability(input.permissions, 'events.write'),
      },
    };
  }
  if (input.event.status === 'paused') {
    return {
      ...shared,
      id: `event:${input.event.id}:paused`,
      sourceType: 'event_operations',
      severity: severityForDeadline(startsAt, input.asOf),
      owner: 'organizer',
      reasonCode: 'event_sales_paused',
      remediation: {
        id: 'review_paused_event',
        readinessActionId: 'view_event',
        ...availability(input.permissions, 'events.write'),
      },
    };
  }
  return {
    ...shared,
    id: `event:${input.event.id}:check-in`,
    sourceType: 'event_operations',
    severity: severityForDeadline(startsAt, input.asOf),
    owner: 'door_operations',
    reasonCode: 'event_starting_soon',
    remediation: {
      id: 'prepare_door_operations',
      readinessActionId: 'configure_check_in',
      ...availability(input.permissions, 'checkins.write'),
    },
  };
}

function exportAction(input: {
  row: ExportCandidate;
  asOf: Date;
  expiresAt: string;
  permissions: ReadonlySet<Permission>;
}): DashboardAction {
  const sourceUpdatedAt = iso(input.row.oldest_created_at);
  return {
    id: `event:${input.row.id}:failed-exports`,
    sourceType: 'delivery_operations',
    resource: {
      type: 'event',
      organizationId: input.row.organization_id,
      brandId: input.row.brand_id,
      eventId: input.row.id,
      eventVersion: Number(input.row.version),
      eventTitle: input.row.title,
    },
    severity: 'high',
    owner: 'support',
    deadlineAt: null,
    deadlinePolicy: 'none',
    overdue: false,
    occurrenceCount: Number(input.row.failure_count),
    reasonCode: 'failed_exports',
    remediation: {
      id: 'review_failed_exports',
      readinessActionId: null,
      ...availability(input.permissions, 'reports.read'),
    },
    staleness: {
      state: 'current',
      consistency: 'repeatable_read',
      evaluatedAt: input.asOf.toISOString(),
      expiresAt: input.expiresAt,
      sourceUpdatedAt,
      sourceVersion: Number(input.row.version),
      evidenceRevision: evidenceRevision({
        eventId: input.row.id,
        eventVersion: input.row.version,
        failureCount: Number(input.row.failure_count),
        oldestCreatedAt: input.row.oldest_created_at,
      }),
    },
  };
}

export function compareDashboardActions(left: DashboardAction, right: DashboardAction): number {
  const severity = severityOrder[left.severity] - severityOrder[right.severity];
  if (severity !== 0) return severity;
  if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
  const leftDeadline =
    left.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.deadlineAt);
  const rightDeadline =
    right.deadlineAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.deadlineAt);
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
  return left.id.localeCompare(right.id);
}

export class DashboardActionService {
  constructor(
    private readonly db: Database,
    private readonly cursorSigningKey: string,
  ) {
    assertCursorSigningKey(cursorSigningKey);
  }

  async getFeed(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    permissions: ReadonlySet<Permission>;
    eventIds?: ReadonlyArray<string>;
    limit?: number;
    cursor?: string;
    now?: Date;
  }): Promise<DashboardActionFeed> {
    const limit = Math.max(
      1,
      Math.min(DASHBOARD_ACTION_MAX_LIMIT, input.limit ?? DASHBOARD_ACTION_DEFAULT_LIMIT),
    );
    const decoded = input.cursor
      ? decodeDashboardActionCursor(input.cursor, this.cursorSigningKey)
      : undefined;
    const asOf = decoded ? new Date(decoded.asOf) : (input.now ?? new Date());
    const expiresAt =
      decoded?.expiresAt ?? new Date(asOf.getTime() + DASHBOARD_ACTION_TTL_MS).toISOString();
    const requestTime = input.now ?? new Date();
    if (decoded && requestTime.getTime() > Date.parse(expiresAt)) {
      throw new ValidationError('Dashboard action cursor has expired');
    }
    const eventIds = input.eventIds
      ? [...new Set(input.eventIds)].sort((left, right) => left.localeCompare(right))
      : null;
    const scopeDigest = evidenceRevision({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      brandId: input.brandId,
      eventIds,
    });
    if (decoded && decoded.scopeDigest !== scopeDigest) {
      throw new ValidationError('Dashboard action cursor does not match the requested scope');
    }

    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        let eventQuery = trx
          .selectFrom('events')
          .leftJoin('check_in_lists', 'check_in_lists.event_id', 'events.id')
          .select(({ fn }) => [
            'events.id',
            'events.organization_id',
            'events.brand_id',
            'events.title',
            'events.status',
            'events.starts_at',
            'events.updated_at',
            'events.version',
            fn.count('check_in_lists.id').as('check_in_count'),
          ])
          .where('events.tenant_id', '=', input.tenantId)
          .where('events.organization_id', '=', input.organizationId)
          .where('events.brand_id', '=', input.brandId)
          .where((eb) =>
            eb.or([
              eb('events.status', 'in', ['draft', 'paused']),
              eb.and([eb('events.status', '=', 'published'), eb('events.starts_at', '>', asOf)]),
            ]),
          )
          .groupBy([
            'events.id',
            'events.organization_id',
            'events.brand_id',
            'events.title',
            'events.status',
            'events.starts_at',
            'events.updated_at',
            'events.version',
          ])
          .having((eb) =>
            eb.or([
              eb('events.status', 'in', ['draft', 'paused']),
              eb(eb.fn.count('check_in_lists.id'), '=', 0),
            ]),
          )
          .orderBy('events.starts_at', 'asc')
          .orderBy('events.id', 'asc')
          .limit(limit + 1);
        if (input.eventIds && input.eventIds.length > 0) {
          eventQuery = eventQuery.where('events.id', 'in', [...input.eventIds]);
        }
        if (decoded?.event) {
          const eventCursor = decoded.event;
          eventQuery = eventQuery.where((eb) =>
            eb.or([
              eb('events.starts_at', '>', new Date(eventCursor.startsAt)),
              eb.and([
                eb('events.starts_at', '=', new Date(eventCursor.startsAt)),
                eb('events.id', '>', eventCursor.id),
              ]),
            ]),
          );
        }

        let exportQuery = trx
          .selectFrom('export_jobs')
          .innerJoin('events', 'events.id', 'export_jobs.event_id')
          .select(({ fn }) => [
            'events.id',
            'events.organization_id',
            'events.brand_id',
            'events.title',
            'events.updated_at',
            'events.version',
            fn.countAll<number>().as('failure_count'),
            fn.min('export_jobs.created_at').as('oldest_created_at'),
          ])
          .where('export_jobs.tenant_id', '=', input.tenantId)
          .where('events.tenant_id', '=', input.tenantId)
          .where('events.organization_id', '=', input.organizationId)
          .where('events.brand_id', '=', input.brandId)
          .where('export_jobs.status', '=', 'failed')
          .groupBy([
            'events.id',
            'events.organization_id',
            'events.brand_id',
            'events.title',
            'events.updated_at',
            'events.version',
          ])
          .orderBy('events.id', 'asc')
          .limit(limit + 1);
        if (input.eventIds && input.eventIds.length > 0) {
          exportQuery = exportQuery.where('events.id', 'in', [...input.eventIds]);
        }
        if (decoded?.export) {
          exportQuery = exportQuery.where('events.id', '>', decoded.export.id);
        }

        const revisionQuery = trx
          .selectFrom('dashboard_action_revisions')
          .select('revision')
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('brand_id', '=', input.brandId);

        const [eventRows, exportRows, revisionRow] = await Promise.all([
          eventQuery.execute(),
          exportQuery.execute(),
          revisionQuery.executeTakeFirst(),
        ]);
        const scopeRevision = evidenceRevision({
          revision: String(revisionRow?.revision ?? 0),
        });
        if (decoded && decoded.scopeRevision !== scopeRevision) {
          throw new ValidationError(
            'Dashboard action snapshot changed; refresh before loading another page',
          );
        }
        const candidates: RankedCandidate[] = [
          ...eventRows.map((row) => {
            const event = row as EventCandidate;
            return {
              action: eventAction({
                event,
                asOf,
                expiresAt,
                permissions: input.permissions,
              }),
              stream: 'event' as const,
              eventKey: { startsAt: iso(event.starts_at), id: event.id },
            };
          }),
          ...exportRows.map((row) => {
            const exported = row as ExportCandidate;
            return {
              action: exportAction({
                row: exported,
                asOf,
                expiresAt,
                permissions: input.permissions,
              }),
              stream: 'export' as const,
              exportKey: { id: exported.id },
            };
          }),
        ].sort((left, right) => compareDashboardActions(left.action, right.action));

        const selected = candidates.slice(0, limit);
        const nextState: FeedCursor = {
          version: 1,
          asOf: asOf.toISOString(),
          expiresAt,
          scopeDigest,
          scopeRevision,
          ...(decoded?.event ? { event: decoded.event } : {}),
          ...(decoded?.export ? { export: decoded.export } : {}),
        };
        for (const candidate of selected) {
          if (candidate.stream === 'event' && candidate.eventKey)
            nextState.event = candidate.eventKey;
          if (candidate.stream === 'export' && candidate.exportKey)
            nextState.export = candidate.exportKey;
        }
        return {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          brandId: input.brandId,
          evaluationVersion: 1,
          generatedAt: asOf.toISOString(),
          expiresAt,
          nextCursor:
            candidates.length > selected.length
              ? encodeCursor(nextState, this.cursorSigningKey)
              : null,
          actions: selected.map((candidate) => candidate.action),
        };
      });
  }
}
