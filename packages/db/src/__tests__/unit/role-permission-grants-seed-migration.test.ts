import { describe, expect, it } from 'vitest';
import { seedPermissionGrantId } from '../../migrations/0051_role_permission_grants_seed.js';

describe('role permission grant seed migration', () => {
  it('creates deterministic, bounded, permission-distinct IDs for production-length inputs', () => {
    const base = {
      organizationId: 'org_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      userId: 'usr_01JYYYYYYYYYYYYYYYYYYYYYYY',
    };
    const settings = seedPermissionGrantId({ ...base, permission: 'settings.write' });
    const billing = seedPermissionGrantId({ ...base, permission: 'billing.write' });

    expect(settings).toHaveLength(32);
    expect(settings).toBe(seedPermissionGrantId({ ...base, permission: 'settings.write' }));
    expect(billing).toHaveLength(32);
    expect(billing).not.toBe(settings);
  });
});
