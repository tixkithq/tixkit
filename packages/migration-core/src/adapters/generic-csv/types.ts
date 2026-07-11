import type { MigrationEntityType, MigrationIssue } from '../../index.js';

export const GENERIC_CSV_SUPPORTED_VERSIONS = ['rfc4180-v1'] as const;

export const GENERIC_CSV_ENTITY_TYPES = [
  'event',
  'ticket-type',
  'attendee',
  'historical-order',
  'ticket',
  'discount',
  'check-in',
] as const satisfies readonly MigrationEntityType[];

export type GenericCsvEntityType = (typeof GENERIC_CSV_ENTITY_TYPES)[number];

export type GenericCsvDocument = {
  name: string;
  content: string;
  entityType?: GenericCsvEntityType;
  delimiter?: ',' | ';' | '\t' | '|';
};

export type GenericCsvFieldMapping = Readonly<Record<string, string>>;

export type GenericCsvMappingProfile = {
  id: string;
  entityType: GenericCsvEntityType;
  fields: GenericCsvFieldMapping;
};

export type GenericCsvConfiguration = {
  documents: readonly GenericCsvDocument[];
  profiles?: readonly GenericCsvMappingProfile[];
  profileByDocument?: Readonly<Record<string, string>>;
  defaultCurrency?: string;
  defaultTimezone?: string;
};

export type GenericCsvPreview = {
  documentName: string;
  entityType?: GenericCsvEntityType;
  delimiter: string;
  headers: readonly string[];
  rows: readonly Readonly<Record<string, string>>[];
  issues: readonly MigrationIssue[];
};

export type GenericCsvErrorExportRow = {
  sourcePosition: string;
  entityType?: MigrationEntityType;
  externalId?: string;
  field?: string;
  severity: MigrationIssue['severity'];
  code: string;
  message: string;
};

export type GenericCsvSourceMetadata = {
  supportedVersions: readonly string[];
  featureMapping: Readonly<Record<GenericCsvEntityType, readonly string[]>>;
  knownLosses: readonly string[];
};
