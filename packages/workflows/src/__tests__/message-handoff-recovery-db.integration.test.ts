import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, EmailJobRepository, SmsJobRepository, sql, type Database } from '@tixkit/db';
import { runMigrations } from '@tixkit/db/migrate';
import { ulid } from 'ulid';

type WorkflowStartOptions = {
  workflowId: string;
  args: Array<Record<string, unknown>>;
};

const temporalMock = vi.hoisted(() => ({
  alreadyStartedWorkflowIds: new Set<string>(),
  connectionClose: vi.fn(async () => undefined),
  connectionConnect: vi.fn(async () => ({ close: temporalMock.connectionClose })),
  failuresRemaining: new Map<string, Error>(),
  workflowStart: vi.fn(async (_workflow: unknown, options: WorkflowStartOptions) => {
    const failure = temporalMock.failuresRemaining.get(options.workflowId);
    if (failure) {
      temporalMock.failuresRemaining.delete(options.workflowId);
      throw failure;
    }
    if (temporalMock.alreadyStartedWorkflowIds.has(options.workflowId)) {
      throw Object.assign(new Error('Workflow execution already started'), {
        name: 'WorkflowExecutionAlreadyStartedError',
      });
    }
  }),
  clientConstructor: vi.fn(function Client() {
    return { workflow: { start: temporalMock.workflowStart } };
  }),
}));

vi.mock('@temporalio/client', () => ({
  Connection: { connect: temporalMock.connectionConnect },
  Client: temporalMock.clientConstructor,
}));

import {
  closeActivityClients,
  type EmailJobNotificationHandoffRow,
  type SmsJobNotificationHandoffRow,
} from '../activities/activity-clients.js';
import { recoverQueuedMessageHandoffsActivity } from '../activities/hold-expiration.js';

const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const originalDbDriver = process.env.DB_DRIVER;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalMysqlDatabaseUrl = process.env.DATABASE_URL_MYSQL;
const dbUrl =
  requestedDriver === 'mysql' ? process.env.DATABASE_URL_MYSQL : process.env.DATABASE_URL;
const adminUrl =
  requestedDriver === 'mysql' && dbUrl
    ? (process.env.DATABASE_URL_MYSQL_ADMIN ?? mysqlAdminUrlFrom(dbUrl))
    : dbUrl;

const RUN_ID = ulid().slice(-10).toLowerCase();
const DATABASE_NAME = `tixkit_handoff_${RUN_ID}`;
const TENANT_ID = `tnt_handoff_${RUN_ID}`;
const ORGANIZATION_ID = `org_handoff_${RUN_ID}`;
const BRAND_ID = `brd_handoff_${RUN_ID}`;
const TEMPLATE_ID = `nt_handoff_${RUN_ID}`;
const TEMPLATE_VERSION_ID = `ntv_handoff_${RUN_ID}`;
const EMAIL_PROVIDER_ROUTE_ID = `epr_handoff_${RUN_ID}`;
const SMS_SENDER_IDENTITY_ID = `ssi_handoff_${RUN_ID}`;
const SMS_PROVIDER_ROUTE_ID = `spr_handoff_${RUN_ID}`;
const PRIVATE_EMAIL = `private-${RUN_ID}@example.test`;
const PRIVATE_PHONE = '+15555550173';

type SeededJobs = {
  email: EmailJobNotificationHandoffRow;
  sms: SmsJobNotificationHandoffRow;
};

describe.skipIf(!dbUrl)('message handoff recovery database integration', () => {
  let adminDb!: Database;
  let databaseCreated = false;
  let db!: Database;

  beforeAll(async () => {
    if (requestedDriver) process.env.DB_DRIVER = requestedDriver;
    adminDb = createDb(adminUrl);
    await createIsolatedDatabase(adminDb);
    databaseCreated = true;
    const isolatedUrl = databaseUrlFor(DATABASE_NAME, adminUrl!);
    if (requestedDriver === 'mysql') {
      process.env.DATABASE_URL_MYSQL = isolatedUrl;
    } else {
      process.env.DATABASE_URL = isolatedUrl;
    }
    await runMigrations(isolatedUrl);
    db = createDb(isolatedUrl);
    await seedBaseRows(db);
  });

  beforeEach(async () => {
    temporalMock.alreadyStartedWorkflowIds.clear();
    temporalMock.failuresRemaining.clear();
    vi.clearAllMocks();
    await deleteJobs(db);
  });

  afterEach(async () => {
    await closeActivityClients();
  });

  afterAll(async () => {
    let cleanupError: unknown;
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    await attempt(closeActivityClients);
    if (db) await attempt(() => db.destroy());
    if (databaseCreated) await attempt(() => dropIsolatedDatabase(adminDb));
    if (adminDb) await attempt(() => adminDb.destroy());
    restoreEnvironment('DB_DRIVER', originalDbDriver);
    restoreEnvironment('DATABASE_URL', originalDatabaseUrl);
    restoreEnvironment('DATABASE_URL_MYSQL', originalMysqlDatabaseUrl);
    if (cleanupError) throw cleanupError;
  });

  it('persists deterministic workflow ids and exact provider routes without replaying recovered jobs', async () => {
    const jobs = await seedJobs(db, 'queued', 'start_failed');

    await expect(recoverQueuedMessageHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredEmailCount: 1, recoveredSmsCount: 1 },
    });

    await expectJobState(db, jobs.email.id, jobs.sms.id, {
      emailStatus: 'queued',
      emailWorkflowId: `notification:${jobs.email.id}`,
      smsStatus: 'queued',
      smsWorkflowId: `sms-delivery:${jobs.sms.id}`,
    });
    expect(startOptionsFor(`notification:${jobs.email.id}`)).toMatchObject({
      workflowId: `notification:${jobs.email.id}`,
      args: [{ providerRouteId: EMAIL_PROVIDER_ROUTE_ID }],
    });
    expect(startOptionsFor(`sms-delivery:${jobs.sms.id}`)).toMatchObject({
      workflowId: `sms-delivery:${jobs.sms.id}`,
      args: [{ providerRouteId: SMS_PROVIDER_ROUTE_ID }],
    });

    const startsAfterFirstRecovery = temporalMock.workflowStart.mock.calls.length;
    await expect(recoverQueuedMessageHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredEmailCount: 0, recoveredSmsCount: 0 },
    });
    expect(temporalMock.workflowStart).toHaveBeenCalledTimes(startsAfterFirstRecovery);
  });

  it('keeps a failed handoff durable while its sibling succeeds, then recovers it exactly once', async () => {
    const jobs = await seedJobs(db, 'queued', 'queued');
    temporalMock.failuresRemaining.set(
      `notification:${jobs.email.id}`,
      new Error(`provider body for ${PRIVATE_EMAIL} contained api-secret-${RUN_ID}`),
    );

    const failedResult = await recoverQueuedMessageHandoffsActivity();

    expect(failedResult).toEqual({
      ok: false,
      errorCode: 'MESSAGE_HANDOFF_RECOVERY_FAILED',
      retryable: true,
      message: '1 queued message handoff(s) could not reach Temporal',
    });
    expect(JSON.stringify(failedResult)).not.toContain(PRIVATE_EMAIL);
    expect(JSON.stringify(failedResult)).not.toContain(`api-secret-${RUN_ID}`);
    await expectJobState(db, jobs.email.id, jobs.sms.id, {
      emailStatus: 'start_failed',
      emailWorkflowId: null,
      smsStatus: 'queued',
      smsWorkflowId: `sms-delivery:${jobs.sms.id}`,
    });

    await expect(recoverQueuedMessageHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredEmailCount: 1, recoveredSmsCount: 0 },
    });
    await expectJobState(db, jobs.email.id, jobs.sms.id, {
      emailStatus: 'queued',
      emailWorkflowId: `notification:${jobs.email.id}`,
      smsStatus: 'queued',
      smsWorkflowId: `sms-delivery:${jobs.sms.id}`,
    });

    const startsAfterRecovery = temporalMock.workflowStart.mock.calls.length;
    await recoverQueuedMessageHandoffsActivity();
    expect(temporalMock.workflowStart).toHaveBeenCalledTimes(startsAfterRecovery);
  });

  it('keeps both failed handoffs durable and redacts provider and recipient details before retry', async () => {
    const jobs = await seedJobs(db, 'queued', 'start_failed');
    temporalMock.failuresRemaining.set(
      `notification:${jobs.email.id}`,
      new Error(`smtp 550 recipient=${PRIVATE_EMAIL} raw-provider-response-${RUN_ID}`),
    );
    temporalMock.failuresRemaining.set(
      `sms-delivery:${jobs.sms.id}`,
      new Error(`sms 429 recipient=${PRIVATE_PHONE} provider-token-${RUN_ID}`),
    );

    const failedResult = await recoverQueuedMessageHandoffsActivity();

    expect(failedResult).toEqual({
      ok: false,
      errorCode: 'MESSAGE_HANDOFF_RECOVERY_FAILED',
      retryable: true,
      message: '2 queued message handoff(s) could not reach Temporal',
    });
    const serializedResult = JSON.stringify(failedResult);
    expect(serializedResult).not.toContain(PRIVATE_EMAIL);
    expect(serializedResult).not.toContain(PRIVATE_PHONE);
    expect(serializedResult).not.toContain(`raw-provider-response-${RUN_ID}`);
    expect(serializedResult).not.toContain(`provider-token-${RUN_ID}`);
    await expectJobState(db, jobs.email.id, jobs.sms.id, {
      emailStatus: 'start_failed',
      emailWorkflowId: null,
      smsStatus: 'start_failed',
      smsWorkflowId: null,
    });

    await expect(recoverQueuedMessageHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredEmailCount: 1, recoveredSmsCount: 1 },
    });
    await expectJobState(db, jobs.email.id, jobs.sms.id, {
      emailStatus: 'queued',
      emailWorkflowId: `notification:${jobs.email.id}`,
      smsStatus: 'queued',
      smsWorkflowId: `sms-delivery:${jobs.sms.id}`,
    });
  });

  it('accepts already-started workflows and records their deterministic ids', async () => {
    const jobs = await seedJobs(db, 'queued', 'start_failed');
    temporalMock.alreadyStartedWorkflowIds.add(`notification:${jobs.email.id}`);
    temporalMock.alreadyStartedWorkflowIds.add(`sms-delivery:${jobs.sms.id}`);

    await expect(recoverQueuedMessageHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredEmailCount: 1, recoveredSmsCount: 1 },
    });
    await expectJobState(db, jobs.email.id, jobs.sms.id, {
      emailStatus: 'queued',
      emailWorkflowId: `notification:${jobs.email.id}`,
      smsStatus: 'queued',
      smsWorkflowId: `sms-delivery:${jobs.sms.id}`,
    });
  });
});

function startOptionsFor(workflowId: string): WorkflowStartOptions | undefined {
  return temporalMock.workflowStart.mock.calls
    .map((call) => call[1])
    .find((options) => options.workflowId === workflowId);
}

async function seedJobs(
  db: Database,
  emailStatus: 'queued' | 'start_failed',
  smsStatus: 'queued' | 'start_failed',
): Promise<SeededJobs> {
  const emailRepository = new EmailJobRepository(db);
  const smsRepository = new SmsJobRepository(db);
  const email = await emailRepository.create({
    tenantId: TENANT_ID,
    brandId: BRAND_ID,
    templateKey: 'handoff-recovery',
    templateVersionId: TEMPLATE_VERSION_ID,
    toEmail: PRIVATE_EMAIL,
    toName: 'Private Recipient',
    variables: { notificationType: 'transactional', privateCode: `private-${RUN_ID}` },
    providerRouteId: EMAIL_PROVIDER_ROUTE_ID,
    idempotencyKey: `handoff-email-${ulid()}`,
    status: emailStatus,
  });
  const sms = await smsRepository.create({
    tenantId: TENANT_ID,
    brandId: BRAND_ID,
    toPhone: PRIVATE_PHONE,
    body: `Private message ${RUN_ID}`,
    variables: { notificationType: 'transactional', privateCode: `private-${RUN_ID}` },
    providerRouteId: SMS_PROVIDER_ROUTE_ID,
    idempotencyKey: `handoff-sms-${ulid()}`,
    status: smsStatus,
  });
  return { email, sms };
}

async function expectJobState(
  db: Database,
  emailJobId: string,
  smsJobId: string,
  expected: {
    emailStatus: string;
    emailWorkflowId: string | null;
    smsStatus: string;
    smsWorkflowId: string | null;
  },
) {
  const [email, sms] = await Promise.all([
    new EmailJobRepository(db).findById(emailJobId),
    new SmsJobRepository(db).findById(smsJobId),
  ]);
  expect(email).toMatchObject({
    status: expected.emailStatus,
    workflow_id: expected.emailWorkflowId,
    provider_route_id: EMAIL_PROVIDER_ROUTE_ID,
  });
  expect(sms).toMatchObject({
    status: expected.smsStatus,
    workflow_id: expected.smsWorkflowId,
    provider_route_id: SMS_PROVIDER_ROUTE_ID,
  });
}

async function deleteJobs(db: Database) {
  await db.deleteFrom('email_jobs').where('tenant_id', '=', TENANT_ID).execute();
  await db.deleteFrom('sms_jobs').where('tenant_id', '=', TENANT_ID).execute();
}

async function seedBaseRows(db: Database) {
  const now = new Date();
  await db
    .insertInto('tenants')
    .values({
      id: TENANT_ID,
      name: 'Message Handoff Recovery Tenant',
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: ORGANIZATION_ID,
      tenant_id: TENANT_ID,
      name: 'Message Handoff Recovery Organization',
      slug: `message-handoff-${RUN_ID}`,
      clerk_organization_id: null,
      status: 'active',
      box_office_settings: JSON.stringify({ enabled: false }),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: BRAND_ID,
      tenant_id: TENANT_ID,
      organization_id: ORGANIZATION_ID,
      name: 'Message Handoff Recovery Brand',
      slug: `message-handoff-${RUN_ID}`,
      status: 'active',
      theme: JSON.stringify({}),
      legal_urls: JSON.stringify({}),
      white_label: false,
      payment_account_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('notification_templates')
    .values({
      id: TEMPLATE_ID,
      tenant_id: TENANT_ID,
      brand_id: BRAND_ID,
      key: 'handoff-recovery',
      name: 'Handoff recovery',
      description: null,
      category: 'transactional',
      variables: JSON.stringify({}),
      current_version_id: TEMPLATE_VERSION_ID,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('notification_template_versions')
    .values({
      id: TEMPLATE_VERSION_ID,
      template_id: TEMPLATE_ID,
      version: 1,
      subject_template: 'Handoff recovery',
      html_template: '<p>Handoff recovery</p>',
      text_template: 'Handoff recovery',
      locale: 'en',
      is_default: true,
      published_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_provider_routes')
    .values({
      id: EMAIL_PROVIDER_ROUTE_ID,
      tenant_id: TENANT_ID,
      brand_id: BRAND_ID,
      provider_type: 'capture',
      credentials_ref: 'capture-email',
      sender_domain: 'example.test',
      priority: 0,
      is_fallback: false,
      rate_limit_per_hour: null,
      allowed_categories: JSON.stringify(['transactional']),
      status: 'active',
      smoke_send_verified: true,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('sms_sender_identities')
    .values({
      id: SMS_SENDER_IDENTITY_ID,
      tenant_id: TENANT_ID,
      brand_id: BRAND_ID,
      sender: '+15555550199',
      kind: 'phone_number',
      provider_type: 'capture',
      provider_sender_id: null,
      verified: true,
      verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('sms_provider_routes')
    .values({
      id: SMS_PROVIDER_ROUTE_ID,
      tenant_id: TENANT_ID,
      brand_id: BRAND_ID,
      provider_type: 'capture',
      credentials_ref: 'capture-sms',
      sender_identity_id: SMS_SENDER_IDENTITY_ID,
      priority: 0,
      is_fallback: false,
      rate_limit_per_hour: null,
      allowed_categories: JSON.stringify(['transactional']),
      status: 'active',
      smoke_send_verified: true,
      webhook_url: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function databaseUrlFor(databaseName: string, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function mysqlAdminUrlFrom(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.username = 'root';
  return url.toString();
}

function restoreEnvironment(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function createIsolatedDatabase(adminDb: Database) {
  const statement =
    requestedDriver === 'mysql'
      ? `CREATE DATABASE \`${DATABASE_NAME}\``
      : `CREATE DATABASE "${DATABASE_NAME}"`;
  await sql.raw(statement).execute(adminDb);
}

async function dropIsolatedDatabase(adminDb: Database) {
  const statement =
    requestedDriver === 'mysql'
      ? `DROP DATABASE IF EXISTS \`${DATABASE_NAME}\``
      : `DROP DATABASE IF EXISTS "${DATABASE_NAME}"`;
  await sql.raw(statement).execute(adminDb);
}
