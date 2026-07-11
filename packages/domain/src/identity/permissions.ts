export type Permission =
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
  | 'box_office.write'
  | 'messages.write'
  | 'reports.read'
  | 'settings.write'
  | 'developers.write'
  | 'migrations.read'
  | 'migrations.write'
  | 'migrations.commit'
  | 'migrations.rollback'
  | 'billing.write';

export const ALL_PERMISSIONS: Permission[] = [
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
  'settings.write',
  'developers.write',
  'migrations.read',
  'migrations.write',
  'migrations.commit',
  'migrations.rollback',
  'billing.write',
];
