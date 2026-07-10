import { ALL_PERMISSIONS, type Permission } from './permissions.js';

/**
 * System organization roles that map to permission grants at invite/role-change time.
 * Effective access is still enforced via `permission_grants` on the principal.
 */
export type OrganizationSystemRole =
  | 'owner'
  | 'admin'
  | 'organizer'
  | 'viewer'
  | 'door_staff'
  | 'door_staff_sales';

/** Roles that can be assigned through the invitation API. */
export type InvitableOrganizationRole = Exclude<OrganizationSystemRole, 'owner'>;

export const INVITABLE_ORGANIZATION_ROLES = [
  'admin',
  'organizer',
  'viewer',
  'door_staff',
  'door_staff_sales',
] as const satisfies readonly InvitableOrganizationRole[];

export { ALL_PERMISSIONS };

const OWNER_ADMIN_PERMISSIONS: Permission[] = [...ALL_PERMISSIONS];

const ORGANIZER_PERMISSIONS: Permission[] = [
  'events.read',
  'events.write',
  'tickets.write',
  'orders.read',
  'orders.write',
  'refunds.write',
  'attendees.read',
  'attendees.write',
  'checkins.read',
  'checkins.write',
  'box_office.write',
  'messages.write',
  'reports.read',
];

const VIEWER_PERMISSIONS: Permission[] = [
  'events.read',
  'orders.read',
  'attendees.read',
  'checkins.read',
  'reports.read',
];

const DOOR_STAFF_PERMISSIONS: Permission[] = [
  'events.read',
  'attendees.read',
  'checkins.read',
  'checkins.write',
];

const DOOR_STAFF_SALES_PERMISSIONS: Permission[] = [
  ...DOOR_STAFF_PERMISSIONS,
  'tickets.write',
  'orders.read',
  'box_office.write',
];

/**
 * Canonical role → permission matrix. Invite/role-change flows should replace
 * org-managed grants from this table rather than inventing ad-hoc scopes.
 */
export const ROLE_PERMISSIONS: Record<OrganizationSystemRole, readonly Permission[]> = {
  owner: OWNER_ADMIN_PERMISSIONS,
  admin: OWNER_ADMIN_PERMISSIONS,
  organizer: ORGANIZER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
  door_staff: DOOR_STAFF_PERMISSIONS,
  door_staff_sales: DOOR_STAFF_SALES_PERMISSIONS,
};

export function isOrganizationSystemRole(role: string): role is OrganizationSystemRole {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

export function isInvitableOrganizationRole(role: string): role is InvitableOrganizationRole {
  return (INVITABLE_ORGANIZATION_ROLES as readonly string[]).includes(role);
}

export function permissionsForRole(role: string): Permission[] {
  if (!isOrganizationSystemRole(role)) {
    return [...VIEWER_PERMISSIONS];
  }
  return [...ROLE_PERMISSIONS[role]];
}

/** True when the role is limited to door operations (scan/sales), not full dashboard. */
export function isDoorStaffRole(role: string): boolean {
  return role === 'door_staff' || role === 'door_staff_sales';
}

/** True when the principal only has door-oriented permissions (no settings/events write/etc.). */
export function isDoorOnlyPermissionSet(permissions: readonly Permission[]): boolean {
  if (permissions.length === 0) return false;
  const hasDoorCapability =
    permissions.includes('checkins.write') || permissions.includes('box_office.write');
  if (!hasDoorCapability) return false;
  const allowed = new Set<Permission>([
    'events.read',
    'attendees.read',
    'checkins.read',
    'checkins.write',
    'tickets.write',
    'orders.read',
    'box_office.write',
  ]);
  return permissions.every((permission) => allowed.has(permission));
}

/**
 * True when `returnTo` is a same-origin kiosk path used after staff invite accept.
 * Allows `/kiosk` or `/kiosk/{eventId}` with optional query; rejects traversal and protocol-relative URLs.
 */
export function isLocalKioskReturnTo(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/kiosk')) return false;
  if (trimmed.startsWith('//') || trimmed.includes('\\')) return false;
  if (trimmed.includes('..')) return false;
  if (/%2e|%2f|%5c/i.test(trimmed)) return false;
  if (
    [...trimmed].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  )
    return false;
  try {
    const url = new URL(trimmed, 'https://tixkit.local');
    if (url.origin !== 'https://tixkit.local') return false;
    if (url.username || url.password) return false;
    const rawPath = trimmed.split(/[?#]/, 1)[0] ?? '';
    if (rawPath !== url.pathname) return false;
    if (url.pathname === '/kiosk') return true;
    return /^\/kiosk\/[^./][^/]*$/.test(url.pathname);
  } catch {
    return false;
  }
}
