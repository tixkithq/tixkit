import { describe, expect, it } from 'vitest';
import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  migrationIdempotencyKey,
  sortEntitiesByDependency,
} from '../../../index.js';
import { SANITIZED_PRETIX_OFFICIAL_API_FIXTURE } from '../fixtures.js';
import { PRETIX_KNOWN_LOSSES, pretixMigrationAdapter } from '../index.js';

const context = { tenantId: 'tenant-test', organizationId: 'organization-test' };

describe('pretix migration adapter', () => {
  it('discovers and cursor-paginates the sanitized official API corpus', async () => {
    const discovery = await pretixMigrationAdapter.discover(
      SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      context,
    );
    expect(discovery.entities.map(({ type }) => type)).toEqual(MIGRATION_ENTITY_DEPENDENCY_ORDER);
    expect(discovery.unsupportedFeatures).toEqual(expect.arrayContaining([...PRETIX_KNOWN_LOSSES]));
    const first = await pretixMigrationAdapter.extract({
      configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      discovery,
      limit: 20,
      context,
    });
    const second = await pretixMigrationAdapter.extract({
      configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      discovery,
      cursor: first.nextCursor,
      limit: 20,
      context,
    });
    expect(first.nextCursor).toBe('page-2');
    expect([...first.rows, ...second.rows]).toHaveLength(18);
    const partial = await pretixMigrationAdapter.extract({
      configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      discovery,
      limit: 4,
      context,
    });
    expect(partial).toMatchObject({ nextCursor: 'page-1#offset=4' });
    expect(partial.rows).toHaveLength(4);
  });

  it('normalizes in dependency order with stable re-import keys', async () => {
    const discovery = await pretixMigrationAdapter.discover(
      SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      context,
    );
    const pages = await Promise.all(
      SANITIZED_PRETIX_OFFICIAL_API_FIXTURE.pages.map(({ cursor }) =>
        pretixMigrationAdapter.extract({
          configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
          discovery,
          cursor,
          limit: 20,
          context,
        }),
      ),
    );
    const rows = pages.flatMap(({ rows: pageRows }) => pageRows);
    const normalized = await Promise.all(
      rows.map((row) => pretixMigrationAdapter.normalize(row, context)),
    );
    expect(sortEntitiesByDependency(normalized).map(({ entityType }) => entityType)).toEqual(
      MIGRATION_ENTITY_DEPENDENCY_ORDER,
    );
    expect(
      new Set(
        normalized.map((entity) =>
          migrationIdempotencyKey({
            tenantId: context.tenantId,
            sourceSystem: pretixMigrationAdapter.id,
            entityType: entity.entityType,
            externalId: entity.externalId,
          }),
        ),
      ).size,
    ).toBe(18);
    expect(
      await Promise.all(
        normalized.map((entity) => pretixMigrationAdapter.validate(entity, context)),
      ),
    ).toEqual(normalized.map(() => []));
  });

  it('imports payment, refund, and check-in history without payment side effects', async () => {
    const discovery = await pretixMigrationAdapter.discover(
      SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      context,
    );
    const extracted = await pretixMigrationAdapter.extract({
      configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      discovery,
      cursor: 'page-2',
      limit: 20,
      context,
    });
    const normalized = await Promise.all(
      extracted.rows.map((row) => pretixMigrationAdapter.normalize(row, context)),
    );
    const financial = normalized
      .filter(({ financialSnapshot }) => financialSnapshot)
      .map(({ financialSnapshot }) => financialSnapshot);
    expect(financial).toHaveLength(2);
    expect(
      financial.every(
        (snapshot) =>
          snapshot?.sideEffects === 'suppressed' &&
          snapshot.reconciliationStatus === 'unreconciled',
      ),
    ).toBe(true);
    expect(
      normalized.find(({ entityType }) => entityType === 'check-in')?.attributes.occurredAt,
    ).toBe('2026-01-04T10:00:00.000Z');
  });

  it('fails closed for malformed or incomplete cursor and resource graphs', async () => {
    const unknown = structuredClone(SANITIZED_PRETIX_OFFICIAL_API_FIXTURE);
    unknown.pages[0]!.nextCursor = 'missing';
    await expect(pretixMigrationAdapter.discover(unknown, context)).rejects.toThrow(/unknown/u);

    const cycle = structuredClone(SANITIZED_PRETIX_OFFICIAL_API_FIXTURE);
    cycle.pages[1]!.nextCursor = cycle.pages[0]!.cursor;
    await expect(pretixMigrationAdapter.discover(cycle, context)).rejects.toThrow(/cycle/u);

    const unreachable = structuredClone(SANITIZED_PRETIX_OFFICIAL_API_FIXTURE);
    delete unreachable.pages[0]!.nextCursor;
    await expect(pretixMigrationAdapter.discover(unreachable, context)).rejects.toThrow(
      /unreachable/u,
    );

    const prematureEmpty = structuredClone(SANITIZED_PRETIX_OFFICIAL_API_FIXTURE);
    prematureEmpty.pages[0]!.records = [];
    await expect(pretixMigrationAdapter.discover(prematureEmpty, context)).rejects.toThrow(
      /empty/u,
    );

    const badResource = structuredClone(SANITIZED_PRETIX_OFFICIAL_API_FIXTURE);
    badResource.pages[0]!.records[0]!.resource = 'unknown' as never;
    await expect(pretixMigrationAdapter.discover(badResource, context)).rejects.toThrow(
      /unsupported/u,
    );
  });
});
