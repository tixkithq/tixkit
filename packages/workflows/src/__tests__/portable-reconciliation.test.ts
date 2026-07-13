import { describe, expect, it, vi } from 'vitest';
import type { Database, ImportRepository } from '@tixkit/db';
import type { NormalizedMigrationEntity } from '@tixkit/migration-core';
import {
  portableReconciliationReport,
  type MigrationCommitterRegistry,
} from '../activities/migration-repository-service.js';

function organization(externalId: string): NormalizedMigrationEntity {
  return {
    entityType: 'organization',
    externalId,
    sourcePosition: `organizations.jsonl:${externalId}`,
    attributes: { name: externalId },
  };
}

function row(
  id: string,
  externalId: string,
  tixkitId: string,
  status: 'created' | 'updated' | 'skipped',
) {
  return {
    id,
    tenant_id: 'tenant_01',
    organization_id: 'organization_01',
    import_job_id: 'job_01',
    import_job_file_id: null,
    entity_type: 'organization',
    external_id: externalId,
    row_number: Number(id.slice(-1)),
    source_data: '{}',
    normalized_data: JSON.stringify(organization(externalId)),
    status,
    severity: null,
    tixkit_id: tixkitId,
    created_entity: status === 'created',
    claim_owner: null,
    claim_attempt: 0,
    claim_expires_at: null,
    domain_activity_at: null,
    rollback_blocked_at: null,
    rollback_blocked_reason: null,
    created_at: new Date('2026-07-12T00:00:00Z'),
    updated_at: new Date('2026-07-12T00:00:00Z'),
  };
}

function repository(expectedCount: number): ImportRepository {
  return {
    findPortablePreflight: vi.fn(async () => ({
      expected_counts: JSON.stringify({ organizations: expectedCount }),
      expected_assets: '[]',
      manifest_json: JSON.stringify({ lineage: { kind: 'full' } }),
      required_rebindings: '[]',
    })),
    listPortableImportRebindings: vi.fn(async () => []),
  } as unknown as ImportRepository;
}

function committers(): MigrationCommitterRegistry {
  return new Map([
    [
      'organization',
      {
        assessReconciled: vi.fn(async () => ({ reconciled: true })),
        assessUntouched: vi.fn(async () => ({ eligible: true })),
        commit: vi.fn(),
        deleteUntouched: vi.fn(async () => true),
      },
    ],
  ]) as MigrationCommitterRegistry;
}

describe('portable post-import reconciliation', () => {
  it('accepts exact created, updated, and skipped row identities', async () => {
    const rows = [
      row('row_1', 'source_1', 'destination_1', 'created'),
      row('row_2', 'source_2', 'destination_2', 'updated'),
      row('row_3', 'source_3', 'destination_3', 'skipped'),
    ];
    const report = await portableReconciliationReport({
      db: {} as Database,
      repository: repository(3),
      context: {
        tenantId: 'tenant_01',
        organizationId: 'organization_01',
        jobId: 'job_01',
      },
      rows,
      unresolvedRows: [],
      committers: committers(),
    });
    expect(report.ready).toBe(true);
  });

  it('rejects two source rows aliased to one canonical entity', async () => {
    const rows = [
      row('row_1', 'source_1', 'destination_shared', 'created'),
      row('row_2', 'source_2', 'destination_shared', 'skipped'),
    ];
    const report = await portableReconciliationReport({
      db: {} as Database,
      repository: repository(2),
      context: {
        tenantId: 'tenant_01',
        organizationId: 'organization_01',
        jobId: 'job_01',
      },
      rows,
      unresolvedRows: [],
      committers: committers(),
    });
    expect(report.ready).toBe(false);
    expect(report.countMismatches).toEqual([{ section: 'organizations', expected: 2, actual: 1 }]);
    expect(report.unresolvedDependencies).toEqual([
      {
        portableId: 'source_2',
        reason: 'Multiple source rows map to organizations:destination_shared',
      },
    ]);
  });
});
