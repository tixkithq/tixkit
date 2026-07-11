import { describe, expect, it } from 'vitest';
import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  migrationIdempotencyKey,
  sortEntitiesByDependency,
} from '../../../index.js';
import { SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE } from '../fixtures.js';
import { HI_EVENTS_KNOWN_LOSSES, hiEventsMigrationAdapter } from '../index.js';

const context = { tenantId: 'tenant-test', organizationId: 'organization-test' };

describe('Hi.Events migration adapter', () => {
  it('discovers and cursor-paginates the sanitized official API corpus', async () => {
    const discovery = await hiEventsMigrationAdapter.discover(
      SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      context,
    );
    expect(discovery.entities.map(({ type }) => type)).toEqual(MIGRATION_ENTITY_DEPENDENCY_ORDER);
    expect(discovery.unsupportedFeatures).toEqual(
      expect.arrayContaining([...HI_EVENTS_KNOWN_LOSSES]),
    );
    const first = await hiEventsMigrationAdapter.extract({
      configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      discovery,
      limit: 20,
      context,
    });
    const second = await hiEventsMigrationAdapter.extract({
      configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      discovery,
      cursor: first.nextCursor,
      limit: 20,
      context,
    });
    expect(first.nextCursor).toBe('cursor-2');
    expect([...first.rows, ...second.rows]).toHaveLength(18);
    const partial = await hiEventsMigrationAdapter.extract({
      configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      discovery,
      limit: 4,
      context,
    });
    expect(partial).toMatchObject({ nextCursor: 'cursor-1#offset=4' });
    expect(partial.rows).toHaveLength(4);
  });

  it('normalizes every dependency type with stable re-import keys and clean validation', async () => {
    const discovery = await hiEventsMigrationAdapter.discover(
      SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      context,
    );
    const pages = await Promise.all(
      SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE.pages.map(({ cursor }) =>
        hiEventsMigrationAdapter.extract({
          configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
          discovery,
          cursor,
          limit: 20,
          context,
        }),
      ),
    );
    const normalized = await Promise.all(
      pages
        .flatMap(({ rows }) => rows)
        .map((row) => hiEventsMigrationAdapter.normalize(row, context)),
    );
    expect(sortEntitiesByDependency(normalized).map(({ entityType }) => entityType)).toEqual(
      MIGRATION_ENTITY_DEPENDENCY_ORDER,
    );
    expect(
      new Set(
        normalized.map((entity) =>
          migrationIdempotencyKey({
            tenantId: context.tenantId,
            sourceSystem: hiEventsMigrationAdapter.id,
            entityType: entity.entityType,
            externalId: entity.externalId,
          }),
        ),
      ).size,
    ).toBe(18);
    expect(
      await Promise.all(
        normalized.map((entity) => hiEventsMigrationAdapter.validate(entity, context)),
      ),
    ).toEqual(normalized.map(() => []));
  });

  it('retains historical financial and check-in semantics without side effects', async () => {
    const discovery = await hiEventsMigrationAdapter.discover(
      SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      context,
    );
    const extracted = await hiEventsMigrationAdapter.extract({
      configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      discovery,
      cursor: 'cursor-2',
      limit: 20,
      context,
    });
    const normalized = await Promise.all(
      extracted.rows.map((row) => hiEventsMigrationAdapter.normalize(row, context)),
    );
    const snapshots = normalized.flatMap(({ financialSnapshot }) =>
      financialSnapshot ? [financialSnapshot] : [],
    );
    expect(snapshots.map(({ kind }) => kind)).toEqual(['historical-payment', 'historical-refund']);
    expect(
      snapshots.every(
        ({ sideEffects, reconciliationStatus }) =>
          sideEffects === 'suppressed' && reconciliationStatus === 'unreconciled',
      ),
    ).toBe(true);
    expect(
      normalized.find(({ entityType }) => entityType === 'check-in')?.attributes.occurredAt,
    ).toBe('2026-02-12T18:00:00.000Z');
  });

  it('fails closed for malformed or incomplete cursor and collection graphs', async () => {
    const unknown = structuredClone(SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE);
    unknown.pages[0]!.nextCursor = 'missing';
    await expect(hiEventsMigrationAdapter.discover(unknown, context)).rejects.toThrow(/unknown/u);

    const cycle = structuredClone(SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE);
    cycle.pages[1]!.nextCursor = cycle.pages[0]!.cursor;
    await expect(hiEventsMigrationAdapter.discover(cycle, context)).rejects.toThrow(/cycle/u);

    const unreachable = structuredClone(SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE);
    delete unreachable.pages[0]!.nextCursor;
    await expect(hiEventsMigrationAdapter.discover(unreachable, context)).rejects.toThrow(
      /unreachable/u,
    );

    const prematureEmpty = structuredClone(SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE);
    prematureEmpty.pages[0]!.records = [];
    await expect(hiEventsMigrationAdapter.discover(prematureEmpty, context)).rejects.toThrow(
      /empty/u,
    );

    const badCollection = structuredClone(SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE);
    badCollection.pages[0]!.records[0]!.collection = 'unknown' as never;
    await expect(hiEventsMigrationAdapter.discover(badCollection, context)).rejects.toThrow(
      /unsupported/u,
    );
  });
});
