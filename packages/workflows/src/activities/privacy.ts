import { createHash } from 'node:crypto';
import { createDb, PrivacyRequestRepository, type Database } from '@tixkit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { errResult, okResult } from '../shared/types.js';

type PrivacyRequestRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string | null;
  request_type: string;
  subject_type: string;
  subject_id: string | null;
  subject_email: string | null;
  status: string;
};

function erasedEmail(input: string | null | undefined, fallback: string): string {
  const source = input && input.length > 0 ? input.toLowerCase() : fallback;
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `erased+${digest}@privacy.tixkit.invalid`;
}

function normalizeJson(value: unknown): unknown {
  if (value == null || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function redactJsonValue(value: unknown, replacementEmail: string): unknown {
  const parsed = normalizeJson(value);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => redactJsonValue(entry, replacementEmail));
  }
  if (!parsed || typeof parsed !== 'object') return parsed;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('email')) {
      redacted[key] = replacementEmail;
    } else if (
      normalizedKey.includes('phone') ||
      normalizedKey.includes('name') ||
      normalizedKey.includes('taxid') ||
      normalizedKey.includes('tax_id')
    ) {
      redacted[key] = null;
    } else {
      redacted[key] = redactJsonValue(entry, replacementEmail);
    }
  }
  return redacted;
}

function countUpdatedRows(results: Array<{ numUpdatedRows?: bigint | number }>): number {
  return results.reduce((count, result) => count + Number(result.numUpdatedRows ?? 0), 0);
}

function baseOrderQuery(db: Database, request: PrivacyRequestRow) {
  let query = db
    .selectFrom('orders')
    .selectAll()
    .where('tenant_id', '=', request.tenant_id)
    .where('organization_id', '=', request.organization_id);

  if (request.brand_id) query = query.where('brand_id', '=', request.brand_id);
  if (request.subject_email) query = query.where('buyer_email', '=', request.subject_email);
  if (request.subject_id && request.subject_type === 'buyer') query = query.where('id', '=', request.subject_id);

  return query;
}

function baseAttendeeQuery(db: Database, request: PrivacyRequestRow) {
  let query = db
    .selectFrom('attendees')
    .innerJoin('orders', 'attendees.order_id', 'orders.id')
    .select([
      'attendees.id as id',
      'attendees.order_id as order_id',
      'attendees.event_id as event_id',
      'attendees.event_occurrence_id as event_occurrence_id',
      'attendees.ticket_type_id as ticket_type_id',
      'attendees.ticket_id as ticket_id',
      'attendees.first_name as first_name',
      'attendees.last_name as last_name',
      'attendees.email as email',
      'attendees.phone as phone',
      'attendees.status as status',
      'attendees.custom_answers as custom_answers',
      'attendees.checked_in_at as checked_in_at',
      'attendees.created_at as created_at',
      'attendees.updated_at as updated_at',
    ])
    .where('attendees.tenant_id', '=', request.tenant_id)
    .where('orders.organization_id', '=', request.organization_id);

  if (request.brand_id) query = query.where('orders.brand_id', '=', request.brand_id);
  if (request.subject_email) query = query.where('attendees.email', '=', request.subject_email);
  if (request.subject_id && request.subject_type === 'attendee') {
    query = query.where('attendees.id', '=', request.subject_id);
  }

  return query;
}

async function buildPrivacyExport(db: Database, request: PrivacyRequestRow) {
  const [orders, attendees] = await Promise.all([
    baseOrderQuery(db, request).execute(),
    baseAttendeeQuery(db, request).execute(),
  ]);
  const attendeeIds = attendees.map((attendee) => String(attendee.id));
  const tickets =
    attendeeIds.length === 0
      ? []
      : await db
          .selectFrom('tickets')
          .select([
            'id',
            'order_id',
            'attendee_id',
            'event_id',
            'ticket_type_id',
            'status',
            'transferred_to_email',
            'transferred_at',
            'checked_in_at',
            'created_at',
            'updated_at',
          ])
          .where('tenant_id', '=', request.tenant_id)
          .where('attendee_id', 'in', attendeeIds)
          .execute();

  return {
    generatedAt: new Date().toISOString(),
    retentionPolicy: 'Financial ledgers, audit logs, invoices, tax snapshots, and fraud-prevention records are retained; buyer and attendee contact fields are exportable and erasable.',
    subject: {
      type: request.subject_type,
      id: request.subject_id,
      email: request.subject_email,
    },
    orders: orders.map((order) => ({
      id: order.id,
      eventId: order.event_id,
      status: order.status,
      currency: order.currency,
      totalCents: Number(order.total_cents),
      refundedCents: Number(order.refunded_cents),
      buyerEmail: order.buyer_email,
      buyerFirstName: order.buyer_first_name,
      buyerLastName: order.buyer_last_name,
      buyerPhone: order.buyer_phone,
      paidAt: order.paid_at,
      refundedAt: order.refunded_at,
      createdAt: order.created_at,
    })),
    attendees: attendees.map((attendee) => ({
      id: attendee.id,
      orderId: attendee.order_id,
      eventId: attendee.event_id,
      eventOccurrenceId: attendee.event_occurrence_id,
      ticketTypeId: attendee.ticket_type_id,
      ticketId: attendee.ticket_id,
      firstName: attendee.first_name,
      lastName: attendee.last_name,
      email: attendee.email,
      phone: attendee.phone,
      status: attendee.status,
      customAnswers: normalizeJson(attendee.custom_answers),
      checkedInAt: attendee.checked_in_at,
      createdAt: attendee.created_at,
      updatedAt: attendee.updated_at,
    })),
    tickets,
  };
}

async function erasePrivacyData(db: Database, request: PrivacyRequestRow) {
  const [orders, attendees] = await Promise.all([
    baseOrderQuery(db, request).execute(),
    baseAttendeeQuery(db, request).execute(),
  ]);
  const now = new Date();
  const orderIds = orders.map((order) => String(order.id));
  const attendeeIds = attendees.map((attendee) => String(attendee.id));
  const redactedSubjectEmail = erasedEmail(request.subject_email, `privacy:${request.id}`);

  await Promise.all(
    orders.map(async (order) => {
      await db
        .updateTable('orders')
        .set({
          buyer_email: erasedEmail(order.buyer_email, String(order.id)),
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          updated_at: now,
        })
        .where('id', '=', order.id)
        .where('tenant_id', '=', request.tenant_id)
        .execute();

      await db
        .updateTable('invoices')
        .set({
          buyer_email: erasedEmail(order.buyer_email, `invoice:${order.id}`),
          buyer_name: null,
          buyer_tax_id: null,
          updated_at: now,
        })
        .where('order_id', '=', order.id)
        .where('tenant_id', '=', request.tenant_id)
        .execute();
    }),
  );

  if (orderIds.length > 0) {
    const sessions = await db
      .selectFrom('checkout_sessions')
      .select(['id', 'buyer'])
      .where('tenant_id', '=', request.tenant_id)
      .where('order_id', 'in', orderIds)
      .execute();

    await Promise.all(
      sessions.map((session) =>
        db
          .updateTable('checkout_sessions')
          .set({
            buyer: JSON.stringify(redactJsonValue(session.buyer, redactedSubjectEmail)),
            updated_at: now,
          })
          .where('id', '=', session.id)
          .where('tenant_id', '=', request.tenant_id)
          .execute(),
      ),
    );
  }

  await Promise.all(
    attendees.map((attendee) =>
      db
        .updateTable('attendees')
        .set({
          email: erasedEmail(attendee.email, String(attendee.id)),
          first_name: null,
          last_name: null,
          phone: null,
          custom_answers: null,
          updated_at: now,
        })
        .where('id', '=', String(attendee.id))
        .where('tenant_id', '=', request.tenant_id)
        .execute(),
    ),
  );

  const ticketsTouched =
    attendeeIds.length === 0
      ? 0
      : countUpdatedRows(
          await db
            .updateTable('tickets')
            .set({ transferred_to_email: null, updated_at: now })
            .where('tenant_id', '=', request.tenant_id)
            .where('attendee_id', 'in', attendeeIds)
            .execute(),
        );

  await db
    .updateTable('audit_logs')
    .set({
      diff_summary: JSON.stringify({
        subjectEmail: redactedSubjectEmail,
        redactedAt: now.toISOString(),
      }),
    })
    .where('tenant_id', '=', request.tenant_id)
    .where('resource_type', '=', 'privacy_request')
    .where('resource_id', '=', request.id)
    .execute();

  await db
    .updateTable('privacy_requests')
    .set({ subject_email: redactedSubjectEmail })
    .where('id', '=', request.id)
    .where('tenant_id', '=', request.tenant_id)
    .execute();

  return {
    erasedAt: now.toISOString(),
    ordersRedacted: orderIds.length,
    attendeesRedacted: attendeeIds.length,
    ticketsTouched,
  };
}

export async function processPrivacyRequestActivity(input: {
  requestId: string;
}): Promise<WorkflowActivityResult<{ requestId: string; status: string }>> {
  const db = createDb(process.env.DATABASE_URL ?? '');
  const repo = new PrivacyRequestRepository(db);
  try {
    const request = (await repo.findById(input.requestId)) as PrivacyRequestRow | undefined;
    if (!request) {
      return errResult('privacy_request_not_found', `Privacy request not found: ${input.requestId}`);
    }
    if (request.status === 'completed') {
      return okResult({ requestId: input.requestId, status: 'completed' });
    }

    await repo.markProcessing(input.requestId);
    const result =
      request.request_type === 'erasure'
        ? await erasePrivacyData(db, request)
        : await buildPrivacyExport(db, request);
    await repo.markCompleted(input.requestId, result);
    return okResult({ requestId: input.requestId, status: 'completed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown privacy request failure';
    await repo.markFailed(input.requestId, message).catch(() => undefined);
    return errResult('privacy_request_failed', message, false);
  } finally {
    await db.destroy();
  }
}
