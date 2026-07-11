import {
  assertHistoricalFinancialEntity,
  migrationIdempotencyKey,
  type AdapterContext,
  type MigrationAdapter,
  type MigrationDiscovery,
  type MigrationEntityType,
  type MigrationIssue,
  type NormalizedMigrationEntity,
} from '../../index.js';

export type BespokeAdapterMetadata = {
  displayName: string;
  officialSource: string;
  supportedVersions: readonly string[];
  featureMap: Readonly<Record<string, MigrationEntityType | 'unsupported'>>;
  knownLosses: readonly string[];
  rateLimit: {
    strategy: string;
    maximumPageSize: number;
  };
};

export type BespokeAdapterDefinition<Configuration, Cursor> = {
  metadata: BespokeAdapterMetadata;
  adapter: MigrationAdapter<Configuration, Cursor>;
};

export function defineBespokeAdapter<Configuration, Cursor>(
  definition: BespokeAdapterDefinition<Configuration, Cursor>,
): BespokeAdapterDefinition<Configuration, Cursor> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(definition.adapter.id))
    throw new TypeError('adapter id must be a lowercase kebab-case stable identifier');
  if (!definition.metadata.displayName.trim() || !definition.metadata.officialSource.trim())
    throw new TypeError('displayName and officialSource are required');
  if (
    definition.metadata.supportedVersions.length === 0 ||
    definition.adapter.supportedVersions.length === 0
  )
    throw new TypeError('at least one supported source version is required');
  if (
    !definition.metadata.supportedVersions.every((version) =>
      definition.adapter.supportedVersions.includes(version),
    )
  )
    throw new TypeError('metadata supported versions must be declared by the adapter');
  if (
    !Number.isSafeInteger(definition.metadata.rateLimit.maximumPageSize) ||
    definition.metadata.rateLimit.maximumPageSize < 1
  )
    throw new RangeError('maximumPageSize must be a positive safe integer');
  if (!definition.metadata.rateLimit.strategy.trim())
    throw new TypeError('rate-limit strategy is required');
  return Object.freeze({
    metadata: Object.freeze(definition.metadata),
    adapter: definition.adapter,
  });
}

export type BespokeConformanceCase<Configuration, Cursor> = {
  definition: BespokeAdapterDefinition<Configuration, Cursor>;
  configuration: Configuration;
  context: AdapterContext;
  cursor?: Cursor;
  limit?: number;
};

export type BespokeConformanceResult = {
  discovery: MigrationDiscovery;
  entities: readonly NormalizedMigrationEntity[];
  issues: readonly MigrationIssue[];
  idempotencyKeys: readonly string[];
};

/**
 * Executes the deterministic, offline portion of adapter certification. Callers must
 * additionally test source-specific pagination throttling and credential resolution.
 */
export async function runBespokeAdapterConformance<Configuration, Cursor>(
  input: BespokeConformanceCase<Configuration, Cursor>,
): Promise<BespokeConformanceResult> {
  const { adapter, metadata } = defineBespokeAdapter(input.definition);
  const discovery = await adapter.discover(input.configuration, input.context);
  if (discovery.source.sourceSystem !== adapter.id)
    throw new TypeError('discovery sourceSystem must equal the stable adapter id');
  const limit = input.limit ?? Math.min(100, metadata.rateLimit.maximumPageSize);
  if (limit > metadata.rateLimit.maximumPageSize)
    throw new RangeError('conformance limit exceeds declared maximumPageSize');
  const first = await adapter.extract({
    configuration: input.configuration,
    discovery,
    cursor: input.cursor,
    limit,
    context: input.context,
  });
  const repeated = await adapter.extract({
    configuration: input.configuration,
    discovery,
    cursor: input.cursor,
    limit,
    context: input.context,
  });
  if (JSON.stringify(first) !== JSON.stringify(repeated))
    throw new TypeError('extract must be deterministic for the same configuration and cursor');
  const entities = await Promise.all(
    first.rows.map((row) => adapter.normalize(row, input.context)),
  );
  const keys = new Set<string>();
  for (const [index, row] of first.rows.entries()) {
    if (!row.externalId.trim())
      throw new TypeError('every extracted row requires a stable externalId');
    const entity = entities[index]!;
    if (
      entity.externalId !== row.externalId ||
      entity.entityType !== row.entityType ||
      entity.sourcePosition !== row.sourcePosition
    )
      throw new TypeError('normalize must preserve row identity and provenance position');
    assertHistoricalFinancialEntity(entity);
    const key = migrationIdempotencyKey({
      tenantId: input.context.tenantId,
      sourceSystem: adapter.id,
      entityType: entity.entityType,
      externalId: entity.externalId,
    });
    if (keys.has(key))
      throw new TypeError(`duplicate idempotency identity in extraction page: ${key}`);
    keys.add(key);
  }
  const issues: MigrationIssue[] = (
    await Promise.all(entities.map((entity) => adapter.validate(entity, input.context)))
  ).flat();
  return { discovery, entities, issues, idempotencyKeys: [...keys] };
}
