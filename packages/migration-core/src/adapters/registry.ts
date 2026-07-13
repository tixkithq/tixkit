import type { MigrationAdapter } from '../index.js';
import { genericCsvMigrationAdapter } from './generic-csv/index.js';
import { GENERIC_CSV_SOURCE_METADATA } from './generic-csv/templates.js';
import {
  PRETIX_FEATURE_MAPPING,
  PRETIX_KNOWN_LOSSES,
  PRETIX_RATE_LIMIT_POLICY,
  PRETIX_SUPPORTED_VERSIONS,
  pretixMigrationAdapter,
} from './pretix/index.js';
import {
  HI_EVENTS_FEATURE_MAPPING,
  HI_EVENTS_KNOWN_LOSSES,
  HI_EVENTS_RATE_LIMIT_POLICY,
  HI_EVENTS_SUPPORTED_VERSIONS,
  hiEventsMigrationAdapter,
} from './hi-events/index.js';
import { EVENTBRITE_ADAPTER_METADATA, eventbriteAdapter } from './eventbrite/index.js';
import { TICKET_TAILOR_ADAPTER_METADATA, ticketTailorAdapter } from './ticket-tailor/index.js';
import {
  TIXKIT_PORTABLE_SUPPORTED_VERSIONS,
  tixkitPortableMigrationAdapter,
} from './tixkit-portable/index.js';

export const MIGRATION_IMPORTER_ORDER = [
  'generic-csv',
  'pretix',
  'hi-events',
  'eventbrite',
  'ticket-tailor',
] as const;

export type MigrationImporterId = (typeof MIGRATION_IMPORTER_ORDER)[number] | 'tixkit-portable';

export type MigrationAdapterCatalogEntry = {
  id: MigrationImporterId;
  displayName: string;
  supportedVersions: readonly string[];
  featureMapping: Readonly<Record<string, unknown>>;
  knownLosses: readonly string[];
  rateLimitPolicy: Readonly<Record<string, unknown>>;
  sourceModes: readonly ('official-api' | 'official-export')[];
};

export function migrationAdapterCatalog(): readonly MigrationAdapterCatalogEntry[] {
  return [
    {
      id: 'generic-csv',
      displayName: 'Generic CSV',
      supportedVersions: GENERIC_CSV_SOURCE_METADATA.supportedVersions,
      featureMapping: GENERIC_CSV_SOURCE_METADATA.featureMapping,
      knownLosses: GENERIC_CSV_SOURCE_METADATA.knownLosses,
      rateLimitPolicy: { strategy: 'local immutable export; no network requests' },
      sourceModes: ['official-export'],
    },
    {
      id: 'pretix',
      displayName: 'pretix',
      supportedVersions: PRETIX_SUPPORTED_VERSIONS,
      featureMapping: PRETIX_FEATURE_MAPPING,
      knownLosses: PRETIX_KNOWN_LOSSES,
      rateLimitPolicy: PRETIX_RATE_LIMIT_POLICY,
      sourceModes: ['official-api', 'official-export'],
    },
    {
      id: 'hi-events',
      displayName: 'Hi.Events',
      supportedVersions: HI_EVENTS_SUPPORTED_VERSIONS,
      featureMapping: HI_EVENTS_FEATURE_MAPPING,
      knownLosses: HI_EVENTS_KNOWN_LOSSES,
      rateLimitPolicy: HI_EVENTS_RATE_LIMIT_POLICY,
      sourceModes: ['official-api', 'official-export'],
    },
    {
      id: 'eventbrite',
      displayName: 'Eventbrite',
      supportedVersions: EVENTBRITE_ADAPTER_METADATA.supportedVersions,
      featureMapping: EVENTBRITE_ADAPTER_METADATA.featureMap,
      knownLosses: EVENTBRITE_ADAPTER_METADATA.knownLosses,
      rateLimitPolicy: EVENTBRITE_ADAPTER_METADATA.rateLimits,
      sourceModes: ['official-api', 'official-export'],
    },
    {
      id: 'ticket-tailor',
      displayName: 'Ticket Tailor',
      supportedVersions: TICKET_TAILOR_ADAPTER_METADATA.supportedVersions,
      featureMapping: TICKET_TAILOR_ADAPTER_METADATA.featureMap,
      knownLosses: TICKET_TAILOR_ADAPTER_METADATA.knownLosses,
      rateLimitPolicy: TICKET_TAILOR_ADAPTER_METADATA.rateLimits,
      sourceModes: ['official-api', 'official-export'],
    },
    {
      id: 'tixkit-portable',
      displayName: 'Tixkit Portable Bundle',
      supportedVersions: TIXKIT_PORTABLE_SUPPORTED_VERSIONS,
      featureMapping: {
        configuration: 'native logical bundle',
        historical: 'explicitly authorized logical bundle',
      },
      knownLosses: [],
      rateLimitPolicy: { strategy: 'local immutable signed export; no network requests' },
      sourceModes: ['official-export'],
    },
  ];
}

type RegisteredAdapter = MigrationAdapter<never, string>;

export function migrationAdapter(id: MigrationImporterId): RegisteredAdapter {
  switch (id) {
    case 'generic-csv':
      return genericCsvMigrationAdapter as RegisteredAdapter;
    case 'pretix':
      return pretixMigrationAdapter as RegisteredAdapter;
    case 'hi-events':
      return hiEventsMigrationAdapter as RegisteredAdapter;
    case 'eventbrite':
      return eventbriteAdapter as RegisteredAdapter;
    case 'ticket-tailor':
      return ticketTailorAdapter as RegisteredAdapter;
    case 'tixkit-portable':
      return tixkitPortableMigrationAdapter as RegisteredAdapter;
  }
}

export function listMigrationAdapters(): readonly RegisteredAdapter[] {
  return MIGRATION_IMPORTER_ORDER.map((id) => migrationAdapter(id));
}
