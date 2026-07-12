import { describe, expect, it, vi } from 'vitest';
import {
  assertMigrationMappingSafe,
  assertPortableMigrationIdempotency,
  assertMigrationConfigurationSecretFree,
  redactMigrationReportValue,
  sanitizeDryRunReport,
  unresolvedMigrationDependencies,
  portableMigrationRequestFingerprint,
} from '../routes/modules/migrations.js';

describe('migration security boundaries', () => {
  it('namespaces portable idempotency and rejects changed or ordinary job identities', () => {
    const configuration = {
      sourceMode: 'official-export',
      sourceSystem: 'tixkit-portable',
      artifactIds: ['upl_portable1'],
    };
    const expected = portableMigrationRequestFingerprint({
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v1',
      mode: 'dry-run',
      configuration,
    });
    expect(() =>
      assertPortableMigrationIdempotency(
        {
          sourceSystem: 'tixkit-portable',
          adapterVersion: 'tixkit-portable-bundle-v1',
          mode: 'dry-run',
          configuration: structuredClone(configuration),
        },
        expected,
      ),
    ).not.toThrow();
    for (const identity of [
      { sourceSystem: 'generic-csv', adapterVersion: 'rfc4180-v1', mode: 'dry-run', configuration },
      {
        sourceSystem: 'tixkit-portable',
        adapterVersion: 'tixkit-portable-bundle-v1',
        mode: 'dry-run',
        configuration: { ...configuration, artifactIds: ['upl_portable2'] },
      },
      {
        sourceSystem: 'tixkit-portable',
        adapterVersion: 'tixkit-portable-bundle-v1',
        mode: 'commit',
        configuration,
      },
    ]) {
      expect(() => assertPortableMigrationIdempotency(identity, expected)).toThrow(
        /different portable import/u,
      );
    }
  });

  it('resolves dependencies by exact current-job or scoped external identity', async () => {
    const entity = {
      entityType: 'ticket-type' as const,
      externalId: 'type-1',
      sourcePosition: 'row:1',
      attributes: {},
      dependencies: [
        { entityType: 'event' as const, externalId: 'event-current' },
        { entityType: 'inventory-pool' as const, externalId: 'pool-mapped' },
        { entityType: 'occurrence' as const, externalId: 'occurrence-missing' },
      ],
    };
    const lookup = vi.fn(
      async (type: string, id: string) => type === 'inventory-pool' && id === 'pool-mapped',
    );
    await expect(
      unresolvedMigrationDependencies(
        entity,
        new Set(['event:event-current', 'event:different-event']),
        lookup,
      ),
    ).resolves.toEqual([{ entityType: 'occurrence', externalId: 'occurrence-missing' }]);
    expect(lookup).toHaveBeenCalledWith('inventory-pool', 'pool-mapped');
    expect(lookup).toHaveBeenCalledWith('occurrence', 'occurrence-missing');
  });
  it.each([
    { apiKey: 'secret' },
    { nested: { access_token: 'secret' } },
    { items: [{ password: 'secret' }] },
    { authorization: 'Bearer secret' },
    { value: 'Bearer source-access-token' },
  ])('rejects nested inline credentials: %j', (configuration) => {
    expect(() => assertMigrationConfigurationSecretFree(configuration)).toThrow('use credentialId');
  });

  it('accepts non-sensitive configuration and credential references outside configuration', () => {
    expect(() =>
      assertMigrationConfigurationSecretFree({ locale: 'en-US', sourceAccount: 'acct_1' }),
    ).not.toThrow();
  });

  it('recursively removes PII and secrets from progress and report payloads', () => {
    expect(
      redactMigrationReportValue({
        email: 'buyer@example.test',
        profile: { phone: '+15555550100', ticketCode: 'TKT-1' },
        accessToken: 'secret',
        issueCode: 'DATE_INVALID',
        message: 'Invalid buyer alice@example.test at +1 (555) 555-0100',
      }),
    ).toEqual({
      email: '[REDACTED]',
      profile: { phone: '[REDACTED]', ticketCode: 'TKT-1' },
      accessToken: '[REDACTED]',
      issueCode: 'DATE_INVALID',
      message: 'Invalid buyer [REDACTED_EMAIL] at [REDACTED_PHONE]',
    });
  });

  it('rejects credential and literal PII material in saved mappings', () => {
    expect(() => assertMigrationMappingSafe({ email: 'buyer_email' })).not.toThrow();
    expect(() => assertMigrationMappingSafe({ accessToken: 'source_token' })).toThrow(
      'credential fields',
    );
    expect(() => assertMigrationMappingSafe({ email: 'buyer@example.test' })).toThrow(
      'literal personal data',
    );
    expect(() => assertMigrationMappingSafe({ phone: '+1 555 555 0100' })).toThrow(
      'literal personal data',
    );
  });

  it('replaces source identifiers with opaque job-row correlations in dry-run reports', () => {
    expect(
      sanitizeDryRunReport(
        {
          issues: [
            {
              code: 'DATE_INVALID',
              severity: 'error',
              entityType: 'attendee',
              externalId: 'buyer@example.test',
              sourcePosition: 'row:7',
              message: 'Invalid buyer@example.test',
            },
          ],
          mappingFailures: ['buyer@example.test'],
          duplicateExternalIds: ['attendee:buyer@example.test'],
          rows: [{ entity: { externalId: 'buyer@example.test' } }],
        },
        new Map([['attendee:buyer@example.test', 'imrow_7f3f0d93']]),
      ),
    ).toEqual({
      issues: [
        {
          code: 'DATE_INVALID',
          severity: 'error',
          entityType: 'attendee',
          message: 'Invalid [REDACTED_EMAIL]',
          correlationId: 'imrow_7f3f0d93',
        },
      ],
      duplicateCount: 1,
      mappingFailureCount: 1,
    });
  });

  it('returns only aggregate counts for identifier-bearing dry-run arrays', () => {
    const report = sanitizeDryRunReport(
      {
        duplicateExternalIds: ['ticket:external-1', 'ticket:external-2'],
        mappingFailures: ['buyer@example.test'],
        rows: [{ externalId: 'external-1' }],
        issues: [],
      },
      new Map(),
    );

    expect(report).not.toHaveProperty('duplicateExternalIds');
    expect(report).not.toHaveProperty('mappingFailures');
    expect(report).not.toHaveProperty('rows');
    expect(report).toMatchObject({ duplicateCount: 2, mappingFailureCount: 1, issues: [] });
    expect(JSON.stringify(report)).not.toContain('external-');
    expect(JSON.stringify(report)).not.toContain('buyer@example.test');
  });
});
