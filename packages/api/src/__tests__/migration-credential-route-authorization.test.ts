import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportRepository } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { migrationAdapterCatalog } from '@tixkit/migration-core';
import { registerErrorHandler } from '../app.js';
import { migrationRoutes } from '../routes/modules/migrations.js';
import {
  MIGRATION_ADAPTER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
} from './integration/route-authorization-contracts.js';

const { writeAuditLog } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async (..._arguments: unknown[]) => undefined),
}));

vi.mock('../auth/audit.js', () => ({ writeAuditLog }));

type StoredCredential = {
  created_at: Date;
  created_by: string;
  expires_at: Date;
  id: string;
  organization_id: string;
  secret_reference: string;
  source_system: string;
  status: 'active' | 'revoked';
  tenant_id: string;
  updated_at: Date;
};

const tenantId = 'tenant_migration_credential_01';
const organizationId = 'org_migration_credential_01';
const credentialId = 'mcred_authorized01';
const createPayload = {
  organizationId,
  sourceSystem: 'legacy-ticketing',
  secretReference: 'vault://team/migrations/source_api',
  expiresAt: '2099-07-16T12:00:00.000Z',
};
const credentials = new Map<string, StoredCredential>();

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'user_migration_credential_admin',
    tenantId,
    organizationIds: [organizationId],
    scopes: ['migrations.write'],
    ...overrides,
  };
}

function credentialKey(input: {
  credentialId: string;
  organizationId: string;
  tenantId: string;
}): string {
  return `${input.tenantId}:${input.organizationId}:${input.credentialId}`;
}

function seedCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  const now = new Date('2026-07-16T12:00:00.000Z');
  const credential: StoredCredential = {
    created_at: now,
    created_by: 'user_seed',
    expires_at: new Date(createPayload.expiresAt),
    id: credentialId,
    organization_id: organizationId,
    secret_reference: createPayload.secretReference,
    source_system: createPayload.sourceSystem,
    status: 'active',
    tenant_id: tenantId,
    updated_at: now,
    ...overrides,
  };
  credentials.set(
    credentialKey({
      credentialId: credential.id,
      organizationId: credential.organization_id,
      tenantId: credential.tenant_id,
    }),
    credential,
  );
  return credential;
}

async function testApp(activePrincipal: Principal) {
  const app = Fastify();
  app.decorate('context', { db: {} } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(migrationRoutes);
  return app;
}

function snapshotCredentials(): string {
  return JSON.stringify(
    [...credentials.entries()].map(([key, credential]) => [
      key,
      {
        ...credential,
        created_at: credential.created_at.toISOString(),
        expires_at: credential.expires_at.toISOString(),
        updated_at: credential.updated_at.toISOString(),
      },
    ]),
  );
}

describe('migration credential route authorization contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    credentials.clear();
    writeAuditLog.mockClear();
    vi.spyOn(ImportRepository.prototype, 'createCredential').mockImplementation(async (input) => {
      const now = new Date('2026-07-16T12:00:00.000Z');
      const credential: StoredCredential = {
        created_at: now,
        created_by: input.createdBy,
        expires_at: input.expiresAt,
        id: credentialId,
        organization_id: input.organizationId,
        secret_reference: input.secretReference,
        source_system: input.sourceSystem,
        status: 'active',
        tenant_id: input.tenantId,
        updated_at: now,
      };
      credentials.set(
        credentialKey({
          credentialId: credential.id,
          organizationId: credential.organization_id,
          tenantId: credential.tenant_id,
        }),
        credential,
      );
      return credential as never;
    });
    vi.spyOn(ImportRepository.prototype, 'revokeCredential').mockImplementation(async (input) => {
      const key = credentialKey(input);
      const credential = credentials.get(key);
      if (!credential || credential.status !== 'active') return false;
      credentials.set(key, { ...credential, status: 'revoked', updated_at: new Date() });
      return true;
    });
  });

  it('is the exact executable source for the immutable C-123 contracts', () => {
    expect(MIGRATION_ADAPTER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toEqual([
      expect.objectContaining({
        authorizedControl: { required: true, status: 200 },
        deniedBoundaries: [],
        method: 'GET',
        operationId: 'listMigrationAdapters',
        path: '/migration-adapters',
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
        policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
        policyDeniedBoundaries: ['brand', 'event'],
        sideEffectAssertions: [],
        source: 'migration-credential-route-authorization.test.ts',
      }),
    ]);
    expect(MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toEqual([
      expect.objectContaining({
        authorizedControl: { required: true, status: 201 },
        method: 'POST',
        operationId: 'createMigrationCredential',
        path: '/migration-credentials',
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        persistenceSource: 'import-platform.integration.test.ts',
        deniedBoundaries: ['organization'],
        sideEffectAssertions: ['persistence'],
        source: 'migration-credential-route-authorization.test.ts',
      }),
      expect.objectContaining({
        authorizedControl: { required: true, status: 204 },
        method: 'DELETE',
        operationId: 'revokeMigrationCredential',
        path: '/migration-credentials/{credentialId}',
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        persistenceSource: 'import-platform.integration.test.ts',
        deniedBoundaries: ['tenant', 'organization'],
        sideEffectAssertions: ['persistence'],
        source: 'migration-credential-route-authorization.test.ts',
      }),
    ]);
  });

  it('returns the exact public adapter catalog to a migrations.read principal', async () => {
    const app = await testApp(principal({ scopes: ['migrations.read'] }));

    const response = await app.inject({ method: 'GET', url: '/migration-adapters' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ items: migrationAdapterCatalog() });
    expect(ImportRepository.prototype.createCredential).not.toHaveBeenCalled();
    expect(ImportRepository.prototype.revokeCredential).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('denies adapter catalog access without migrations.read before any side effect', async () => {
    const contract = MIGRATION_ADAPTER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const app = await testApp(principal({ scopes: ['migrations.write'] }));

    const response = await app.inject({ method: 'GET', url: contract.path });

    expect(response.statusCode).toBe(contract.permissionDenialResponse?.status);
    expect(response.json().error.code).toBe(contract.permissionDenialResponse?.code);
    expect(response.body).not.toContain('generic-csv');
    expect(ImportRepository.prototype.createCredential).not.toHaveBeenCalled();
    expect(ImportRepository.prototype.revokeCredential).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['brand', 'brandIds'],
    ['event', 'eventIds'],
  ] as const)(
    'denies %s-scoped adapter catalog access before any side effect',
    async (_boundary, scopeKey) => {
      const contract = MIGRATION_ADAPTER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
      const scope: Partial<Principal> =
        scopeKey === 'brandIds'
          ? { brandIds: ['brand_migration_scoped_01'] }
          : { eventIds: ['event_migration_scoped_01'] };
      const app = await testApp(principal({ scopes: ['migrations.read'], ...scope }));

      const response = await app.inject({ method: 'GET', url: contract.path });

      expect(response.statusCode).toBe(contract.policyDenialResponse?.status);
      expect(response.json().error.code).toBe(contract.policyDenialResponse?.code);
      expect(response.body).not.toContain('generic-csv');
      expect(ImportRepository.prototype.createCredential).not.toHaveBeenCalled();
      expect(ImportRepository.prototype.revokeCredential).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'returns the declared 403 permission denial before persistence or audit for $method $path',
    async (contract) => {
      if (contract.method === 'DELETE') seedCredential();
      const before = snapshotCredentials();
      const app = await testApp(principal({ scopes: ['migrations.read'] }));
      const response = await app.inject(
        contract.method === 'POST'
          ? { method: 'POST', url: contract.path, payload: createPayload }
          : {
              method: 'DELETE',
              url: `/migration-credentials/${credentialId}?organizationId=${organizationId}`,
            },
      );

      expect(response.statusCode).toBe(contract.permissionDenialResponse?.status);
      expect(response.json().error.code).toBe(contract.permissionDenialResponse?.code);
      expect(snapshotCredentials()).toBe(before);
      expect(ImportRepository.prototype.createCredential).not.toHaveBeenCalled();
      expect(ImportRepository.prototype.revokeCredential).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('returns indistinguishable 404 for an out-of-scope create organization without mutation', async () => {
    const app = await testApp(principal({ organizationIds: ['org_unrelated_01'] }));
    const response = await app.inject({
      method: 'POST',
      url: '/migration-credentials',
      payload: createPayload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(credentials.size).toBe(0);
    expect(ImportRepository.prototype.createCredential).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    {
      name: 'alien tenant',
      activePrincipal: principal({ tenantId: 'tenant_alien_01' }),
      requestedOrganizationId: organizationId,
    },
    {
      name: 'alien organization',
      activePrincipal: principal({ organizationIds: ['org_alien_01'] }),
      requestedOrganizationId: 'org_alien_01',
    },
  ])('returns indistinguishable 404 for an $name credential without mutation', async (scenario) => {
    seedCredential();
    const before = snapshotCredentials();
    const app = await testApp(scenario.activePrincipal);
    const response = await app.inject({
      method: 'DELETE',
      url: `/migration-credentials/${credentialId}?organizationId=${scenario.requestedOrganizationId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(snapshotCredentials()).toBe(before);
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates an authorized credential with a redacted 201 response and audit evidence', async () => {
    const app = await testApp(principal());
    const response = await app.inject({
      method: 'POST',
      url: '/migration-credentials',
      payload: createPayload,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      id: credentialId,
      organizationId,
      sourceSystem: createPayload.sourceSystem,
      status: 'active',
      expiresAt: createPayload.expiresAt,
    });
    expect(response.body).not.toContain('secretReference');
    expect(response.body).not.toContain('secret_reference');
    expect(response.body).not.toContain(createPayload.secretReference);
    expect(credentials.size).toBe(1);
    expect(ImportRepository.prototype.createCredential).toHaveBeenCalledWith({
      tenantId,
      organizationId,
      sourceSystem: createPayload.sourceSystem,
      secretReference: createPayload.secretReference,
      expiresAt: new Date(createPayload.expiresAt),
      createdBy: 'user_migration_credential_admin',
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        action: 'migration_credential.created',
        organizationId,
        resourceType: 'MigrationCredential',
        resourceId: credentialId,
        diffSummary: {
          sourceSystem: createPayload.sourceSystem,
          expiresAt: createPayload.expiresAt,
        },
      },
    );
    expect(JSON.stringify(writeAuditLog.mock.calls[0]?.[3])).not.toContain(
      createPayload.secretReference,
    );
    await app.close();
  });

  it('revokes an authorized credential with 204 and audit evidence', async () => {
    seedCredential();
    const app = await testApp(principal());
    const response = await app.inject({
      method: 'DELETE',
      url: `/migration-credentials/${credentialId}?organizationId=${organizationId}`,
    });

    expect(response.statusCode, response.body).toBe(204);
    expect(response.body).toBe('');
    expect([...credentials.values()][0]?.status).toBe('revoked');
    expect(ImportRepository.prototype.revokeCredential).toHaveBeenCalledWith({
      tenantId,
      organizationId,
      credentialId,
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        action: 'migration_credential.revoked',
        organizationId,
        resourceType: 'MigrationCredential',
        resourceId: credentialId,
      },
    );
    expect(JSON.stringify(writeAuditLog.mock.calls[0]?.[3])).not.toContain(
      createPayload.secretReference,
    );
    await app.close();
  });
});
