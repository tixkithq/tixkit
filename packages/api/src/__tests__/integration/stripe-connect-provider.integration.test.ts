import Fastify from 'fastify';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';

const runStripeConnectTests = process.env.RUN_STRIPE_CONNECT_TESTS === '1';
const describeStripeConnect = runStripeConnectTests ? describe : describe.skip;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Stripe Connect validation`);
  return value;
}

function idSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 12);
}

function makePrincipal(tenantId: string, organizationId: string): Principal {
  return {
    id: `usr_connect_${tenantId.slice(-6)}`,
    type: 'user',
    tenantId,
    organizationIds: [organizationId],
    scopes: ['settings.write', 'billing.write'],
  };
}

async function seedOrganization(
  db: Database,
  ids: { tenantId: string; organizationId: string; suffix: string },
): Promise<void> {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: ids.tenantId,
        name: `Stripe Connect ${ids.suffix}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('organizations')
      .values({
        id: ids.organizationId,
        tenant_id: ids.tenantId,
        name: `Stripe Connect ${ids.suffix}`,
        slug: `stripe-connect-${ids.suffix}`,
        clerk_organization_id: null,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

async function cleanupRows(
  db: Database,
  ids: { tenantId: string; organizationId: string },
): Promise<void> {
  await db.deleteFrom('audit_logs').where('tenant_id', '=', ids.tenantId).execute();
  await db
    .deleteFrom('payment_accounts')
    .where('organization_id', '=', ids.organizationId)
    .execute();
  await db.deleteFrom('organizations').where('id', '=', ids.organizationId).execute();
  await db.deleteFrom('tenants').where('id', '=', ids.tenantId).execute();
}

async function setupTenantApp(db: Database, principal: Principal) {
  const app = Fastify();
  app.decorate('context', { db } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(tenantRoutes);
  registerErrorHandler(app);
  return app;
}

describeStripeConnect('Stripe Connect onboarding/status validation (real Stripe test mode)', () => {
  let db: Database;
  let stripe: Stripe;
  let ids: { suffix: string; tenantId: string; organizationId: string } | undefined;
  let providerAccountId: string | undefined;

  beforeAll(() => {
    requiredEnv('DATABASE_URL');
    requiredEnv('STRIPE_SECRET_KEY');
    requiredEnv('STRIPE_CONNECT_CLIENT_ID');
    db = createDb(process.env.DATABASE_URL);
    stripe = new Stripe(requiredEnv('STRIPE_SECRET_KEY'));
  });

  afterEach(async () => {
    if (providerAccountId) {
      await stripe.accounts.del(providerAccountId).catch(() => undefined);
    }
    if (ids) {
      await cleanupRows(db, ids).catch(() => undefined);
    }
    ids = undefined;
    providerAccountId = undefined;
  });

  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('creates a real Express account, persists it, and refreshes status/link from Stripe', async () => {
    const suffix = idSuffix();
    ids = {
      suffix,
      tenantId: `tnt_sc_${suffix}`.slice(0, 32),
      organizationId: `org_sc_${suffix}`.slice(0, 32),
    };
    await seedOrganization(db, ids);

    const app = await setupTenantApp(db, makePrincipal(ids.tenantId, ids.organizationId));
    try {
      const createRes = await app.inject({
        method: 'POST',
        url: `/organizations/${ids.organizationId}/payment-accounts/stripe-connect`,
      });
      expect(createRes.statusCode).toBe(201);

      const created = createRes.json() as {
        id: string;
        provider: string;
        providerAccountId: string;
        status: string;
        defaultCurrency: string;
        onboardingUrl?: string;
      };
      providerAccountId = created.providerAccountId;
      expect(created).toMatchObject({
        provider: 'stripe_connect',
        providerAccountId: expect.stringMatching(/^acct_/),
        defaultCurrency: 'USD',
      });
      expect(['active', 'pending', 'restricted']).toContain(created.status);
      expect(created.onboardingUrl).toEqual(
        expect.stringMatching(/^https:\/\/connect\.stripe\.com\//),
      );

      const persisted = await db
        .selectFrom('payment_accounts')
        .select([
          'id',
          'tenant_id',
          'organization_id',
          'provider',
          'provider_account_id',
          'status',
          'default_currency',
        ])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(persisted).toMatchObject({
        tenant_id: ids.tenantId,
        organization_id: ids.organizationId,
        provider: 'stripe_connect',
        provider_account_id: providerAccountId,
        status: created.status,
        default_currency: created.defaultCurrency,
      });

      const stripeAccount = await stripe.accounts.retrieve(providerAccountId);
      expect(stripeAccount.metadata).toMatchObject({
        tenantId: ids.tenantId,
        organizationId: ids.organizationId,
      });

      const refreshRes = await app.inject({
        method: 'POST',
        url: `/organizations/${ids.organizationId}/payment-accounts/${created.id}/stripe-connect/refresh`,
      });
      expect(refreshRes.statusCode).toBe(200);

      const refreshed = refreshRes.json() as {
        id: string;
        providerAccountId: string;
        status: string;
        defaultCurrency: string;
        onboardingUrl?: string;
      };
      expect(refreshed).toMatchObject({
        id: created.id,
        providerAccountId,
      });
      expect(['active', 'pending', 'restricted']).toContain(refreshed.status);
      expect(refreshed.defaultCurrency).toEqual(expect.stringMatching(/^[A-Z]{3}$/));
      expect(refreshed.onboardingUrl).toEqual(
        expect.stringMatching(/^https:\/\/connect\.stripe\.com\//),
      );

      const refreshedRow = await db
        .selectFrom('payment_accounts')
        .select(['status', 'default_currency'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(refreshedRow).toMatchObject({
        status: refreshed.status,
        default_currency: refreshed.defaultCurrency,
      });
    } finally {
      await app.close();
    }
  }, 30_000);
});
