export const MIGRATION_SOURCE_MODES = ['official-api', 'official-export'] as const;

export type MigrationSourceMode = (typeof MIGRATION_SOURCE_MODES)[number];

type ExportPreparation = {
  sourceMode: 'official-export';
  artifactIds: readonly string[];
};

export type SupportedMigrationSource =
  | 'generic-csv'
  | 'pretix'
  | 'hi-events'
  | 'eventbrite'
  | 'ticket-tailor';

type ExportPreparationBySource = {
  [Source in SupportedMigrationSource]: ExportPreparation & {
    sourceSystem: Source;
  };
}[SupportedMigrationSource];

export type MigrationPreparationConfiguration =
  | ExportPreparationBySource
  | {
      sourceMode: 'official-api';
      sourceSystem: 'pretix';
      organizerSlug: string;
      eventSlugs: readonly string[];
      baseUrl?: string;
    }
  | {
      sourceMode: 'official-api';
      sourceSystem: 'hi-events';
      accountId: string;
      eventIds: readonly string[];
      baseUrl?: string;
    }
  | {
      sourceMode: 'official-api';
      sourceSystem: 'eventbrite';
      organizationId: string;
      eventIds: readonly string[];
    }
  | {
      sourceMode: 'official-api';
      sourceSystem: 'ticket-tailor';
      accountId: string;
      eventIds: readonly string[];
    };

export type MigrationPreparationRequest = {
  configuration: MigrationPreparationConfiguration;
  credentialId?: string;
};

export const MIGRATION_API_ORIGINS = {
  eventbrite: 'https://www.eventbriteapi.com',
  'ticket-tailor': 'https://api.tickettailor.com',
} as const;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const artifactId = /^upl_[A-Za-z0-9_-]{8,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new TypeError(`Unexpected migration source field: ${unexpected[0]}`);
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !identifier.test(value))
    throw new TypeError(`${field} must be a valid source identifier`);
  return value;
}

function identifiers(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000)
    throw new TypeError(`${field} must be an array of at most 10000 identifiers`);
  const result = value.map((item) => requiredIdentifier(item, field));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} contains duplicates`);
  return result;
}

function optionalBaseUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('baseUrl must be a URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new TypeError('baseUrl must be an HTTPS origin without credentials, query, or fragment');
  if (url.pathname !== '/' && url.pathname !== '')
    throw new TypeError('baseUrl must be an origin without a path');
  return url.origin;
}

export function parseMigrationPreparationConfiguration(
  input: unknown,
  expectedSourceSystem?: string,
): MigrationPreparationConfiguration {
  if (!isRecord(input)) throw new TypeError('configuration must be an object');
  const sourceSystem = requiredIdentifier(input.sourceSystem, 'sourceSystem');
  if (expectedSourceSystem && sourceSystem !== expectedSourceSystem)
    throw new TypeError('configuration sourceSystem does not match the migration job');
  if (!['generic-csv', 'pretix', 'hi-events', 'eventbrite', 'ticket-tailor'].includes(sourceSystem))
    throw new TypeError(`Unsupported migration sourceSystem: ${sourceSystem}`);
  if (input.sourceMode === 'official-export') {
    exactKeys(input, ['sourceMode', 'sourceSystem', 'artifactIds']);
    if (
      !Array.isArray(input.artifactIds) ||
      input.artifactIds.length < 1 ||
      input.artifactIds.length > 100
    )
      throw new TypeError('artifactIds must contain between 1 and 100 upload artifact identifiers');
    const artifactIds = input.artifactIds.map((value) => {
      if (typeof value !== 'string' || !artifactId.test(value))
        throw new TypeError('artifactIds contains an invalid upload artifact identifier');
      return value;
    });
    if (new Set(artifactIds).size !== artifactIds.length)
      throw new TypeError('artifactIds contains duplicates');
    return {
      sourceMode: 'official-export',
      sourceSystem: sourceSystem as SupportedMigrationSource,
      artifactIds,
    };
  }
  if (input.sourceMode !== 'official-api') throw new TypeError('sourceMode is unsupported');
  if (sourceSystem === 'generic-csv')
    throw new TypeError('generic-csv supports official-export only');
  if (sourceSystem === 'pretix') {
    exactKeys(input, ['sourceMode', 'sourceSystem', 'organizerSlug', 'eventSlugs', 'baseUrl']);
    const eventSlugs = identifiers(input.eventSlugs, 'eventSlugs');
    if (!eventSlugs?.length) throw new TypeError('eventSlugs must select at least one event');
    return {
      sourceMode: 'official-api',
      sourceSystem,
      organizerSlug: requiredIdentifier(input.organizerSlug, 'organizerSlug'),
      eventSlugs,
      baseUrl: optionalBaseUrl(input.baseUrl),
    };
  }
  if (sourceSystem === 'hi-events') {
    exactKeys(input, ['sourceMode', 'sourceSystem', 'accountId', 'eventIds', 'baseUrl']);
    const eventIds = identifiers(input.eventIds, 'eventIds');
    if (!eventIds?.length) throw new TypeError('eventIds must select at least one event');
    return {
      sourceMode: 'official-api',
      sourceSystem,
      accountId: requiredIdentifier(input.accountId, 'accountId'),
      eventIds,
      baseUrl: optionalBaseUrl(input.baseUrl),
    };
  }
  exactKeys(input, [
    'sourceMode',
    'sourceSystem',
    sourceSystem === 'eventbrite' ? 'organizationId' : 'accountId',
    'eventIds',
  ]);
  const eventIds = identifiers(input.eventIds, 'eventIds');
  if (sourceSystem === 'eventbrite' && !eventIds?.length)
    throw new TypeError('eventIds must select at least one event');
  if (sourceSystem === 'ticket-tailor' && !eventIds?.length)
    throw new TypeError('eventIds must select at least one event');
  return sourceSystem === 'eventbrite'
    ? {
        sourceMode: 'official-api',
        sourceSystem,
        organizationId: requiredIdentifier(input.organizationId, 'organizationId'),
        eventIds: eventIds!,
      }
    : {
        sourceMode: 'official-api',
        sourceSystem: 'ticket-tailor',
        accountId: requiredIdentifier(input.accountId, 'accountId'),
        eventIds: eventIds!,
      };
}
