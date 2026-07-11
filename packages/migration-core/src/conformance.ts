import {
  assessRollback,
  buildDryRunReport,
  migrationIdempotencyKey,
  sortEntitiesByDependency,
  type AdapterContext,
  type DryRunReport,
  type ImportedEntityActivity,
  type MigrationAdapter,
  type MigrationDisposition,
  type MigrationIssue,
  type NormalizedMigrationEntity,
  type RollbackAssessment,
} from './index.js';

type StoredExternalReference = {
  tixkitId: string;
  fingerprint: string;
  financial: boolean;
};

export type SimulatedCommitResult = {
  dispositions: readonly MigrationDisposition[];
  createdEntityIds: readonly string[];
};

function canonicalValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    // oxlint-disable-next-line unicorn/no-array-sort -- entries is a new local array.
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
    .join(',')}}`;
}

export function canonicalMigrationContentFingerprint(input: {
  attributes: Readonly<Record<string, unknown>>;
  financialSnapshot?: NormalizedMigrationEntity['financialSnapshot'];
}): string {
  const financialSnapshot = input.financialSnapshot
    ? {
        ...input.financialSnapshot,
        provenance: {
          sourceSystem: input.financialSnapshot.provenance.sourceSystem,
          sourceExternalId: input.financialSnapshot.provenance.sourceExternalId,
        },
      }
    : undefined;
  return canonicalValue({ attributes: input.attributes, financialSnapshot });
}

function entityFingerprint(entity: NormalizedMigrationEntity): string {
  return canonicalMigrationContentFingerprint(entity);
}

/**
 * Deterministic, side-effect-free model of the external-reference invariant used by
 * importer acceptance tests. It deliberately refuses changed financial history.
 */
export class InMemoryExternalReferenceStore {
  readonly #references = new Map<string, StoredExternalReference>();

  get size(): number {
    return this.#references.size;
  }

  disposition(input: {
    tenantId: string;
    sourceSystem: string;
    entity: NormalizedMigrationEntity;
  }): MigrationDisposition {
    const key = migrationIdempotencyKey({
      tenantId: input.tenantId,
      sourceSystem: input.sourceSystem,
      entityType: input.entity.entityType,
      externalId: input.entity.externalId,
    });
    const existing = this.#references.get(key);
    if (!existing) return 'create';
    if (existing.fingerprint === entityFingerprint(input.entity)) return 'skip';
    return existing.financial || input.entity.financialSnapshot ? 'conflict' : 'update';
  }

  commit(input: {
    tenantId: string;
    sourceSystem: string;
    entities: readonly NormalizedMigrationEntity[];
  }): SimulatedCommitResult {
    const dispositions: MigrationDisposition[] = [];
    const createdEntityIds: string[] = [];
    for (const entity of sortEntitiesByDependency(input.entities)) {
      const key = migrationIdempotencyKey({
        tenantId: input.tenantId,
        sourceSystem: input.sourceSystem,
        entityType: entity.entityType,
        externalId: entity.externalId,
      });
      const disposition = this.disposition({ ...input, entity });
      dispositions.push(disposition);
      if (disposition === 'skip' || disposition === 'conflict') continue;
      const existing = this.#references.get(key);
      const tixkitId = existing?.tixkitId ?? `simulated-${this.#references.size + 1}`;
      this.#references.set(key, {
        tixkitId,
        fingerprint: entityFingerprint(entity),
        financial: Boolean(entity.financialSnapshot),
      });
      if (!existing) createdEntityIds.push(tixkitId);
    }
    return { dispositions, createdEntityIds };
  }
}

export type MigrationAdapterConformanceResult = {
  discoverySourceSystem: string;
  extractedRows: number;
  pageCount: number;
  normalizedEntities: readonly NormalizedMigrationEntity[];
  validationIssues: readonly MigrationIssue[];
  dryRun: DryRunReport;
  firstCommit: SimulatedCommitResult;
  unchangedReimport: SimulatedCommitResult;
  changedFinancialDisposition: MigrationDisposition;
  untouchedRollback: RollbackAssessment;
  activeRollback: RollbackAssessment;
};

export async function runMigrationAdapterConformance<Configuration>(input: {
  adapter: MigrationAdapter<Configuration, string>;
  configuration: Configuration;
  tenantId: string;
  organizationId: string;
  pageSize?: number;
}): Promise<MigrationAdapterConformanceResult> {
  const context: AdapterContext = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
  };
  const discovery = await input.adapter.discover(input.configuration, context);
  const extracted = [];
  const observedCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    // Cursor pages are causally ordered: each response supplies the next opaque cursor.
    // eslint-disable-next-line no-await-in-loop
    const page = await input.adapter.extract({
      configuration: input.configuration,
      discovery,
      cursor,
      limit: input.pageSize ?? 2,
      context,
    });
    extracted.push(...page.rows);
    pageCount += 1;
    cursor = page.nextCursor;
    if (cursor && observedCursors.has(cursor))
      throw new Error(`${input.adapter.id} extraction returned a cursor cycle at ${cursor}`);
    if (cursor) observedCursors.add(cursor);
  } while (cursor);

  const normalized = await Promise.all(
    extracted.map((row) => input.adapter.normalize(row, context)),
  );
  const validationByEntity = await Promise.all(
    normalized.map((entity) => input.adapter.validate(entity, context)),
  );
  const validationIssues = validationByEntity.flat();
  const store = new InMemoryExternalReferenceStore();
  const dryRun = buildDryRunReport({
    rows: normalized.map((entity, index) => ({
      entity,
      disposition: store.disposition({
        tenantId: input.tenantId,
        sourceSystem: input.adapter.id,
        entity,
      }),
      issues: validationByEntity[index] ?? [],
    })),
    unsupportedFeatures: discovery.unsupportedFeatures,
  });
  if (store.size !== 0) throw new Error('dry-run mutated the external-reference store');

  const deterministic = sortEntitiesByDependency(normalized);
  // oxlint-disable-next-line unicorn/no-array-reverse -- the spread creates a local copy.
  const reverseDeterministic = sortEntitiesByDependency([...normalized].reverse());
  if (canonicalValue(deterministic) !== canonicalValue(reverseDeterministic))
    throw new Error(`${input.adapter.id} normalization is not deterministically ordered`);

  const firstCommit = store.commit({
    tenantId: input.tenantId,
    sourceSystem: input.adapter.id,
    entities: normalized,
  });
  const unchangedReimport = store.commit({
    tenantId: input.tenantId,
    sourceSystem: input.adapter.id,
    entities: normalized,
  });

  const financial = normalized.find(({ financialSnapshot }) => financialSnapshot);
  const financialBase: NormalizedMigrationEntity = financial ?? {
    externalId: 'conformance-financial-snapshot',
    entityType: 'historical-payment',
    sourcePosition: 'conformance:financial',
    attributes: { status: 'historical' },
    financialSnapshot: {
      kind: 'historical-payment',
      amountMinor: 100,
      currency: 'USD',
      occurredAt: '2026-01-01T00:00:00.000Z',
      provenance: {
        sourceSystem: input.adapter.id,
        sourceExternalId: 'conformance-financial-snapshot',
        importedAt: '2026-07-01T00:00:00.000Z',
      },
      reconciliationStatus: 'unreconciled',
      sideEffects: 'suppressed',
    },
  };
  if (!financial)
    store.commit({
      tenantId: input.tenantId,
      sourceSystem: input.adapter.id,
      entities: [financialBase],
    });
  const changedFinancial = {
    ...financialBase,
    financialSnapshot: {
      ...financialBase.financialSnapshot!,
      amountMinor: financialBase.financialSnapshot!.amountMinor + 1,
    },
  };
  const changedFinancialDisposition = store.disposition({
    tenantId: input.tenantId,
    sourceSystem: input.adapter.id,
    entity: changedFinancial,
  });

  const zeroActivity: ImportedEntityActivity = {
    newSales: 0,
    scans: 0,
    transfers: 0,
    edits: 0,
    providerEvents: 0,
    downstreamReferences: 0,
  };
  const createdEntities = firstCommit.createdEntityIds.map((id) => ({
    id,
    activity: zeroActivity,
  }));
  const activeEntities = [...createdEntities];
  if (activeEntities[0])
    activeEntities[0] = {
      id: activeEntities[0].id,
      activity: { ...zeroActivity, scans: 1 },
    };
  return {
    discoverySourceSystem: discovery.source.sourceSystem,
    extractedRows: extracted.length,
    pageCount,
    normalizedEntities: deterministic,
    validationIssues,
    dryRun,
    firstCommit,
    unchangedReimport,
    changedFinancialDisposition,
    untouchedRollback: assessRollback({ committed: true, activated: false, createdEntities }),
    activeRollback: assessRollback({
      committed: true,
      activated: false,
      createdEntities: activeEntities,
    }),
  };
}
