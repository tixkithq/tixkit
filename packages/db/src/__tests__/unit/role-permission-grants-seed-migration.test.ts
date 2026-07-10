import { describe, expect, it } from 'vitest';
import {
  seedPermissionGrantId,
  seededPermissionsForRole,
} from '../../migrations/0051_role_permission_grants_seed.js';

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

  it('keeps the historical role matrix self-contained for clean migrations', () => {
    expect(seededPermissionsForRole('admin')).toContain('billing.write');
    expect(seededPermissionsForRole('organizer')).not.toContain('settings.write');
    expect(seededPermissionsForRole('door_staff')).toEqual([
      'events.read',
      'attendees.read',
      'checkins.read',
      'checkins.write',
    ]);
    expect(seededPermissionsForRole('custom_role')).toBeUndefined();
  });
});
