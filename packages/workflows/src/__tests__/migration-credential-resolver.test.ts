import { afterEach, describe, expect, it } from 'vitest';
import { BindingRegistryMigrationCredentialResolver } from '../activities/migration-credential-resolver.js';

const reference = {
  id: 'mcred_1',
  tenantId: 'tenant_1',
  organizationId: 'org_1',
  sourceSystem: 'pretix',
  secretReference: 'vault://migrations/pretix/production',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

afterEach(() => {
  delete process.env.TIXKIT_TEST_PRETIX_SECRET;
  delete process.env.TIXKIT_MIGRATION_CREDENTIAL_BINDINGS;
});

function bind(
  overrides: Partial<{
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
  }> = {},
) {
  process.env.TIXKIT_MIGRATION_CREDENTIAL_BINDINGS = JSON.stringify({
    [reference.secretReference]: {
      tenantId: overrides.tenantId ?? reference.tenantId,
      organizationId: overrides.organizationId ?? reference.organizationId,
      sourceSystem: overrides.sourceSystem ?? reference.sourceSystem,
      envName: 'TIXKIT_TEST_PRETIX_SECRET',
    },
  });
}

describe('migration credential resolver', () => {
  it('resolves an exact public reference binding without changing its expiry', async () => {
    bind();
    process.env.TIXKIT_TEST_PRETIX_SECRET = 'in-memory-only';
    await expect(
      new BindingRegistryMigrationCredentialResolver().resolve(reference, {}),
    ).resolves.toEqual({
      material: 'in-memory-only',
      expiresAt: reference.expiresAt,
    });
  });

  it('rejects source mismatches, env references, and missing material', async () => {
    bind({ sourceSystem: 'eventbrite' });
    process.env.TIXKIT_TEST_PRETIX_SECRET = 'must-not-resolve';
    const resolver = new BindingRegistryMigrationCredentialResolver();
    await expect(resolver.resolve(reference, {})).rejects.toThrow('scope mismatch');
    bind({ tenantId: 'tenant_2' });
    await expect(resolver.resolve(reference, {})).rejects.toThrow('scope mismatch');
    bind({ organizationId: 'org_2' });
    await expect(resolver.resolve(reference, {})).rejects.toThrow('scope mismatch');
    await expect(
      resolver.resolve({ ...reference, secretReference: 'env://pretix/SECRET' }, {}),
    ).rejects.toThrow('reference invalid');
    bind();
    delete process.env.TIXKIT_TEST_PRETIX_SECRET;
    await expect(resolver.resolve(reference, {})).rejects.toThrow('secret unavailable');
  });

  it.each([
    'not json',
    '[]',
    JSON.stringify({
      [reference.secretReference]: {
        tenantId: reference.tenantId,
        organizationId: reference.organizationId,
        sourceSystem: 'pretix',
        envName: 'lowercase',
        extra: true,
      },
    }),
  ])('rejects malformed binding registries', async (registry) => {
    process.env.TIXKIT_MIGRATION_CREDENTIAL_BINDINGS = registry;
    await expect(
      new BindingRegistryMigrationCredentialResolver().resolve(reference, {}),
    ).rejects.toThrow('registry invalid');
  });
});
