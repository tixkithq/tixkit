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

type CheckoutSessionPrivacyRow = {
  id: string;
  buyer: unknown;
};

type BrandPrivacyRow = {
  id: string;
};

type WaitlistEntryPrivacyRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string;
  ticket_type_id: string;
  buyer_email: string;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_phone: string | null;
  quantity: number;
  status: string;
  offer_expires_at: Date | null;
  offered_at: Date | null;
  claimed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type EmailJobPrivacyRow = {
  id: string;
  brand_id: string;
  template_key: string;
  to_email: string;
  to_name: string | null;
  variables: string;
  status: string;
  priority: string;
  scheduled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type SmsJobPrivacyRow = {
  id: string;
  brand_id: string;
  to_phone: string;
  body: string;
  template_key: string | null;
  variables: string;
  status: string;
  priority: string;
  scheduled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type EmailSuppressionPrivacyRow = {
  id: string;
  email: string;
  reason: string;
  bounce_type: string | null;
  source: string;
  created_at: Date;
};

type MessageConsentPrivacyRow = {
  id: string;
  attendee_id: string;
  email: string;
  phone: string | null;
  email_opt_in: boolean;
  sms_opt_in: boolean;
  consent_text: string;
  consent_version: string;
  consented_at: Date;
  revoked_at: Date | null;
  created_at: Date;
};

function isErasedPrivacyEmail(value: string | null | undefined): boolean {
  return /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/.test(value ?? '');
}

function erasedEmail(input: string | null | undefined, fallback: string): string {
  const source = input && input.length > 0 ? input.toLowerCase() : fallback;
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `erased+${digest}@privacy.tixkit.invalid`;
}

function erasedPhone(input: string | null | undefined, fallback: string): string {
  const source = input && input.length > 0 ? input : fallback;
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const numeric = String(BigInt(`0x${digest}`) % 10_000_000_000n).padStart(10, '0');
  return `+1${numeric}`;
}

function normalizeJson(value: unknown): unknown {
  if (value == null || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function scopedBrandIdsForRequest(
  db: Database,
  request: PrivacyRequestRow,
): Promise<string[]> {
  if (request.brand_id) return [request.brand_id];
  return (
    (await db
      .selectFrom('brands')
      .select(['id'])
      .where('tenant_id', '=', request.tenant_id)
      .where('organization_id', '=', request.organization_id)
      .execute()) as BrandPrivacyRow[]
  ).map((brand) => brand.id);
}

function collectSubjectEmails(
  request: PrivacyRequestRow,
  orders: Array<{ buyer_email: unknown }>,
  attendees: Array<{ email: unknown }>,
  waitlistEntries: Array<{ buyer_email: unknown }>,
) {
  return uniqueStrings([
    request.subject_email,
    ...orders.map((order) => String(order.buyer_email ?? '') || null),
    ...attendees.map((attendee) => String(attendee.email ?? '') || null),
    ...waitlistEntries.map((entry) => String(entry.buyer_email ?? '') || null),
  ]).filter((email) => !isErasedPrivacyEmail(email));
}

function collectSubjectPhones(
  orders: Array<{ buyer_phone: unknown }>,
  attendees: Array<{ phone: unknown }>,
  waitlistEntries: Array<{ buyer_phone: unknown }>,
) {
  return uniqueStrings([
    ...orders.map((order) => String(order.buyer_phone ?? '') || null),
    ...attendees.map((attendee) => String(attendee.phone ?? '') || null),
    ...waitlistEntries.map((entry) => String(entry.buyer_phone ?? '') || null),
  ]);
}

function containsAnyJsonString(value: unknown, needles: string[]): boolean {
  return needles.some((needle) => jsonContainsString(value, needle));
}

function mergeRowsById<T extends { id: string }>(rows: T[]): T[] {
  const merged = new Map<string, T>();
  for (const row of rows) merged.set(row.id, row);
  return [...merged.values()];
}

async function collectMessagingPrivacyRows(
  db: Database,
  request: PrivacyRequestRow,
  input: {
    scopedBrandIds: string[];
    subjectEmails: string[];
    subjectPhones: string[];
    attendeeIds: string[];
  },
) {
  const { attendeeIds, scopedBrandIds, subjectEmails, subjectPhones } = input;
  const emailJobQueries: Array<Promise<EmailJobPrivacyRow[]>> = [];
  const smsJobQueries: Array<Promise<SmsJobPrivacyRow[]>> = [];
  const messageConsentQueries: Array<Promise<MessageConsentPrivacyRow[]>> = [];

  if (scopedBrandIds.length > 0 && subjectEmails.length > 0) {
    emailJobQueries.push(
      db
        .selectFrom('email_jobs')
        .select([
          'id',
          'brand_id',
          'template_key',
          'to_email',
          'to_name',
          'variables',
          'status',
          'priority',
          'scheduled_at',
          'created_at',
          'updated_at',
        ])
        .where('tenant_id', '=', request.tenant_id)
        .where('brand_id', 'in', scopedBrandIds)
        .where('to_email', 'in', subjectEmails)
        .execute() as Promise<EmailJobPrivacyRow[]>,
    );
  }

  if (scopedBrandIds.length > 0) {
    for (const attendeeId of attendeeIds) {
      emailJobQueries.push(
        db
          .selectFrom('email_jobs')
          .select([
            'id',
            'brand_id',
            'template_key',
            'to_email',
            'to_name',
            'variables',
            'status',
            'priority',
            'scheduled_at',
            'created_at',
            'updated_at',
          ])
          .where('tenant_id', '=', request.tenant_id)
          .where('brand_id', 'in', scopedBrandIds)
          .where('variables', 'like', `%${attendeeId}%`)
          .execute() as Promise<EmailJobPrivacyRow[]>,
      );
    }
  }

  if (scopedBrandIds.length > 0 && subjectPhones.length > 0) {
    smsJobQueries.push(
      db
        .selectFrom('sms_jobs')
        .select([
          'id',
          'brand_id',
          'to_phone',
          'body',
          'template_key',
          'variables',
          'status',
          'priority',
          'scheduled_at',
          'created_at',
          'updated_at',
        ])
        .where('tenant_id', '=', request.tenant_id)
        .where('brand_id', 'in', scopedBrandIds)
        .where('to_phone', 'in', subjectPhones)
        .execute() as Promise<SmsJobPrivacyRow[]>,
    );
  }

  if (scopedBrandIds.length > 0) {
    for (const attendeeId of attendeeIds) {
      smsJobQueries.push(
        db
          .selectFrom('sms_jobs')
          .select([
            'id',
            'brand_id',
            'to_phone',
            'body',
            'template_key',
            'variables',
            'status',
            'priority',
            'scheduled_at',
            'created_at',
            'updated_at',
          ])
          .where('tenant_id', '=', request.tenant_id)
          .where('brand_id', 'in', scopedBrandIds)
          .where('variables', 'like', `%${attendeeId}%`)
          .execute() as Promise<SmsJobPrivacyRow[]>,
      );
    }
  }

  if (attendeeIds.length > 0) {
    messageConsentQueries.push(
      db
        .selectFrom('message_consents')
        .select([
          'id',
          'attendee_id',
          'email',
          'phone',
          'email_opt_in',
          'sms_opt_in',
          'consent_text',
          'consent_version',
          'consented_at',
          'revoked_at',
          'created_at',
        ])
        .where('tenant_id', '=', request.tenant_id)
        .where('attendee_id', 'in', attendeeIds)
        .execute() as Promise<MessageConsentPrivacyRow[]>,
    );
  }

  const emailSuppressions =
    subjectEmails.length === 0
      ? []
      : ((await db
          .selectFrom('email_suppressions')
          .select(['id', 'email', 'reason', 'bounce_type', 'source', 'created_at'])
          .where('tenant_id', '=', request.tenant_id)
          .where('email', 'in', subjectEmails)
          .execute()) as EmailSuppressionPrivacyRow[]);

  const [emailJobResults, smsJobResults, messageConsentResults] = await Promise.all([
    Promise.all(emailJobQueries),
    Promise.all(smsJobQueries),
    Promise.all(messageConsentQueries),
  ]);

  const needles = [...attendeeIds, ...subjectEmails, ...subjectPhones];
  const emailJobs = mergeRowsById(emailJobResults.flat()).filter(
    (job) => subjectEmails.includes(job.to_email) || containsAnyJsonString(job.variables, needles),
  );
  const smsJobs = mergeRowsById(smsJobResults.flat()).filter(
    (job) => subjectPhones.includes(job.to_phone) || containsAnyJsonString(job.variables, needles),
  );
  const messageConsents = mergeRowsById(messageConsentResults.flat());

  return {
    emailJobs,
    smsJobs,
    emailSuppressions,
    messageConsents,
  };
}

function redactJsonValue(
  value: unknown,
  replacementEmail: string,
  options: {
    replacementPhone?: string | null;
    subjectEmails?: string[];
    subjectPhones?: string[];
  } = {},
): unknown {
  const parsed = normalizeJson(value);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => redactJsonValue(entry, replacementEmail, options));
  }
  if (typeof parsed === 'string') {
    if (options.subjectEmails?.includes(parsed)) return replacementEmail;
    if (options.subjectPhones?.includes(parsed)) return options.replacementPhone ?? null;
    return parsed;
  }
  if (!parsed || typeof parsed !== 'object') return parsed;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('email')) {
      redacted[key] = replacementEmail;
    } else if (normalizedKey.includes('phone')) {
      redacted[key] = options.replacementPhone ?? null;
    } else if (
      normalizedKey.includes('name') ||
      normalizedKey.includes('taxid') ||
      normalizedKey.includes('tax_id')
    ) {
      redacted[key] = null;
    } else {
      redacted[key] = redactJsonValue(entry, replacementEmail, options);
    }
  }
  return redacted;
}

function jsonContainsString(value: unknown, needle: string): boolean {
  const parsed = normalizeJson(value);
  if (typeof parsed === 'string') return parsed === needle;
  if (Array.isArray(parsed)) return parsed.some((entry) => jsonContainsString(entry, needle));
  if (!parsed || typeof parsed !== 'object') return false;
  return Object.values(parsed).some((entry) => jsonContainsString(entry, needle));
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
  if (request.subject_id && request.subject_type === 'buyer')
    query = query.where('id', '=', request.subject_id);

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

function baseWaitlistEntryQuery(db: Database, request: PrivacyRequestRow) {
  let query = db
    .selectFrom('waitlist_entries')
    .select([
      'id',
      'tenant_id',
      'organization_id',
      'brand_id',
      'event_id',
      'ticket_type_id',
      'buyer_email',
      'buyer_first_name',
      'buyer_last_name',
      'buyer_phone',
      'quantity',
      'status',
      'offer_expires_at',
      'offered_at',
      'claimed_at',
      'cancelled_at',
      'created_at',
      'updated_at',
    ])
    .where('tenant_id', '=', request.tenant_id)
    .where('organization_id', '=', request.organization_id);

  if (request.brand_id) query = query.where('brand_id', '=', request.brand_id);
  if (request.subject_email) {
    query = query.where('buyer_email', '=', request.subject_email);
  } else {
    query = query.where('id', '=', `privacy-request:${request.id}:no-subject-email`);
  }

  return query;
}

async function buildPrivacyExport(db: Database, request: PrivacyRequestRow) {
  const [orders, attendees, waitlistEntries] = await Promise.all([
    baseOrderQuery(db, request).execute(),
    baseAttendeeQuery(db, request).execute(),
    baseWaitlistEntryQuery(db, request).execute() as Promise<WaitlistEntryPrivacyRow[]>,
  ]);
  const attendeeIds = attendees.map((attendee) => String(attendee.id));
  const scopedBrandIds = await scopedBrandIdsForRequest(db, request);
  const subjectEmails = collectSubjectEmails(request, orders, attendees, waitlistEntries);
  const subjectPhones = collectSubjectPhones(orders, attendees, waitlistEntries);
  const messaging = await collectMessagingPrivacyRows(db, request, {
    attendeeIds,
    scopedBrandIds,
    subjectEmails,
    subjectPhones,
  });
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
    retentionPolicy:
      'Financial ledgers, audit logs, invoices, tax snapshots, and fraud-prevention records are retained; buyer, attendee, waitlist, messaging contact, and messaging consent fields are exportable and erasable.',
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
    waitlistEntries: waitlistEntries.map((entry) => ({
      id: entry.id,
      eventId: entry.event_id,
      ticketTypeId: entry.ticket_type_id,
      buyerEmail: entry.buyer_email,
      buyerFirstName: entry.buyer_first_name,
      buyerLastName: entry.buyer_last_name,
      buyerPhone: entry.buyer_phone,
      quantity: Number(entry.quantity),
      status: entry.status,
      offerExpiresAt: entry.offer_expires_at,
      offeredAt: entry.offered_at,
      claimedAt: entry.claimed_at,
      cancelledAt: entry.cancelled_at,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    })),
    tickets,
    messaging: {
      emailJobs: messaging.emailJobs.map((job) => ({
        id: job.id,
        brandId: job.brand_id,
        templateKey: job.template_key,
        toEmail: job.to_email,
        toName: job.to_name,
        variables: normalizeJson(job.variables),
        status: job.status,
        priority: job.priority,
        scheduledAt: job.scheduled_at,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      })),
      smsJobs: messaging.smsJobs.map((job) => ({
        id: job.id,
        brandId: job.brand_id,
        toPhone: job.to_phone,
        body: job.body,
        templateKey: job.template_key,
        variables: normalizeJson(job.variables),
        status: job.status,
        priority: job.priority,
        scheduledAt: job.scheduled_at,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      })),
      emailSuppressions: messaging.emailSuppressions.map((suppression) => ({
        id: suppression.id,
        email: suppression.email,
        reason: suppression.reason,
        bounceType: suppression.bounce_type,
        source: suppression.source,
        createdAt: suppression.created_at,
      })),
      messageConsents: messaging.messageConsents.map((consent) => ({
        id: consent.id,
        attendeeId: consent.attendee_id,
        email: consent.email,
        phone: consent.phone,
        emailOptIn: consent.email_opt_in,
        smsOptIn: consent.sms_opt_in,
        consentText: consent.consent_text,
        consentVersion: consent.consent_version,
        consentedAt: consent.consented_at,
        revokedAt: consent.revoked_at,
        createdAt: consent.created_at,
      })),
    },
  };
}

async function erasePrivacyData(db: Database, request: PrivacyRequestRow) {
  const [orders, attendees, waitlistEntries] = await Promise.all([
    baseOrderQuery(db, request).execute(),
    baseAttendeeQuery(db, request).execute(),
    baseWaitlistEntryQuery(db, request).execute() as Promise<WaitlistEntryPrivacyRow[]>,
  ]);
  const now = new Date();
  const orderIds = orders.map((order) => String(order.id));
  const attendeeIds = attendees.map((attendee) => String(attendee.id));
  const redactedSubjectEmail = erasedEmail(request.subject_email, `privacy:${request.id}`);
  const subjectEmails = collectSubjectEmails(request, orders, attendees, waitlistEntries);
  const subjectPhones = collectSubjectPhones(orders, attendees, waitlistEntries);
  const redactedPhone = erasedPhone(
    subjectPhones[0] ?? request.subject_email,
    `privacy:${request.id}`,
  );
  const buyerOrderId = request.subject_type === 'buyer' ? request.subject_id : null;
  const scopedBrandIds = await scopedBrandIdsForRequest(db, request);
  const messaging = await collectMessagingPrivacyRows(db, request, {
    attendeeIds,
    scopedBrandIds,
    subjectEmails,
    subjectPhones,
  });

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

  if (request.subject_email && (!request.subject_id || buyerOrderId)) {
    let invoiceQuery = db
      .updateTable('invoices')
      .set({
        buyer_email: erasedEmail(request.subject_email, `invoice:${request.id}`),
        buyer_name: null,
        buyer_tax_id: null,
        updated_at: now,
      })
      .where('tenant_id', '=', request.tenant_id)
      .where('organization_id', '=', request.organization_id);
    if (request.brand_id) invoiceQuery = invoiceQuery.where('brand_id', '=', request.brand_id);
    if (buyerOrderId) {
      invoiceQuery = invoiceQuery.where('order_id', '=', buyerOrderId);
    } else {
      invoiceQuery = invoiceQuery.where('buyer_email', '=', request.subject_email);
    }
    await invoiceQuery.execute();
  }

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
            buyer: JSON.stringify(
              redactJsonValue(session.buyer, redactedSubjectEmail, {
                subjectEmails,
                subjectPhones,
              }),
            ),
            updated_at: now,
          })
          .where('id', '=', session.id)
          .where('tenant_id', '=', request.tenant_id)
          .execute(),
      ),
    );
  }

  if (request.subject_email && (!request.subject_id || buyerOrderId) && scopedBrandIds.length > 0) {
    let retainedSessionQuery = db
      .selectFrom('checkout_sessions')
      .select(['id', 'buyer'])
      .where('tenant_id', '=', request.tenant_id)
      .where('brand_id', 'in', scopedBrandIds);
    if (buyerOrderId)
      retainedSessionQuery = retainedSessionQuery.where('order_id', '=', buyerOrderId);
    const retainedSessions = (await retainedSessionQuery.execute()) as CheckoutSessionPrivacyRow[];

    await Promise.all(
      retainedSessions
        .filter(
          (session) =>
            buyerOrderId || jsonContainsString(session.buyer, String(request.subject_email)),
        )
        .map((session) =>
          db
            .updateTable('checkout_sessions')
            .set({
              buyer: JSON.stringify(
                redactJsonValue(session.buyer, redactedSubjectEmail, {
                  subjectEmails,
                  subjectPhones,
                }),
              ),
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

  await Promise.all(
    waitlistEntries.map((entry) =>
      db
        .updateTable('waitlist_entries')
        .set({
          buyer_email: erasedEmail(entry.buyer_email, `waitlist:${entry.id}`),
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          updated_at: now,
        })
        .where('id', '=', entry.id)
        .where('tenant_id', '=', request.tenant_id)
        .execute(),
    ),
  );

  const emailJobUpdates = await Promise.all(
    messaging.emailJobs.map((job) =>
      db
        .updateTable('email_jobs')
        .set({
          to_email: erasedEmail(job.to_email, `email_job:${job.id}`),
          to_name: null,
          variables: JSON.stringify(
            redactJsonValue(job.variables, redactedSubjectEmail, {
              replacementPhone: redactedPhone,
              subjectEmails,
              subjectPhones,
            }),
          ),
          updated_at: now,
        })
        .where('id', '=', job.id)
        .where('tenant_id', '=', request.tenant_id)
        .execute(),
    ),
  );

  const smsJobUpdates = await Promise.all(
    messaging.smsJobs.map((job) =>
      db
        .updateTable('sms_jobs')
        .set({
          to_phone: erasedPhone(job.to_phone, `sms_job:${job.id}`),
          body: '[redacted by privacy request]',
          variables: JSON.stringify(
            redactJsonValue(job.variables, redactedSubjectEmail, {
              replacementPhone: redactedPhone,
              subjectEmails,
              subjectPhones,
            }),
          ),
          updated_at: now,
        })
        .where('id', '=', job.id)
        .where('tenant_id', '=', request.tenant_id)
        .execute(),
    ),
  );

  const emailSuppressionUpdates = await Promise.all(
    messaging.emailSuppressions.map((suppression) =>
      db
        .updateTable('email_suppressions')
        .set({
          email: erasedEmail(suppression.email, `email_suppression:${suppression.id}`),
        })
        .where('id', '=', suppression.id)
        .where('tenant_id', '=', request.tenant_id)
        .execute(),
    ),
  );

  const messageConsentUpdates = await Promise.all(
    messaging.messageConsents.map((consent) =>
      db
        .updateTable('message_consents')
        .set({
          email: erasedEmail(consent.email, `message_consent:${consent.id}`),
          phone: consent.phone ? erasedPhone(consent.phone, `message_consent:${consent.id}`) : null,
          consent_text: '[redacted by privacy request]',
        })
        .where('id', '=', consent.id)
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
    waitlistEntriesRedacted: waitlistEntries.length,
    ticketsTouched,
    emailJobsRedacted: countUpdatedRows(emailJobUpdates.flat()),
    smsJobsRedacted: countUpdatedRows(smsJobUpdates.flat()),
    emailSuppressionsRedacted: countUpdatedRows(emailSuppressionUpdates.flat()),
    messageConsentsRedacted: countUpdatedRows(messageConsentUpdates.flat()),
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
      return errResult(
        'privacy_request_not_found',
        `Privacy request not found: ${input.requestId}`,
      );
    }
    if (request.status === 'completed') {
      return okResult({ requestId: input.requestId, status: 'completed' });
    }
    if (request.request_type !== 'erasure' && request.request_type !== 'export') {
      const message = `Unsupported privacy request type: ${String(request.request_type)}`;
      try {
        await repo.markFailed(input.requestId, message);
      } catch (error) {
        const retryMessage =
          error instanceof Error ? error.message : 'Unknown privacy request failure';
        return errResult('privacy_request_failed', retryMessage, true);
      }
      return errResult('privacy_request_invalid_type', message);
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
    return errResult('privacy_request_failed', message, true);
  } finally {
    await db.destroy();
  }
}

export async function enforcePrivacyRetentionActivity(
  input: {
    batchSize?: number;
    requestId?: string;
  } = {},
): Promise<
  WorkflowActivityResult<{ inspectedCount: number; repairedCount: number; skippedCount: number }>
> {
  const db = createDb(process.env.DATABASE_URL ?? '');
  const repo = new PrivacyRequestRepository(db);
  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 250);
  try {
    let requestQuery = db
      .selectFrom('privacy_requests')
      .selectAll()
      .where('request_type', '=', 'erasure')
      .where('status', '=', 'completed')
      .where('subject_email', 'is not', null)
      .where('subject_email', 'not like', 'erased+%@privacy.tixkit.invalid');
    if (input.requestId) requestQuery = requestQuery.where('id', '=', input.requestId);
    const requests = (await requestQuery
      .orderBy('created_at', 'asc')
      .limit(batchSize)
      .execute()) as PrivacyRequestRow[];

    const repairOutcomes = await Promise.all(
      requests.map(async (request) => {
        if (!request.subject_email || isErasedPrivacyEmail(request.subject_email)) {
          return 'skipped' as const;
        }

        const result = await erasePrivacyData(db, request);
        await repo.markCompleted(request.id, result);
        return 'repaired' as const;
      }),
    );
    const repairedCount = repairOutcomes.filter((outcome) => outcome === 'repaired').length;
    const skippedCount = repairOutcomes.filter((outcome) => outcome === 'skipped').length;

    return okResult({
      inspectedCount: requests.length,
      repairedCount,
      skippedCount,
    });
  } catch (error) {
    return errResult(
      'privacy_retention_failed',
      error instanceof Error ? error.message : 'Unknown privacy retention failure',
      true,
    );
  } finally {
    await db.destroy();
  }
}
