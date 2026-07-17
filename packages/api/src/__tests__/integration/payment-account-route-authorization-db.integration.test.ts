import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ProviderOperationError, type StripeGateway } from '@tixkit/provider-clients';
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

const OPERATION_IDS = [
  'getOrganizationsByOrganizationIdPaymentAccounts',
  'postOrganizationsByOrganizationIdPaymentAccountsStripeConnect',
  'postOrganizationsByOrganizationIdPaymentAccountsByPaymentAccountIdStripeConnectRefresh',
] as const;

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
  const paymentAccountA = `pa_pay_auth_a_${suffix}`;
  const paymentAccountAOther = `pa_pay_auth_other_${suffix}`;
  const paymentAccountB = `pa_pay_auth_b_${suffix}`;
  const paymentAccountNonStripe = `pa_pay_auth_manual_${suffix}`;
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
  const retrieveConnectAccount = vi.fn<StripeGateway['retrieveConnectAccount']>(async () => ({
    id: providerAccountId,
    defaultCurrency: 'eur',
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
    requirements: { currently_due: [] },
    disabledReason: null,
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
    retrieveConnectAccount,
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

  async function insertPaymentAccount(input: {
    id: string;
    tenantId: string;
    organizationId: string;
    provider?: string;
    providerAccountId?: string;
    status?: string;
    defaultCurrency?: string;
  }): Promise<void> {
    const now = new Date();
    await db
      .insertInto('payment_accounts')
      .values({
        id: input.id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        provider: input.provider ?? 'stripe_connect',
        provider_account_id: input.providerAccountId ?? `${input.id}_provider`,
        status: input.status ?? 'pending',
        default_currency: input.defaultCurrency ?? 'usd',
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: '{}',
        disabled_reason: null,
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
          'details_submitted',
          'charges_enabled',
          'payouts_enabled',
          'requirements',
          'disabled_reason',
          'refresh_generation',
          'updated_at',
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
          'diff_summary',
        ])
        .where('tenant_id', 'in', [tenantA, tenantB])
        .where('organization_id', 'in', [organizationA, organizationAOther, organizationB])
        .orderBy('id', 'asc')
        .execute(),
    ]);
    return { accounts, audits };
  }

  function parseDatabaseJson(value: unknown): unknown {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  async function invokeCreate(organizationId: string) {
    return app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/payment-accounts/stripe-connect`,
      headers: { 'idempotency-key': `payment-account-auth-${suffix}` },
    });
  }

  async function invokeList(organizationId: string) {
    return app.inject({
      method: 'GET',
      url: `/organizations/${organizationId}/payment-accounts`,
    });
  }

  async function invokeRefresh(organizationId: string, paymentAccountId: string) {
    return app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/payment-accounts/${paymentAccountId}/stripe-connect/refresh`,
      headers: { 'idempotency-key': `payment-account-refresh-${suffix}` },
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
    vi.restoreAllMocks();
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

  it(`binds ${OPERATION_IDS.join(', ')} to the selected integration driver`, () => {
    expect(integrationDatabaseDriver()).toMatch(/^(?:mysql|postgres)$/u);
  });

  it('allows an unscoped human billing principal and records the exact provider and DB effects', async () => {
    const response = await invokeCreate(organizationA);

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

      const response = await invokeCreate(denial.organizationId);

      expect(response.statusCode).toBe(denial.expectedStatus);
      expect(response.json()).toMatchObject({ error: { code: denial.expectedCode } });
      expectNoProviderCalls();
      await expect(persistenceSnapshot()).resolves.toEqual(before);
    });
  }

  it('lists only payment accounts from the authorized organization without provider effects', async () => {
    await insertPaymentAccount({
      id: paymentAccountA,
      tenantId: tenantA,
      organizationId: organizationA,
      providerAccountId,
    });
    await insertPaymentAccount({
      id: paymentAccountAOther,
      tenantId: tenantA,
      organizationId: organizationAOther,
    });
    await insertPaymentAccount({
      id: paymentAccountB,
      tenantId: tenantB,
      organizationId: organizationB,
    });
    const before = await persistenceSnapshot();

    const response = await invokeList(organizationA);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: paymentAccountA,
        tenantId: tenantA,
        organizationId: organizationA,
        providerAccountId,
      }),
    ]);
    expectNoProviderCalls();
    await expect(persistenceSnapshot()).resolves.toEqual(before);
  });

  for (const denial of denialCases) {
    it(`denies payment-account listing for ${denial.name} without provider or persistence effects`, async () => {
      await insertPaymentAccount({
        id: paymentAccountA,
        tenantId: tenantA,
        organizationId: organizationA,
        providerAccountId,
      });
      const before = await persistenceSnapshot();
      activePrincipal = denial.principal();

      const response = await invokeList(denial.organizationId);

      expect(response.statusCode).toBe(denial.expectedStatus);
      expect(response.json()).toMatchObject({ error: { code: denial.expectedCode } });
      expectNoProviderCalls();
      await expect(persistenceSnapshot()).resolves.toEqual(before);
    });
  }

  it('refreshes an owned Stripe account and atomically records its provider-derived state', async () => {
    await insertPaymentAccount({
      id: paymentAccountA,
      tenantId: tenantA,
      organizationId: organizationA,
      providerAccountId,
    });

    const response = await invokeRefresh(organizationA, paymentAccountA);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: paymentAccountA,
      tenantId: tenantA,
      organizationId: organizationA,
      provider: 'stripe_connect',
      providerAccountId,
      status: 'active',
      defaultCurrency: 'eur',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      onboardingUrl: `https://connect.stripe.test/onboard/${providerAccountId}`,
    });
    expect(retrieveConnectAccount).toHaveBeenCalledTimes(1);
    expect(retrieveConnectAccount).toHaveBeenCalledWith(providerAccountId);
    expect(createAccountLink).toHaveBeenCalledTimes(1);
    expect(createAccountLink).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: providerAccountId,
        idempotencyKey: `payment-account-refresh-${suffix}:account-link:${providerAccountId}`,
      }),
    );
    const snapshot = await persistenceSnapshot();
    expect(snapshot.accounts).toEqual([
      expect.objectContaining({
        id: paymentAccountA,
        status: 'active',
        default_currency: 'eur',
        refresh_generation: 1,
      }),
    ]);
    expect(snapshot.audits).toEqual([
      expect.objectContaining({
        tenant_id: tenantA,
        organization_id: organizationA,
        actor_type: 'user',
        actor_id: userId,
        action: 'payment_account.refreshed',
        resource_type: 'PaymentAccount',
        resource_id: paymentAccountA,
      }),
    ]);
    expect(parseDatabaseJson(snapshot.audits[0]?.diff_summary)).toEqual({
      providerAccountId,
      before: {
        status: 'pending',
        defaultCurrency: 'usd',
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: {},
        disabledReason: null,
      },
      after: {
        status: 'active',
        defaultCurrency: 'eur',
        detailsSubmitted: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        requirements: { currently_due: [] },
        disabledReason: null,
      },
    });
  });

  for (const denial of denialCases) {
    it(`denies payment-account refresh for ${denial.name} before provider or persistence effects`, async () => {
      await insertPaymentAccount({
        id: paymentAccountA,
        tenantId: tenantA,
        organizationId: organizationA,
        providerAccountId,
      });
      const before = await persistenceSnapshot();
      activePrincipal = denial.principal();

      const response = await invokeRefresh(denial.organizationId, paymentAccountA);

      expect(response.statusCode).toBe(denial.expectedStatus);
      expect(response.json()).toMatchObject({ error: { code: denial.expectedCode } });
      expectNoProviderCalls();
      await expect(persistenceSnapshot()).resolves.toEqual(before);
    });
  }

  it('returns indistinguishable not-found for an absent organization on list and refresh', async () => {
    const absentOrganizationId = `org_pay_auth_absent_${suffix}`;
    activePrincipal = principal({ organizationIds: [absentOrganizationId] });
    const before = await persistenceSnapshot();

    const [listResponse, refreshResponse] = await Promise.all([
      invokeList(absentOrganizationId),
      invokeRefresh(absentOrganizationId, paymentAccountA),
    ]);

    expect(listResponse.statusCode).toBe(404);
    expect(listResponse.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(refreshResponse.statusCode).toBe(404);
    expect(refreshResponse.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expectNoProviderCalls();
    await expect(persistenceSnapshot()).resolves.toEqual(before);
  });

  const inaccessibleAccountCases = [
    {
      name: 'absent account',
      accountId: `pa_pay_auth_absent_${suffix}`,
      seed: async () => undefined,
    },
    {
      name: 'same-tenant account from another organization',
      accountId: paymentAccountAOther,
      seed: async () =>
        insertPaymentAccount({
          id: paymentAccountAOther,
          tenantId: tenantA,
          organizationId: organizationAOther,
        }),
    },
    {
      name: 'foreign-tenant account',
      accountId: paymentAccountB,
      seed: async () =>
        insertPaymentAccount({
          id: paymentAccountB,
          tenantId: tenantB,
          organizationId: organizationB,
        }),
    },
    {
      name: 'owned non-Stripe account',
      accountId: paymentAccountNonStripe,
      seed: async () =>
        insertPaymentAccount({
          id: paymentAccountNonStripe,
          tenantId: tenantA,
          organizationId: organizationA,
          provider: 'manual',
        }),
    },
  ] as const;

  for (const denial of inaccessibleAccountCases) {
    it(`returns indistinguishable not-found for ${denial.name} before provider effects`, async () => {
      await denial.seed();
      const before = await persistenceSnapshot();

      const response = await invokeRefresh(organizationA, denial.accountId);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expectNoProviderCalls();
      await expect(persistenceSnapshot()).resolves.toEqual(before);
    });
  }

  it('lets a no-op newer refresh durably fence an older delayed provider response', async () => {
    await insertPaymentAccount({
      id: paymentAccountA,
      tenantId: tenantA,
      organizationId: organizationA,
      providerAccountId,
    });
    type ConnectAccount = Awaited<ReturnType<StripeGateway['retrieveConnectAccount']>>;
    let resolveOlderResponse!: (account: ConnectAccount) => void;
    const olderResponse = new Promise<ConnectAccount>((resolve) => {
      resolveOlderResponse = resolve;
    });
    retrieveConnectAccount
      .mockImplementationOnce(() => olderResponse)
      .mockResolvedValueOnce({
        id: providerAccountId,
        defaultCurrency: 'usd',
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        requirements: {},
        disabledReason: null,
      });

    const delayedRequest = invokeRefresh(organizationA, paymentAccountA);
    await vi.waitFor(() => expect(retrieveConnectAccount).toHaveBeenCalledTimes(1));
    const newerResponse = await invokeRefresh(organizationA, paymentAccountA);
    resolveOlderResponse({
      id: providerAccountId,
      defaultCurrency: 'eur',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirements: { currently_due: [] },
      disabledReason: null,
    });
    const staleResponse = await delayedRequest;

    expect(newerResponse.statusCode).toBe(200);
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(createAccountLink).toHaveBeenCalledTimes(1);
    const snapshot = await persistenceSnapshot();
    expect(snapshot.accounts).toEqual([
      expect.objectContaining({
        id: paymentAccountA,
        status: 'pending',
        default_currency: 'usd',
        refresh_generation: 2,
      }),
    ]);
    expect(snapshot.audits).toHaveLength(0);
  });

  it('rolls back provider-derived state when the required refresh audit fails', async () => {
    await insertPaymentAccount({
      id: paymentAccountA,
      tenantId: tenantA,
      organizationId: organizationA,
      providerAccountId,
    });
    const before = await persistenceSnapshot();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected payment-account refresh audit failure'),
    );

    const response = await invokeRefresh(organizationA, paymentAccountA);

    expect(response.statusCode).toBe(500);
    expect(retrieveConnectAccount).toHaveBeenCalledTimes(1);
    expect(retrieveConnectAccount).toHaveBeenCalledWith(providerAccountId);
    expect(createAccountLink).not.toHaveBeenCalled();
    const after = await persistenceSnapshot();
    expect(after.audits).toEqual(before.audits);
    expect(after.accounts).toEqual([
      expect.objectContaining({
        ...before.accounts[0]!,
        refresh_generation: 1,
      }),
    ]);
  });

  it('preserves persistence when Stripe account retrieval fails', async () => {
    await insertPaymentAccount({
      id: paymentAccountA,
      tenantId: tenantA,
      organizationId: organizationA,
      providerAccountId,
    });
    const before = await persistenceSnapshot();
    retrieveConnectAccount.mockRejectedValueOnce(
      new ProviderOperationError(
        'Stripe account retrieval unavailable',
        'stripe',
        'accounts.retrieve',
        'server',
        true,
        'unknown',
        false,
      ),
    );

    const response = await invokeRefresh(organizationA, paymentAccountA);

    expect(response.statusCode).toBe(503);
    expect(createAccountLink).not.toHaveBeenCalled();
    const after = await persistenceSnapshot();
    expect(after.audits).toEqual(before.audits);
    expect(after.accounts).toEqual([
      expect.objectContaining({
        ...before.accounts[0]!,
        refresh_generation: 1,
      }),
    ]);
  });
});
