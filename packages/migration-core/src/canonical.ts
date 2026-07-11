import type { MigrationEntityType, MigrationIssue, NormalizedMigrationEntity } from './index.js';

export type CanonicalMigrationEntityContract = {
  readonly requiredAttributes: readonly string[];
  readonly requiredDependencies: readonly MigrationEntityType[];
  readonly optionalDependencies?: readonly MigrationEntityType[];
};

/**
 * The public normalized-entity contract consumed by the production domain committers.
 * Adapters validate against this table so a clean dry-run cannot later fail at commit.
 */
export const CANONICAL_MIGRATION_ENTITY_CONTRACT = {
  organization: { requiredAttributes: ['name'], requiredDependencies: [] },
  brand: { requiredAttributes: ['name'], requiredDependencies: [] },
  venue: { requiredAttributes: ['name'], requiredDependencies: [] },
  event: {
    requiredAttributes: ['title', 'currency', 'timezone'],
    requiredDependencies: ['brand'],
    optionalDependencies: ['venue'],
  },
  occurrence: {
    requiredAttributes: ['startsAt', 'endsAt', 'timezone'],
    requiredDependencies: ['event'],
    optionalDependencies: ['venue'],
  },
  'inventory-pool': {
    requiredAttributes: ['name', 'totalCapacity'],
    requiredDependencies: ['event'],
  },
  'ticket-type': {
    requiredAttributes: ['name', 'currency', 'priceMinor'],
    requiredDependencies: ['event', 'inventory-pool'],
    optionalDependencies: ['occurrence'],
  },
  product: {
    requiredAttributes: ['name', 'currency', 'priceMinor'],
    requiredDependencies: ['event'],
  },
  question: {
    requiredAttributes: ['label', 'type'],
    requiredDependencies: ['event'],
    optionalDependencies: ['ticket-type'],
  },
  discount: {
    requiredAttributes: ['code', 'type', 'value'],
    requiredDependencies: ['event'],
  },
  'access-code': { requiredAttributes: ['code'], requiredDependencies: ['ticket-type'] },
  buyer: { requiredAttributes: ['email'], requiredDependencies: [] },
  attendee: {
    requiredAttributes: ['email'],
    requiredDependencies: ['event', 'ticket-type'],
    optionalDependencies: ['occurrence', 'historical-order'],
  },
  'historical-order': {
    requiredAttributes: ['orderNumber', 'currency', 'totalMinor', 'buyerEmail'],
    requiredDependencies: ['brand', 'event', 'attendee'],
  },
  ticket: {
    requiredAttributes: ['code'],
    requiredDependencies: ['event', 'ticket-type', 'attendee', 'historical-order'],
    optionalDependencies: ['occurrence'],
  },
  'historical-payment': {
    requiredAttributes: [],
    requiredDependencies: ['historical-order'],
  },
  'historical-refund': {
    requiredAttributes: [],
    requiredDependencies: ['historical-order'],
  },
  'check-in': { requiredAttributes: ['occurredAt'], requiredDependencies: ['ticket'] },
} as const satisfies Record<MigrationEntityType, CanonicalMigrationEntityContract>;

function missing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

function issue(
  entity: NormalizedMigrationEntity,
  details: Pick<MigrationIssue, 'code' | 'message' | 'field'>,
): MigrationIssue {
  return {
    ...details,
    severity: 'error',
    entityType: entity.entityType,
    externalId: entity.externalId,
    sourcePosition: entity.sourcePosition,
  };
}

export function validateCanonicalMigrationEntity(
  entity: NormalizedMigrationEntity,
): readonly MigrationIssue[] {
  const contract = CANONICAL_MIGRATION_ENTITY_CONTRACT[entity.entityType];
  const issues: MigrationIssue[] = [];
  if (!entity.externalId.trim()) {
    issues.push({
      ...issue(entity, {
        code: 'MAPPING_EXTERNAL_ID_REQUIRED',
        message: 'A non-empty stable source external ID is required.',
      }),
      severity: 'fatal',
    });
  }
  for (const field of contract.requiredAttributes) {
    if (missing(entity.attributes[field]))
      issues.push(
        issue(entity, {
          code: 'CANONICAL_ATTRIBUTE_REQUIRED',
          message: `${entity.entityType} requires canonical attribute ${field}.`,
          field,
        }),
      );
  }
  const dependencyTypes = new Set<MigrationEntityType>();
  for (const dependency of entity.dependencies ?? []) {
    if (!dependency.externalId.trim()) {
      issues.push(
        issue(entity, {
          code: 'CANONICAL_DEPENDENCY_EXTERNAL_ID_REQUIRED',
          message: `${dependency.entityType} dependency requires a stable external ID.`,
          field: `dependencies.${dependency.entityType}`,
        }),
      );
    }
    if (dependencyTypes.has(dependency.entityType)) {
      issues.push(
        issue(entity, {
          code: 'CANONICAL_DEPENDENCY_DUPLICATE',
          message: `${entity.entityType} has more than one ${dependency.entityType} dependency.`,
          field: `dependencies.${dependency.entityType}`,
        }),
      );
    }
    dependencyTypes.add(dependency.entityType);
  }
  for (const dependencyType of contract.requiredDependencies) {
    if (!dependencyTypes.has(dependencyType))
      issues.push(
        issue(entity, {
          code: 'CANONICAL_DEPENDENCY_REQUIRED',
          message: `${entity.entityType} requires a ${dependencyType} dependency.`,
          field: `dependencies.${dependencyType}`,
        }),
      );
  }
  if (
    (entity.entityType === 'historical-payment' || entity.entityType === 'historical-refund') &&
    !entity.financialSnapshot
  )
    issues.push(
      issue(entity, {
        code: 'FINANCIAL_SNAPSHOT_INVALID',
        message: 'Historical financial records require a side-effect-suppressed snapshot.',
        field: 'financialSnapshot',
      }),
    );
  return issues;
}
