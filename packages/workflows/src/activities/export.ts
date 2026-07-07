import { createDb, type Database } from '@tixkit/db';
import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { ulid } from 'ulid';
import {
  parseExportFilterDateBoundary,
  parseExportFilters,
  type ExportFilters,
} from '@tixkit/domain';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

const exportEventChannel = (exportId: string) => `tixkit:export-job:${exportId}:events`;

function isValidExportFileUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function isLocalExportStorageMode() {
  return (
    process.env.EXPORT_STORAGE_MODE === 'local' ||
    process.env.NODE_ENV === 'test' ||
    (process.env.NODE_ENV === 'development' && process.env.S3_EXPORT_UPLOAD !== 'true')
  );
}

function exportContentType(format: string) {
  if (format === 'json') return 'application/json';
  if (format === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return 'text/csv';
}

function encodeS3Key(key: string) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function appendUrlPath(url: URL, ...segments: string[]) {
  const existing = url.pathname.replace(/\/+$/, '');
  const appended = segments.filter(Boolean).join('/');
  url.pathname = `${existing}/${appended}`.replace(/\/{2,}/g, '/');
  return url;
}

function buildS3FileUrl(input: {
  bucket: string;
  region: string;
  key: string;
  endpoint?: string;
  forcePathStyle: boolean;
}) {
  const encodedKey = encodeS3Key(input.key);
  if (!input.endpoint) {
    return `https://${input.bucket}.s3.${input.region}.amazonaws.com/${encodedKey}`;
  }

  const endpointUrl = new URL(input.endpoint);
  if (input.forcePathStyle) {
    return appendUrlPath(endpointUrl, encodeURIComponent(input.bucket), encodedKey).toString();
  }

  endpointUrl.hostname = `${input.bucket}.${endpointUrl.hostname}`;
  return appendUrlPath(endpointUrl, encodedKey).toString();
}

type ExportJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

type ExportJobEventPayload = {
  exportId: string;
  eventId?: string | null;
  type: string;
  format: string;
  status: ExportJobStatus;
  downloadUrl?: string;
  reason?: string;
  createdAt: Date | string;
  completedAt?: Date | string | null;
};

type PersistedExportJobEvent = {
  eventId: string;
  exportJob: Record<string, unknown>;
  payload: ExportJobEventPayload;
};

function serializeExportJobEventPayload(
  row: Record<string, unknown>,
  reason?: string,
): ExportJobEventPayload {
  const status = String(row.status) as ExportJobStatus;
  const downloadUrl =
    status === 'completed' && isValidExportFileUrl(row.file_url)
      ? `/v1/exports/${row.id}/download`
      : undefined;
  return {
    exportId: String(row.id),
    eventId: typeof row.event_id === 'string' ? row.event_id : undefined,
    type: String(row.type),
    format: String(row.format),
    status,
    downloadUrl,
    reason,
    createdAt: row.created_at as Date | string,
    completedAt: row.completed_at as Date | string | null | undefined,
  };
}

async function publishExportJobEvent(exportId: string, eventId: string) {
  if (process.env.NODE_ENV === 'test') return;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  const redis = new Redis(redisUrl, {
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.publish(exportEventChannel(exportId), eventId);
  } catch {
    // Durable DB events are the source of truth; Redis is best-effort fanout.
  } finally {
    await redis.quit().catch(() => {
      redis.disconnect();
    });
  }
}

async function recordExportJobStatus(
  db: Database,
  input: {
    exportId: string;
    status: ExportJobStatus;
    fileUrl?: string;
    reason?: string;
  },
): Promise<PersistedExportJobEvent> {
  const now = new Date();
  const result = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('export_jobs')
      .selectAll()
      .where('id', '=', input.exportId)
      .executeTakeFirstOrThrow();

    const updated = {
      ...current,
      status: input.status,
      file_url: input.fileUrl ?? current.file_url,
      completed_at:
        input.status === 'completed' || input.status === 'failed' ? now : current.completed_at,
    } as Record<string, unknown>;

    if (input.status === 'completed') {
      await trx
        .updateTable('export_jobs')
        .set({ status: input.status, file_url: input.fileUrl ?? null, completed_at: now })
        .where('id', '=', input.exportId)
        .execute();
    } else if (input.status === 'failed') {
      await trx
        .updateTable('export_jobs')
        .set({ status: input.status, completed_at: now })
        .where('id', '=', input.exportId)
        .execute();
    } else {
      await trx
        .updateTable('export_jobs')
        .set({ status: input.status })
        .where('id', '=', input.exportId)
        .execute();
    }

    const eventId = `eev_${ulid()}`;
    const payload = serializeExportJobEventPayload(updated, input.reason);
    await trx
      .insertInto('export_job_events')
      .values({
        id: eventId,
        tenant_id: String(current.tenant_id),
        export_job_id: input.exportId,
        status: input.status,
        payload: JSON.stringify(payload),
        created_at: now,
      })
      .execute();

    return { eventId, exportJob: updated, payload };
  });

  await publishExportJobEvent(input.exportId, result.eventId);
  return result;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
  }
  return lines.join('\n');
}

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows, null, 2);
}

async function toXlsx(rows: Record<string, unknown>[]): Promise<string> {
  // exceljs is an optional dependency for xlsx export.
  try {
    // @ts-expect-error - exceljs is an optional dependency
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Export');
    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      worksheet.addRow(headers);
      for (const row of rows) {
        worksheet.addRow(headers.map((h) => row[h] ?? ''));
      }
    }
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch {
    // Fallback to CSV if exceljs is not installed.
    return toCsv(rows);
  }
}

type ExportQuestion = {
  id: string;
  label: string;
  is_consent_field: boolean | null;
  consent_text: string | null;
  consent_version: string | null;
  applies_to: string | null;
  ticket_type_id: string | null;
  sort_order: number | null;
};

type ConsentAnswerSnapshot = {
  accepted: true;
  consentText: string;
  consentVersion: string;
  consentedAt: string;
};

function isConsentAnswerSnapshot(value: unknown): value is ConsentAnswerSnapshot {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { accepted?: unknown }).accepted === true &&
    typeof (value as { consentText?: unknown }).consentText === 'string' &&
    typeof (value as { consentVersion?: unknown }).consentVersion === 'string' &&
    typeof (value as { consentedAt?: unknown }).consentedAt === 'string',
  );
}

function isConsentAccepted(value: unknown): boolean {
  return value === true || isConsentAnswerSnapshot(value);
}

/**
 * Normalizes a consent version string for display, ensuring it carries a `v`
 * prefix without doubling it (e.g. `1` -> `v1`, `v2` -> `v2`).
 */
function normalizeVersionLabel(version: string): string {
  const trimmed = version.trim();
  if (/^v/i.test(trimmed)) return trimmed;
  return `v${trimmed}`;
}

/**
 * Renders a custom answer value into a CSV/JSON-friendly string.
 * Arrays are joined with `; ` so a single cell preserves all selected options.
 */
function formatAnswerValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join('; ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Builds the per-question column headers and per-attendee answer values for the
 * attendee export. Returns header suffixes and a function that maps an
 * attendee's `custom_answers` payload to the question/consent columns.
 *
 * Consent fields emit two columns:
 *   - `<label>` - "accepted" when the attendee accepted, empty otherwise
 *   - `<label> (consent text)` - the historical consent text + version snapshot
 * This preserves the consent text/version that was in force at acceptance time
 * for auditability, per the reporting & export contract (C6).
 */
function buildQuestionColumns(questions: ExportQuestion[]): {
  headers: string[];
  valuesFor: (customAnswers: string | null) => Record<string, string>;
} {
  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copied question list keeps export columns deterministic.
  const sorted = [...questions].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const headers: string[] = [];
  const accessors: Array<(answers: Record<string, unknown>) => string> = [];

  for (const q of sorted) {
    if (q.is_consent_field) {
      headers.push(q.label);
      headers.push(`${q.label} (consent text)`);
      accessors.push((answers) => {
        const answer = answers[q.id];
        return isConsentAccepted(answer) ? 'accepted' : '';
      });
      accessors.push((answers) => {
        const answer = answers[q.id];
        if (isConsentAnswerSnapshot(answer)) {
          return `${answer.consentText} (${normalizeVersionLabel(answer.consentVersion)})`;
        }
        if (answer === true) {
          // No snapshot stored; fall back to the question definition.
          const text = q.consent_text ?? q.label;
          const version = q.consent_version ?? '1';
          return `${text} (${normalizeVersionLabel(version)})`;
        }
        return '';
      });
    } else {
      headers.push(q.label);
      accessors.push((answers) => formatAnswerValue(answers[q.id]));
    }
  }

  const valuesFor = (customAnswers: string | null): Record<string, string> => {
    let parsed: Record<string, unknown> = {};
    if (customAnswers) {
      try {
        const decoded = JSON.parse(customAnswers);
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
          parsed = decoded as Record<string, unknown>;
        }
      } catch {
        // Leave parsed empty if the JSON is malformed.
      }
    }
    const out: Record<string, string> = {};
    headers.forEach((header, idx) => {
      out[header] = accessors[idx](parsed);
    });
    return out;
  };

  return { headers, valuesFor };
}

function applyDateFilter<T extends Record<string, unknown>>(
  query: T[],
  filters: ExportFilters,
  dateField = 'created_at',
): T[] {
  let result = query;
  if (filters.from) {
    const from = parseExportFilterDateBoundary(filters.from, 'start');
    result = result.filter((row) => {
      const value = row[dateField];
      return (value instanceof Date || typeof value === 'string') && new Date(value) >= from;
    });
  }
  if (filters.to) {
    const to = parseExportFilterDateBoundary(filters.to, 'end');
    result = result.filter((row) => {
      const value = row[dateField];
      return (value instanceof Date || typeof value === 'string') && new Date(value) <= to;
    });
  }
  return result;
}

function readPersistedExportFilters(type: string, persistedFilters: unknown) {
  try {
    const decoded =
      typeof persistedFilters === 'string'
        ? JSON.parse(persistedFilters)
        : (persistedFilters ?? {});
    return { ok: true as const, filters: parseExportFilters(type, decoded) };
  } catch {
    return { ok: false as const };
  }
}

export async function generateExportActivity(input: {
  exportId: string;
  type: string;
  format: string;
}): Promise<WorkflowActivityResult<{ data: string; rowCount: number }>> {
  const db = createDb();
  try {
    const { exportJob } = await recordExportJobStatus(db, {
      exportId: input.exportId,
      status: 'processing',
    });
    const tenantId = String(exportJob.tenant_id);
    const eventId = typeof exportJob.event_id === 'string' ? exportJob.event_id : undefined;

    const filterResult = readPersistedExportFilters(input.type, exportJob.filters);
    if (!filterResult.ok) {
      return errResult('EXPORT_FAILED', 'Invalid export filters', false);
    }
    const { filters } = filterResult;

    let rows: Record<string, unknown>[] = [];

    if (input.type === 'attendees') {
      let query = db.selectFrom('attendees').selectAll().where('tenant_id', '=', tenantId);

      if (eventId) {
        query = query.where('event_id', '=', eventId) as typeof query;
      }
      if (filters.status) {
        query = query.where('status', '=', filters.status) as typeof query;
      }
      if (filters.ticketTypeId) {
        query = query.where('ticket_type_id', '=', filters.ticketTypeId) as typeof query;
      }

      let attendees = await query.execute();
      if (filters.from || filters.to) {
        attendees = applyDateFilter(attendees, filters);
      }

      // Apply check-in status filter by joining to tickets.
      if (filters.checkInStatus) {
        const attendeeIds = new Set(attendees.map((a) => a.id));
        if (attendeeIds.size > 0) {
          const checkedInTickets = await db
            .selectFrom('tickets')
            .select(['attendee_id'])
            .where('attendee_id', 'in', [...attendeeIds])
            .where('status', '=', 'checked_in')
            .execute();
          const checkedInAttendeeIds = new Set(checkedInTickets.map((t) => t.attendee_id));
          attendees = attendees.filter((a) =>
            filters.checkInStatus === 'checked_in'
              ? checkedInAttendeeIds.has(a.id)
              : !checkedInAttendeeIds.has(a.id),
          );
        }
      }

      rows = attendees.map((a) => ({
        id: a.id,
        email: a.email,
        firstName: a.first_name,
        lastName: a.last_name,
        phone: a.phone,
        status: a.status,
        eventId: a.event_id,
        orderId: a.order_id,
        checkedInAt: a.checked_in_at,
        createdAt: a.created_at,
      }));

      // Append checkout question and consent answer columns when the event has
      // configured questions. This preserves historical consent text/version
      // snapshots for auditability (C6).
      if (eventId) {
        const questions = (await db
          .selectFrom('questions')
          .select([
            'id',
            'label',
            'is_consent_field',
            'consent_text',
            'consent_version',
            'applies_to',
            'ticket_type_id',
            'sort_order',
          ])
          .where('event_id', '=', eventId)
          .execute()) as ExportQuestion[];

        if (questions.length > 0) {
          const { valuesFor } = buildQuestionColumns(questions);
          rows = attendees.map((a) =>
            Object.assign(
              {
                id: a.id,
                email: a.email,
                firstName: a.first_name,
                lastName: a.last_name,
                phone: a.phone,
                status: a.status,
                eventId: a.event_id,
                orderId: a.order_id,
                checkedInAt: a.checked_in_at,
                createdAt: a.created_at,
              },
              valuesFor(a.custom_answers as string | null),
            ),
          );
        }
      }
    } else if (input.type === 'orders') {
      let query = db.selectFrom('orders').selectAll().where('tenant_id', '=', tenantId);

      if (eventId) {
        query = query.where('event_id', '=', eventId) as typeof query;
      }
      if (filters.status) {
        query = query.where('status', '=', filters.status) as typeof query;
      }

      let orders = await query.execute();
      if (filters.from || filters.to) {
        orders = applyDateFilter(orders, filters);
      }

      rows = orders.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        currency: o.currency,
        totalCents: o.total_cents,
        refundedCents: o.refunded_cents,
        buyerEmail: o.buyer_email,
        buyerFirstName: o.buyer_first_name,
        buyerLastName: o.buyer_last_name,
        paidAt: o.paid_at,
        createdAt: o.created_at,
      }));
    } else if (input.type === 'tickets') {
      let query = db.selectFrom('tickets').selectAll().where('tenant_id', '=', tenantId);

      if (eventId) {
        query = query.where('event_id', '=', eventId) as typeof query;
      }
      if (filters.status) {
        query = query.where('status', '=', filters.status) as typeof query;
      }
      if (filters.ticketTypeId) {
        query = query.where('ticket_type_id', '=', filters.ticketTypeId) as typeof query;
      }

      let tickets = await query.execute();
      if (filters.from || filters.to) {
        tickets = applyDateFilter(tickets, filters);
      }

      rows = tickets.map((t) => ({
        id: t.id,
        code: t.code,
        status: t.status,
        eventId: t.event_id,
        orderId: t.order_id,
        attendeeId: t.attendee_id,
        transferredToEmail: t.transferred_to_email,
        checkedInAt: t.checked_in_at,
        createdAt: t.created_at,
      }));
    } else if (input.type === 'scan_logs') {
      let query = db
        .selectFrom('scan_logs')
        .select([
          'scan_logs.id as id',
          'scan_logs.check_in_list_id as check_in_list_id',
          'scan_logs.device_id as device_id',
          'scan_logs.ticket_id as ticket_id',
          'scan_logs.qr_hash as qr_hash',
          'scan_logs.outcome as outcome',
          'scan_logs.scanned_at as scanned_at',
          'scan_logs.offline as offline',
          'scan_logs.created_at as created_at',
        ])
        .where('scan_logs.tenant_id', '=', tenantId);

      if (eventId) {
        query = query
          .innerJoin('check_in_lists', 'check_in_lists.id', 'scan_logs.check_in_list_id')
          .where('check_in_lists.event_id', '=', eventId) as typeof query;
      }
      if (filters.status) {
        query = query.where('scan_logs.outcome', '=', filters.status) as typeof query;
      }

      let scanLogs = await query
        .orderBy('scan_logs.scanned_at', 'asc')
        .orderBy('scan_logs.id', 'asc')
        .execute();
      if (filters.from || filters.to) {
        scanLogs = applyDateFilter(scanLogs, filters, 'scanned_at');
      }

      rows = scanLogs.map((s) => ({
        id: s.id,
        checkInListId: s.check_in_list_id,
        deviceId: s.device_id,
        ticketId: s.ticket_id,
        qrHash: s.qr_hash,
        outcome: s.outcome,
        scannedAt: s.scanned_at,
        offline: s.offline,
        createdAt: s.created_at,
      }));
    } else if (input.type === 'sales') {
      let query = db
        .selectFrom('orders')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('status', 'in', ['paid', 'partially_refunded', 'refunded']);

      if (eventId) {
        query = query.where('event_id', '=', eventId) as typeof query;
      }
      if (filters.status) {
        query = query.where('status', '=', filters.status) as typeof query;
      }

      let orders = await query.execute();
      if (filters.from || filters.to) {
        orders = applyDateFilter(orders, filters);
      }

      rows = orders.map((o) => ({
        orderId: o.id,
        orderNumber: o.order_number,
        status: o.status,
        currency: o.currency,
        grossCents: Number(o.total_cents),
        refundedCents: Number(o.refunded_cents),
        netCents: Number(o.total_cents) - Number(o.refunded_cents),
        taxCents: Number(o.tax_cents),
        feeCents: Number(o.fee_cents),
        buyerEmail: o.buyer_email,
        createdAt: o.created_at,
      }));
    } else if (input.type === 'tax') {
      let query = db
        .selectFrom('orders')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('status', 'in', ['paid', 'partially_refunded', 'refunded']);

      if (eventId) {
        query = query.where('event_id', '=', eventId) as typeof query;
      }

      let orders = await query.execute();
      if (filters.from || filters.to) {
        orders = applyDateFilter(orders, filters);
      }

      rows = orders.map((o) => ({
        orderId: o.id,
        orderNumber: o.order_number,
        currency: o.currency,
        taxableCents: Number(o.subtotal_cents) - Number(o.discount_cents),
        taxCents: Number(o.tax_cents),
        status: o.status,
        createdAt: o.created_at,
      }));
    }

    let data: string;
    if (input.format === 'json') {
      data = toJson(rows);
    } else if (input.format === 'xlsx') {
      data = await toXlsx(rows);
    } else {
      data = toCsv(rows);
    }

    return okResult({ data, rowCount: rows.length });
  } catch (err) {
    return errResult(
      'EXPORT_GENERATION_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function uploadFileActivity(input: {
  exportId: string;
  data: string;
  format: string;
}): Promise<WorkflowActivityResult<{ fileUrl: string }>> {
  try {
    const fileUrl = await uploadExportData(input.exportId, input.data, input.format);
    return okResult({ fileUrl });
  } catch (err) {
    return errResult(
      'FILE_UPLOAD_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

async function uploadExportData(exportId: string, data: string, format: string): Promise<string> {
  const bucket = process.env.S3_EXPORT_BUCKET ?? process.env.S3_BUCKET ?? 'tixkit-exports';
  const region = process.env.S3_EXPORT_REGION ?? process.env.S3_REGION ?? 'us-east-1';
  const key = `exports/${exportId}.${format}`;
  const s3Endpoint = process.env.S3_ENDPOINT;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  const fileUrl = buildS3FileUrl({
    bucket,
    region,
    key,
    endpoint: s3Endpoint,
    forcePathStyle,
  });

  if (!isLocalExportStorageMode()) {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together');
    }

    const s3Config: S3ClientConfig = { region };
    if (s3Endpoint) {
      s3Config.endpoint = s3Endpoint;
      s3Config.forcePathStyle = forcePathStyle;
    }
    if (accessKeyId && secretAccessKey) {
      s3Config.credentials = { accessKeyId, secretAccessKey };
    }

    const s3 = new S3Client(s3Config);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: exportContentType(format),
      }),
    );
  }

  return fileUrl;
}

export async function generateAndUploadExportActivity(input: {
  exportId: string;
  type: string;
  format: string;
}): Promise<WorkflowActivityResult<{ fileUrl: string; rowCount: number }>> {
  const genResult = await generateExportActivity(input);
  if (!genResult.ok) return genResult;

  try {
    const fileUrl = await uploadExportData(input.exportId, genResult.value.data, input.format);
    return okResult({ fileUrl, rowCount: genResult.value.rowCount });
  } catch (err) {
    return errResult(
      'FILE_UPLOAD_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function markExportFailedActivity(input: {
  exportId: string;
  reason?: string;
}): Promise<WorkflowActivityResult<{ failed: boolean }>> {
  const db = createDb();
  try {
    await recordExportJobStatus(db, {
      exportId: input.exportId,
      status: 'failed',
      reason: input.reason,
    });

    return okResult({ failed: true });
  } catch (err) {
    return errResult(
      'EXPORT_FAILURE_MARK_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function notifyExportCompleteActivity(input: {
  exportId: string;
  fileUrl: string;
  requestedBy: string;
  tenantId?: string;
}): Promise<WorkflowActivityResult<{ notified: boolean }>> {
  if (!isValidExportFileUrl(input.fileUrl)) {
    return errResult('INVALID_EXPORT_FILE_URL', 'Export file URL must use HTTPS');
  }

  const db = createDb();
  try {
    await recordExportJobStatus(db, {
      exportId: input.exportId,
      status: 'completed',
      fileUrl: input.fileUrl,
    });

    const downloadUrl = `/v1/exports/${input.exportId}/download`;

    try {
      // Queue an admin notification email with the scoped download route.
      // Look up the requesting user's email.
      if (input.tenantId && input.requestedBy) {
        const user = await db
          .selectFrom('user_profiles')
          .select(['email', 'tenant_id'])
          .where('id', '=', input.requestedBy)
          .executeTakeFirst();

        if (user?.email) {
          // Check for an active email provider route (use a platform default if no brand route).
          const route = await db
            .selectFrom('email_provider_routes')
            .select(['id', 'brand_id'])
            .where('tenant_id', '=', user.tenant_id)
            .where('status', '=', 'active')
            .where('smoke_send_verified', '=', true)
            .orderBy('priority', 'asc')
            .executeTakeFirst();

          const templateVersion = await db
            .selectFrom('notification_templates as template')
            .innerJoin(
              'notification_template_versions as version',
              'version.template_id',
              'template.id',
            )
            .select(['version.id'])
            .where('template.tenant_id', '=', user.tenant_id)
            .where('template.key', '=', 'staff-order-notification')
            .where('version.is_default', '=', true)
            .executeTakeFirst();

          if (route && templateVersion) {
            const { EmailJobRepository } = await import('@tixkit/db');
            const job = await new EmailJobRepository(db).create({
              tenantId: user.tenant_id,
              brandId: route.brand_id,
              templateKey: 'staff-order-notification',
              templateVersionId: templateVersion.id,
              toEmail: user.email,
              variables: {
                exportId: input.exportId,
                downloadUrl,
                notificationType: 'staff',
              },
              providerRouteId: route.id,
              priority: 'normal',
              idempotencyKey: `export-complete:${input.exportId}`,
            });

            // Start the notification delivery workflow.
            try {
              const { Connection, Client } = await import('@temporalio/client');
              const { notificationDeliveryWorkflow } = await import('../workflows/notification.js');
              const { notificationWorkflowId, NOTIFICATION_WORKFLOW_VERSION } =
                await import('../shared/types.js');
              const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
              const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
              const temporalTaskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit';
              const connection = await Connection.connect({ address: temporalAddress });
              const client = new Client({ connection, namespace: temporalNamespace });
              const workflowId = notificationWorkflowId(job.id);
              try {
                await client.workflow.start(notificationDeliveryWorkflow, {
                  taskQueue: temporalTaskQueue,
                  workflowId,
                  args: [
                    {
                      version: NOTIFICATION_WORKFLOW_VERSION,
                      jobId: job.id,
                      tenantId: user.tenant_id,
                      brandId: route.brand_id,
                      templateKey: 'staff-order-notification',
                      templateVersionId: templateVersion.id,
                      toEmail: user.email,
                      variables: {
                        exportId: input.exportId,
                        downloadUrl,
                        notificationType: 'staff',
                      },
                      providerRouteId: route.id,
                      notificationType: 'staff',
                    },
                  ],
                });
              } catch (err) {
                if (
                  !(
                    err instanceof Error &&
                    (err.name === 'WorkflowExecutionAlreadyStartedError' ||
                      err.message.includes('already started'))
                  )
                ) {
                  throw err;
                }
              }
            } catch {
              // Non-fatal: email job is queued for later drainage.
            }
          }
        }
      }
    } catch {
      return okResult({ notified: false });
    }

    return okResult({ notified: true });
  } catch (err) {
    return errResult(
      'EXPORT_COMPLETION_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}
