import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  isDoorOnlyPermissionSet,
  isDoorStaffRole,
  isInvitableOrganizationRole,
  isLocalKioskReturnTo,
  permissionsForRole,
  ROLE_PERMISSIONS,
} from '../identity/roles.js';

describe('ROLE_PERMISSIONS', () => {
  it('gives organizers check-in and box office write', () => {
    const permissions = permissionsForRole('organizer');
    expect(permissions).toContain('checkins.write');
    expect(permissions).toContain('box_office.write');
    expect(permissions).not.toContain('settings.write');
  });

  it('denies viewers check-in write and box office write', () => {
    const permissions = permissionsForRole('viewer');
    expect(permissions).toContain('checkins.read');
    expect(permissions).not.toContain('checkins.write');
    expect(permissions).not.toContain('box_office.write');
    expect(permissions).not.toContain('orders.write');
  });

  it('limits door_staff to scan-oriented permissions', () => {
    const permissions = permissionsForRole('door_staff');
    expect(permissions).toEqual(
      expect.arrayContaining(['events.read', 'attendees.read', 'checkins.read', 'checkins.write']),
    );
    expect(permissions).not.toContain('box_office.write');
    expect(permissions).not.toContain('orders.write');
    expect(permissions).not.toContain('settings.write');
    expect(isDoorStaffRole('door_staff')).toBe(true);
    expect(isDoorOnlyPermissionSet(permissions)).toBe(true);
  });

  it('allows door_staff_sales to sell at the door without full orders.write', () => {
    const permissions = permissionsForRole('door_staff_sales');
    expect(permissions).toContain('checkins.write');
    expect(permissions).toContain('box_office.write');
    expect(permissions).not.toContain('orders.write');
    expect(permissions).not.toContain('refunds.write');
    expect(isDoorOnlyPermissionSet(permissions)).toBe(true);
  });

  it('includes box_office.write in the global permission list', () => {
    expect(ALL_PERMISSIONS).toContain('box_office.write');
    expect(ROLE_PERMISSIONS.admin).toContain('box_office.write');
  });

  it('accepts invitable roles and rejects owner for invitations', () => {
    expect(isInvitableOrganizationRole('door_staff')).toBe(true);
    expect(isInvitableOrganizationRole('door_staff_sales')).toBe(true);
    expect(isInvitableOrganizationRole('owner')).toBe(false);
  });

  it('rejects read-only permission packs without door capability', () => {
    expect(isDoorOnlyPermissionSet(['events.read', 'attendees.read', 'checkins.read'])).toBe(false);
  });

  it('accepts only safe local kiosk returnTo paths', () => {
    expect(isLocalKioskReturnTo('/kiosk/evt_1?tab=scan')).toBe(true);
    expect(isLocalKioskReturnTo('/kiosk')).toBe(true);
    expect(isLocalKioskReturnTo('/kiosk/../settings/billing')).toBe(false);
    expect(isLocalKioskReturnTo('/kiosk/evt_1/../settings')).toBe(false);
    expect(isLocalKioskReturnTo('/kiosk/%2e%2e/settings')).toBe(false);
    expect(isLocalKioskReturnTo('//evil.example/kiosk/evt_1')).toBe(false);
    expect(isLocalKioskReturnTo('/check-in')).toBe(false);
  });
});
