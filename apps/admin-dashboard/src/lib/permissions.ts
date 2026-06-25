export type GateKitPermission =
  | 'events.read'
  | 'events.write'
  | 'tickets.write'
  | 'orders.read'
  | 'orders.write'
  | 'refunds.write'
  | 'attendees.read'
  | 'attendees.write'
  | 'checkins.read'
  | 'checkins.write'
  | 'messages.write'
  | 'reports.read'
  | 'settings.write'
  | 'developers.write'
  | 'billing.write'

export type NavBadgeTone =
  | 'default'
  | 'muted'
  | 'success'
  | 'warning'
  | 'destructive'

/**
 * All permissions granted to the local-dev user when Clerk is unavailable.
 * In production these come from the GateKit principal resolved after Clerk auth.
 */
export const LOCAL_DEV_PERMISSIONS: GateKitPermission[] = [
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
  'messages.write',
  'reports.read',
  'settings.write',
  'developers.write',
  'billing.write',
]

/**
 * Check whether a set of permissions satisfies a required permission.
 * Returns true when no permission is required or the set includes it.
 */
export function hasPermission(
  granted: GateKitPermission[] | undefined,
  required: GateKitPermission | undefined
): boolean {
  if (!required) return true
  if (!granted) return false
  return granted.includes(required)
}
