import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { StripeGateway } from '@tixkit/provider-clients';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const OPERATION_ID = 'postOrganizationsByOrganizationIdPaymentAccountsStripeConnect';

describeWithIntegrationDatabase('payment account route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let activePrincipal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_pay_auth_a_${suffix}`;
  const tenantB = `tnt_pay_auth_b_${suffix}`;
  const organizationA = `org_pay_auth_a_${suffix}`;
  const organizationAOther = `org_pay_auth_other_${suffix}`;
  const organizationB = `org_pay_auth_b_${suffix}`;
  const userId = `usr_pay_auth_${suffix}`;
  const providerAccountId = `acct_pay_auth_${suffix}`;
  const createConnectAccount = vi.fn<StripeGateway['createConnectAccount']>(async () => ({
    id: providerAccountId,
    defaultCurrency: 'usd',
    detailsSubmitted: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    requirements: { currently_due: ['business_profile.url'] },
    disabledReason: null,
  }));
  const createAccountLink = vi.fn<StripeGateway['createAccountLink']>(async () => ({
    url: `https://connect.stripe.test/onboard/${providerAccountId}`,
  }));
  const stripeGateway = {
    createPaymentIntent: vi.fn(async () => {
      throw new Error('payment intent creation is outside this authorization fixture');
    }),
    retrievePaymentIntent: vi.fn(async () => {
      throw new Error('payment intent retrieval is outside this authorization fixture');
    }),
    cancelPaymentIntent: vi.fn(async () => {
      throw new Error('payment intent cancellation is outside this authorization fixture');
    }),
    createRefund: vi.fn(async () => {
      throw new Error('refund creation is outside this authorization fixture');
    }),
    createConnectAccount,
    retrieveConnectAccount: vi.fn(async () => {
      throw new Error('Stripe account retrieval is outside this authorization fixture');
    }),
    deleteConnectAccount: vi.fn(async () => {
      throw new Error('Stripe account deletion is outside this authorization fixture');
    }),
    createAccountLink,
  } as StripeGateway;

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      type: 'user',
      id: userId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: ['billing.write'],
      ...overrides,
    };
  }

  function expectNoProviderCalls(): void {
    for (const providerCall of Object.values(stripeGateway)) {
      expect(providerCall).not.toHaveBeenCalled();
    }
  }

  async function insertTenant(id: string, name: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('organizations')
      .values({
        id,
        tenant_id: tenantId,
        name,
        slug: `${id}-slug`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function persistenceSnapshot() {
    const [accounts, audits] = await Promise.all([
      db
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
        .where('organization_id', 'in', [organizationA, organizationAOther, organizationB])
        .orderBy('id', 'asc')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select([
          'id',
          'tenant_id',
          'organization_id',
          'actor_type',
          'actor_id',
          'action',
          'resource_type',
          'resource_id',
        ])
        .where('tenant_id', 'in', [tenantA, tenantB])
        .where('organization_id', 'in', [organizationA, organizationAOther, organizationB])
        .orderBy('id', 'asc')
        .execute(),
    ]);
    return { accounts, audits };
  }

  async function invoke(organizationId: string) {
    return app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/payment-accounts/stripe-connect`,
      headers: { 'idempotency-key': `payment-account-auth-${suffix}` },
    });
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, `Payment authorization tenant A ${suffix}`);
    await insertTenant(tenantB, `Payment authorization tenant B ${suffix}`);
    await insertOrganization(
      organizationA,
      tenantA,
      `Payment authorization organization A ${suffix}`,
    );
    await insertOrganization(
      organizationAOther,
      tenantA,
      `Payment authorization other organization ${suffix}`,
    );
    await insertOrganization(
      organizationB,
      tenantB,
      `Payment authorization organization B ${suffix}`,
    );

    activePrincipal = principal();
    app = Fastify({ logger: false });
    app.decorate('context', { db, stripeGateway } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(tenantRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db
      .deleteFrom('audit_logs')
      .where('tenant_id', 'in', [tenantA, tenantB])
      .where('organization_id', 'in', [organizationA, organizationAOther, organizationB])
      .execute();
    await db
      .deleteFrom('payment_accounts')
      .where('organization_id', 'in', [organizationA, organizationAOther, organizationB])
      .execute();
    activePrincipal = principal();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.deleteFrom('audit_logs').where('tenant_id', 'in', [tenantA, tenantB]).execute();
      await db
        .deleteFrom('payment_accounts')
        .where('organization_id', 'in', [organizationA, organizationAOther, organizationB])
        .execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationA, organizationAOther, organizationB])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it(`binds ${OPERATION_ID} to the selected integration driver`, () => {
    expect(integrationDatabaseDriver()).toMatch(/^(?:mysql|postgres)$/u);
  });

  it('allows an unscoped human billing principal and records the exact provider and DB effects', async () => {
    const response = await invoke(organizationA);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      tenantId: tenantA,
      organizationId: organizationA,
      provider: 'stripe_connect',
      providerAccountId,
      status: 'pending',
      onboardingUrl: `https://connect.stripe.test/onboard/${providerAccountId}`,
    });
    expect(createConnectAccount).toHaveBeenCalledTimes(1);
    expect(createAccountLink).toHaveBeenCalledTimes(1);
    expect(stripeGateway.createPaymentIntent).not.toHaveBeenCalled();
    expect(stripeGateway.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(stripeGateway.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(stripeGateway.createRefund).not.toHaveBeenCalled();
    expect(stripeGateway.retrieveConnectAccount).not.toHaveBeenCalled();
    expect(stripeGateway.deleteConnectAccount).not.toHaveBeenCalled();
    expect(createConnectAccount).toHaveBeenCalledWith({
      country: 'US',
      businessName: `Payment authorization organization A ${suffix}`,
      metadata: { tenantId: tenantA, organizationId: organizationA },
      idempotencyKey: `stripe-connect-account:${tenantA}:${organizationA}`,
    });
    expect(createAccountLink).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: providerAccountId,
        idempotencyKey: `payment-account-auth-${suffix}:account-link:${providerAccountId}`,
      }),
    );

    const snapshot = await persistenceSnapshot();
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      provider: 'stripe_connect',
      provider_account_id: providerAccountId,
      status: 'pending',
      default_currency: 'usd',
    });
    expect(snapshot.audits).toHaveLength(1);
    expect(snapshot.audits[0]).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      actor_type: 'user',
      actor_id: userId,
      action: 'payment_account.created',
      resource_type: 'PaymentAccount',
      resource_id: snapshot.accounts[0]?.id,
    });
  });

  const denialCases = [
    {
      name: 'missing billing.write',
      expectedCode: 'FORBIDDEN',
      expectedStatus: 403,
      organizationId: organizationA,
      principal: () => principal({ scopes: [] }),
    },
    {
      name: 'cross-tenant organization',
      expectedCode: 'NOT_FOUND',
      expectedStatus: 404,
      organizationId: organizationB,
      principal: () => principal({ organizationIds: [organizationB] }),
    },
    {
      name: 'out-of-scope organization',
      expectedCode: 'NOT_FOUND',
      expectedStatus: 404,
      organizationId: organizationAOther,
      principal: () => principal(),
    },
    {
      name: 'brand-scoped human without an organization grant',
      expectedCode: 'FORBIDDEN',
      expectedStatus: 403,
      organizationId: organizationA,
      principal: () => principal({ brandIds: [`brd_pay_auth_${suffix}`] }),
    },
    {
      name: 'event-scoped human without an organization grant',
      expectedCode: 'FORBIDDEN',
      expectedStatus: 403,
      organizationId: organizationA,
      principal: () => principal({ eventIds: [`evt_pay_auth_${suffix}`] }),
    },
  ] as const;

  for (const denial of denialCases) {
    it(`denies ${denial.name} before provider or persistence effects`, async () => {
      const before = await persistenceSnapshot();
      activePrincipal = denial.principal();

      const response = await invoke(denial.organizationId);

      expect(response.statusCode).toBe(denial.expectedStatus);
      expect(response.json()).toMatchObject({ error: { code: denial.expectedCode } });
      expectNoProviderCalls();
      await expect(persistenceSnapshot()).resolves.toEqual(before);
    });
  }
});
