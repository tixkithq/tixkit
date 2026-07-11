import { expectTypeOf, test } from 'vitest';
import type { CreateAdminMigrationJobInput } from './api';

function acceptAdminMigrationJob(_input: CreateAdminMigrationJobInput): void {}

acceptAdminMigrationJob({
  organizationId: 'org_1',
  sourceSystem: 'pretix',
  adapterVersion: 'api-v1',
  credentialId: 'mcred_12345678',
  configuration: {
    sourceMode: 'official-api',
    sourceSystem: 'eventbrite',
    // @ts-expect-error The admin client rejects mismatched outer and nested sources.
    organizationId: 'source_org',
    eventIds: ['evt_1'],
  },
});
acceptAdminMigrationJob({
  organizationId: 'org_1',
  sourceSystem: 'ticket-tailor',
  adapterVersion: 'api-v1',
  credentialId: 'mcred_12345678',
  // @ts-expect-error Ticket Tailor API jobs require explicit event IDs.
  configuration: { sourceMode: 'official-api', sourceSystem: 'ticket-tailor', accountId: 'acct' },
});

test('admin migration create inputs preserve literal source correlation', () => {
  expectTypeOf<CreateAdminMigrationJobInput>().toBeObject();
});
