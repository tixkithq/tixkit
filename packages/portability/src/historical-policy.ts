import { createHash } from 'node:crypto';
import {
  canonicalPortableJson,
  isPortableProtocolId,
  type PortableLogicalRecord,
  type PortablePayloadSafetyPolicy,
  type PortableSection,
} from './manifest.js';

export type PortableHistoricalSection =
  | 'buyers'
  | 'attendees'
  | 'orders'
  | 'payments'
  | 'refunds'
  | 'tickets'
  | 'scans';
type FieldType =
  | 'string'
  | 'nullable-string'
  | 'integer'
  | 'nullable-integer'
  | 'boolean'
  | 'json'
  | 'sha256'
  | 'nullable-sha256';

const schemas = {
  buyers: {
    required: ['email', 'createdAt'],
    attributes: {
      email: 'string',
      firstName: 'nullable-string',
      lastName: 'nullable-string',
      phone: 'nullable-string',
      createdAt: 'string',
      updatedAt: 'string',
    },
  },
  attendees: {
    required: ['email', 'status', 'createdAt'],
    attributes: {
      email: 'string',
      firstName: 'nullable-string',
      lastName: 'nullable-string',
      phone: 'nullable-string',
      dateOfBirth: 'nullable-string',
      status: 'string',
      customAnswers: 'json',
      checkedInAt: 'nullable-string',
      createdAt: 'string',
      updatedAt: 'string',
    },
  },
  orders: {
    required: ['orderNumber', 'status', 'currency', 'totalMinor', 'buyerEmail', 'createdAt'],
    attributes: {
      orderNumber: 'string',
      status: 'string',
      currency: 'string',
      subtotalMinor: 'integer',
      discountMinor: 'integer',
      taxMinor: 'integer',
      feeMinor: 'integer',
      totalMinor: 'integer',
      refundedMinor: 'integer',
      buyerEmail: 'string',
      buyerFirstName: 'nullable-string',
      buyerLastName: 'nullable-string',
      buyerPhone: 'nullable-string',
      buyerDateOfBirth: 'nullable-string',
      salesChannel: 'string',
      tenderType: 'nullable-string',
      isTest: 'boolean',
      paidAt: 'nullable-string',
      refundedAt: 'nullable-string',
      cancelledAt: 'nullable-string',
      createdAt: 'string',
      updatedAt: 'string',
    },
  },
  payments: {
    required: ['status', 'provider', 'createdAt'],
    attributes: {
      status: 'string',
      provider: 'string',
      providerReferenceSha256: 'nullable-sha256',
      createdAt: 'string',
      updatedAt: 'string',
    },
  },
  refunds: {
    required: ['status', 'provider', 'reason', 'createdAt'],
    attributes: {
      status: 'string',
      provider: 'string',
      reason: 'string',
      providerReferenceSha256: 'nullable-sha256',
      createdAt: 'string',
      updatedAt: 'string',
    },
  },
  tickets: {
    required: ['codeSha256', 'status', 'createdAt'],
    attributes: {
      codeSha256: 'sha256',
      status: 'string',
      transferredToEmail: 'nullable-string',
      transferredAt: 'nullable-string',
      checkedInAt: 'nullable-string',
      createdAt: 'string',
      updatedAt: 'string',
    },
  },
  scans: {
    required: ['occurredAt', 'result'],
    attributes: { occurredAt: 'string', result: 'string', offline: 'boolean' },
  },
} as const satisfies Record<
  PortableHistoricalSection,
  { required: readonly string[]; attributes: Readonly<Record<string, FieldType>> }
>;

export const PORTABLE_HISTORICAL_POLICY_VERSION = 'tixkit-portable-historical-policy-v1';
export const PORTABLE_HISTORICAL_SECTIONS = Object.freeze(
  Object.keys(schemas) as PortableHistoricalSection[],
);

export function portableHistoricalPolicyDescriptor(section: PortableHistoricalSection) {
  return {
    version: PORTABLE_HISTORICAL_POLICY_VERSION,
    section,
    attributes: schemas[section],
    dependencies: dependencies[section],
    financialSnapshot:
      section === 'payments' || section === 'refunds'
        ? {
            required: true,
            kind: section === 'payments' ? 'historical-payment' : 'historical-refund',
            amountMinor: 'nonnegative-safe-integer',
            currency: 'iso-4217-uppercase',
            providerReference: 'forbidden-plaintext',
            providerReferenceSha256: 'optional-sha256-attribute',
            provenance: 'tixkit-portable-source-id-and-valid-import-time',
            sideEffects: 'suppressed',
          }
        : { required: false, permitted: false },
    bearerCredentials: section === 'tickets' ? 'sha256-only' : 'forbidden',
    secretPolicy: 'tixkit-portable-secret-policy-v1',
  } as const;
}

function validTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function matchesType(value: unknown, type: FieldType): boolean {
  if (type === 'nullable-string') return value === null || typeof value === 'string';
  if (type === 'nullable-integer') return value === null || Number.isSafeInteger(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'sha256') return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (type === 'nullable-sha256')
    return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value));
  return value === null || (typeof value === 'object' && !Array.isArray(value));
}

function validFinancialSnapshot(
  section: PortableHistoricalSection,
  record: PortableLogicalRecord,
): boolean {
  if (section !== 'payments' && section !== 'refunds')
    return record.financialSnapshot === undefined;
  const snapshot = record.financialSnapshot;
  if (!snapshot) return false;
  return (
    snapshot.kind === (section === 'payments' ? 'historical-payment' : 'historical-refund') &&
    Number.isSafeInteger(snapshot.amountMinor) &&
    snapshot.amountMinor >= 0 &&
    snapshot.providerReference === undefined &&
    /^[A-Z]{3}$/u.test(snapshot.currency) &&
    validTimestamp(snapshot.occurredAt) &&
    snapshot.provenance.sourceSystem === 'tixkit-portable' &&
    snapshot.provenance.sourceExternalId === record.portableId &&
    validTimestamp(snapshot.provenance.importedAt) &&
    snapshot.sideEffects === 'suppressed'
  );
}

const dependencies = {
  buyers: { required: [], optional: [] },
  attendees: { required: ['events', 'ticket_types'], optional: ['occurrences'] },
  orders: { required: ['brands', 'events', 'attendees'], optional: [] },
  payments: { required: ['orders'], optional: [] },
  refunds: { required: ['orders'], optional: [] },
  tickets: {
    required: ['events', 'ticket_types', 'attendees', 'orders'],
    optional: ['occurrences'],
  },
  scans: { required: ['tickets'], optional: [] },
} as const satisfies Record<
  PortableHistoricalSection,
  { required: readonly PortableSection[]; optional: readonly PortableSection[] }
>;

function validDependencies(
  section: PortableHistoricalSection,
  recordDependencies: PortableLogicalRecord['dependencies'],
): boolean {
  const topology = dependencies[section];
  const allowed = new Set<PortableSection>([...topology.required, ...topology.optional]);
  const rows = recordDependencies ?? [];
  if (
    rows.some(
      ({ section: dependencySection, portableId }) =>
        !allowed.has(dependencySection) || !isPortableProtocolId(portableId),
    ) ||
    new Set(rows.map(({ section: dependencySection }) => dependencySection)).size !== rows.length
  )
    return false;
  return (
    topology.required.every(
      (requiredSection) =>
        rows.filter(({ section: dependencySection }) => dependencySection === requiredSection)
          .length === 1,
    ) &&
    topology.optional.every(
      (optionalSection) =>
        rows.filter(({ section: dependencySection }) => dependencySection === optionalSection)
          .length <= 1,
    )
  );
}

function validate(section: PortableHistoricalSection, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as PortableLogicalRecord & Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['portableId', 'attributes', 'dependencies', 'financialSnapshot'].includes(key),
    ) ||
    !isPortableProtocolId(record.portableId) ||
    !record.attributes ||
    typeof record.attributes !== 'object' ||
    Array.isArray(record.attributes) ||
    !validFinancialSnapshot(section, record) ||
    !validDependencies(section, record.dependencies)
  )
    return false;
  const schema = schemas[section];
  const attributes = record.attributes as Record<string, unknown>;
  if (schema.required.some((key) => !(key in attributes))) return false;
  if (
    !Object.entries(attributes).every(([key, fieldValue]) => {
      const type = (schema.attributes as Record<string, FieldType>)[key];
      if (!type || !matchesType(fieldValue, type)) return false;
      if ((key.endsWith('At') || key === 'createdAt' || key === 'updatedAt') && fieldValue !== null)
        return validTimestamp(fieldValue);
      if (key === 'currency')
        return typeof fieldValue === 'string' && /^[A-Z]{3}$/u.test(fieldValue);
      return typeof fieldValue !== 'string' || fieldValue.length <= 10_000;
    })
  )
    return false;
  return true;
}

export function createPortableHistoricalPayloadPolicies(): ReadonlyMap<
  PortableHistoricalSection,
  PortablePayloadSafetyPolicy
> {
  return new Map(
    PORTABLE_HISTORICAL_SECTIONS.map((section) => {
      const schemaSha256 = createHash('sha256')
        .update(canonicalPortableJson(schemas[section]))
        .digest('hex');
      const policySha256 = createHash('sha256')
        .update(canonicalPortableJson(portableHistoricalPolicyDescriptor(section)))
        .digest('hex');
      return [
        section,
        {
          schemaId: `tixkit_${section}_historical_v1`,
          schemaSha256,
          policySha256,
          scannerId: 'tixkit_portable_historical_scanner_v1',
          validateRecord: (candidateSection: PortableSection, record: unknown) =>
            candidateSection === section && validate(section, record),
        },
      ];
    }),
  );
}
