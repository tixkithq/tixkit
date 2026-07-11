import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  assertGenericCsvByteSize,
  previewGenericCsv,
  type GenericCsvEntityType,
} from '@tixkit/migration-core';

const entityTypes = new Set<GenericCsvEntityType>([
  'event',
  'ticket-type',
  'attendee',
  'historical-order',
  'ticket',
  'discount',
  'check-in',
]);

export async function previewCsvFile(input: {
  path: string;
  entityType?: string;
  defaultCurrency?: string;
  defaultTimezone?: string;
}) {
  if (input.entityType && !entityTypes.has(input.entityType as GenericCsvEntityType)) {
    throw new Error(`Unsupported Generic CSV entity type: ${input.entityType}`);
  }
  const file = await stat(input.path);
  if (!file.isFile()) throw new Error('Generic CSV path must identify a regular file');
  assertGenericCsvByteSize(file.size);
  const content = await readFile(input.path, 'utf8');
  return previewGenericCsv({
    documents: [
      {
        name: basename(input.path),
        content,
        ...(input.entityType ? { entityType: input.entityType as GenericCsvEntityType } : {}),
      },
    ],
    ...(input.defaultCurrency ? { defaultCurrency: input.defaultCurrency } : {}),
    ...(input.defaultTimezone ? { defaultTimezone: input.defaultTimezone } : {}),
  });
}
