import { randomBytes } from 'node:crypto';
import {
  ApiKeyRepository,
  createDb,
  readSandboxEnvironment,
  resetDatabase,
  runMigrations,
  SANDBOX_FIXTURE_VERSION,
  writeSandboxEnvironment,
} from '@tixkit/db';
import {
  SAMPLE_BRAND_ID,
  SAMPLE_EVENT_SLUG,
  SAMPLE_ORGANIZATION_ID,
  SAMPLE_TENANT_ID,
  seedSampleData,
} from './seed-sample-data.js';

const SANDBOX_LOCKED_TICKET_ID = 'tt_locked_sandbox';
const SANDBOX_ACCESS_RULE_ID = 'acr_locked_sandbox';
export const SANDBOX_ACCESS_CODE = 'SANDBOX-VIP';

export type SandboxResetResult = {
  ok: boolean;
  message: string;
  epoch?: string;
  apiKey?: string;
  expiresAt?: string;
  taskQueue?: string;
  eventId?: string;
  eventSlug?: string;
  accessCode?: string;
};

export function validateSandboxDatabaseUrl(input: {
  sandboxUrl?: string;
  primaryUrl?: string;
  allowRemote?: boolean;
}): URL {
  if (!input.sandboxUrl) throw new Error('TIXKIT_SANDBOX_DATABASE_URL is required.');
  const sandbox = new URL(input.sandboxUrl);
  if (!['postgres:', 'postgresql:', 'mysql:'].includes(sandbox.protocol)) {
    throw new Error('Sandbox database must use PostgreSQL or MySQL.');
  }
  if (
    input.primaryUrl &&
    databaseIdentity(input.primaryUrl) === databaseIdentity(input.sandboxUrl)
  ) {
    throw new Error('Sandbox and primary database URLs must be different.');
  }
  const databaseName = sandbox.pathname.slice(sandbox.pathname.lastIndexOf('/') + 1);
  if (!/^(?:tixkit[_-])?(?:sandbox|test)(?:[_-][a-z0-9_-]+)?$/iu.test(databaseName)) {
    throw new Error(
      'Sandbox database name must follow the tixkit_sandbox or tixkit_test_* convention.',
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(sandbox.hostname);
  if (!local && !input.allowRemote) {
    throw new Error('Remote sandbox reset requires TIXKIT_ALLOW_REMOTE_SANDBOX_RESET=1.');
  }
  return sandbox;
}

export function databaseIdentity(value: string): string {
  const url = new URL(value);
  const host = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    ? 'loopback'
    : url.hostname.toLowerCase();
  const postgres = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  const driver = postgres ? 'postgres:' : url.protocol;
  const defaultPort = postgres ? '5432' : '3306';
  const database = decodeURIComponent(url.pathname).normalize('NFC').toLowerCase();
  return `${driver}//${host}:${url.port || defaultPort}${database}`;
}

export async function initializeSandbox(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SandboxResetResult> {
  let sandbox: URL;
  try {
    sandbox = validateSandboxDatabaseUrl({
      sandboxUrl: environment.TIXKIT_SANDBOX_DATABASE_URL,
      primaryUrl: environment.DATABASE_URL,
      allowRemote: environment.TIXKIT_ALLOW_REMOTE_SANDBOX_RESET === '1',
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const databaseName = sandbox.pathname.slice(sandbox.pathname.lastIndexOf('/') + 1);
  if (environment.TIXKIT_SANDBOX_INITIALIZE_CONFIRM !== `INITIALIZE ${databaseName}`) {
    return {
      ok: false,
      message: `Set TIXKIT_SANDBOX_INITIALIZE_CONFIRM="INITIALIZE ${databaseName}".`,
    };
  }
  await runMigrations(sandbox.toString());
  const db = createDb(sandbox.toString());
  try {
    const existing = await readSandboxEnvironment(db);
    if (existing) {
      return {
        ok: true,
        message: 'Sandbox marker already exists.',
        epoch: existing.epoch,
        taskQueue: existing.taskQueue,
      };
    }
    const epoch = `initialized-${randomBytes(8).toString('hex')}`;
    const taskQueue = `tixkit-sandbox-${epoch}`;
    await writeSandboxEnvironment(db, {
      epoch,
      taskQueue,
      fixtureVersion: SANDBOX_FIXTURE_VERSION,
      resetAt: new Date(),
    });
    return {
      ok: true,
      message: 'Sandbox marker initialized. Run sandbox:reset next.',
      epoch,
      taskQueue,
    };
  } finally {
    await db.destroy();
  }
}

export async function resetSandbox(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SandboxResetResult> {
  if (environment.TIXKIT_SANDBOX_RESET_COORDINATION !== 'STOPPED') {
    return {
      ok: false,
      message:
        'Stop sandbox API/workers, then set TIXKIT_SANDBOX_RESET_COORDINATION=STOPPED for this reset.',
    };
  }
  let sandbox: URL;
  try {
    sandbox = validateSandboxDatabaseUrl({
      sandboxUrl: environment.TIXKIT_SANDBOX_DATABASE_URL,
      primaryUrl: environment.DATABASE_URL,
      allowRemote: environment.TIXKIT_ALLOW_REMOTE_SANDBOX_RESET === '1',
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (environment.TIXKIT_RUNTIME_MODE !== 'sandbox') {
    return { ok: false, message: 'Sandbox reset requires TIXKIT_RUNTIME_MODE=sandbox.' };
  }

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = sandbox.toString();
  try {
    const preflightDb = createDb(sandbox.toString());
    try {
      if (!(await readSandboxEnvironment(preflightDb))) {
        return {
          ok: false,
          message: 'Sandbox database marker is missing; run sandbox:initialize first.',
        };
      }
    } finally {
      await preflightDb.destroy();
    }
    await resetDatabase(sandbox.toString());
    const fixtureNow = new Date();
    fixtureNow.setUTCHours(0, 0, 0, 0);
    const seeded = await seedSampleData({ now: fixtureNow, assumeEmpty: true });
    if (!seeded.ok || !seeded.eventId) return seeded;
    const epoch = randomBytes(12).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const db = createDb(sandbox.toString());
    try {
      const now = new Date();
      const taskQueue = `tixkit-sandbox-${epoch}`;
      await writeSandboxEnvironment(db, {
        epoch,
        taskQueue,
        fixtureVersion: SANDBOX_FIXTURE_VERSION,
        resetAt: now,
      });
      await db
        .insertInto('ticket_types')
        .values({
          id: SANDBOX_LOCKED_TICKET_ID,
          event_id: seeded.eventId,
          name: 'Locked Sandbox Admission',
          description: 'Hidden ticket revealed only by the sandbox access code.',
          kind: 'paid',
          status: 'active',
          visibility: 'hidden',
          currency: 'USD',
          price_cents: 1_500,
          min_per_order: 1,
          max_per_order: 2,
          inventory_pool_id: 'pool_sample_data',
          sort_order: 2,
          requires_access_code: true,
          created_at: fixtureNow,
          updated_at: fixtureNow,
        })
        .execute();
      await db
        .insertInto('access_rules')
        .values({
          id: SANDBOX_ACCESS_RULE_ID,
          ticket_type_id: SANDBOX_LOCKED_TICKET_ID,
          type: 'code',
          value: SANDBOX_ACCESS_CODE,
          max_uses: null,
          uses_count: 0,
          expires_at: null,
          created_at: fixtureNow,
          updated_at: fixtureNow,
        })
        .execute();
      const credential = await new ApiKeyRepository(db).create({
        tenantId: SAMPLE_TENANT_ID,
        organizationId: SAMPLE_ORGANIZATION_ID,
        name: `Sandbox epoch ${epoch}`,
        scopes: ['events.read', 'orders.read', 'developers.write'],
        brandIds: [SAMPLE_BRAND_ID],
        eventIds: [seeded.eventId],
        expiresAt,
      });
      return {
        ok: true,
        message: 'Sandbox reset completed. The API key is shown once and expires in 24 hours.',
        epoch,
        apiKey: credential.apiKey,
        expiresAt: expiresAt.toISOString(),
        taskQueue,
        eventId: seeded.eventId,
        eventSlug: SAMPLE_EVENT_SLUG,
        accessCode: SANDBOX_ACCESS_CODE,
      };
    } finally {
      await db.destroy();
    }
  } catch (error) {
    return {
      ok: false,
      message: `Sandbox reset failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}
