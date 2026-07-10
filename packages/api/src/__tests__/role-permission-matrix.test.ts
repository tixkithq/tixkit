import { describe, expect, it } from 'vitest';
import { isDoorOnlyPermissionSet, permissionsForRole, ROLE_PERMISSIONS } from '@tixkit/domain';

describe('organization role permission matrix', () => {
  it('organizer can scan and sell; viewer cannot write check-ins', () => {
    expect(permissionsForRole('organizer')).toEqual(
      expect.arrayContaining(['checkins.write', 'box_office.write', 'orders.write']),
    );
    expect(permissionsForRole('viewer')).not.toContain('checkins.write');
    expect(permissionsForRole('viewer')).not.toContain('box_office.write');
  });

  it('door staff packs stay door-only', () => {
    expect(isDoorOnlyPermissionSet(permissionsForRole('door_staff'))).toBe(true);
    expect(isDoorOnlyPermissionSet(permissionsForRole('door_staff_sales'))).toBe(true);
    expect(isDoorOnlyPermissionSet(ROLE_PERMISSIONS.admin)).toBe(false);
    expect(permissionsForRole('door_staff_sales')).toContain('box_office.write');
    expect(permissionsForRole('door_staff_sales')).not.toContain('orders.write');
  });
});
