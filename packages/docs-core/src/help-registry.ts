import type { DocRouteId } from './routes.js';

export const documentationPermissions = [
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
  'billing.write',
] as const;
export type DocumentationPermission = (typeof documentationPermissions)[number];

export interface DashboardHelpLink {
  label: string;
  docRouteId: DocRouteId;
}

export interface DashboardTroubleshootingLink {
  symptom: string;
  docRouteId: DocRouteId;
}

export interface DashboardHelpEntry {
  id: string;
  routePattern: string;
  title: string;
  summary: string;
  docRouteId: DocRouteId;
  commonTasks: readonly DashboardHelpLink[];
  troubleshooting: readonly DashboardTroubleshootingLink[];
  requiredPermission?: DocumentationPermission;
  keywords: readonly string[];
}

export const dashboardHelpRegistry = [
  {
    id: 'dashboard-overview',
    routePattern: '/dashboard',
    title: 'Workspace readiness',
    summary: 'Choose the next setup or operating action from authoritative workspace state.',
    docRouteId: 'platformOverview',
    commonTasks: [
      { label: 'Complete first-run setup', docRouteId: 'firstEvent' },
      { label: 'Review team access', docRouteId: 'teamPermissions' },
    ],
    troubleshooting: [
      { symptom: 'The workspace is not ready to sell', docRouteId: 'localQuickstart' },
    ],
    keywords: ['setup', 'readiness', 'workspace'],
  },
  {
    id: 'settings-workspace',
    routePattern: '/settings/workspace',
    title: 'Workspace settings',
    summary: 'Configure workspace identity and organization-level settings.',
    docRouteId: 'workspace',
    requiredPermission: 'settings.write',
    commonTasks: [{ label: 'Configure workspace identity', docRouteId: 'workspace' }],
    troubleshooting: [],
    keywords: ['workspace', 'organization', 'settings'],
  },
  {
    id: 'settings-branding',
    routePattern: '/settings/branding',
    title: 'Branding and domains',
    summary: 'Configure customer-facing brand identity and domain behavior.',
    docRouteId: 'brands',
    requiredPermission: 'settings.write',
    commonTasks: [{ label: 'Configure a brand', docRouteId: 'brands' }],
    troubleshooting: [{ symptom: 'Brand changes are not visible', docRouteId: 'brands' }],
    keywords: ['brand', 'domain', 'logo'],
  },
  {
    id: 'settings-members',
    routePattern: '/settings/members',
    title: 'Members and permissions',
    summary: 'Invite teammates and grant only the permissions they need.',
    docRouteId: 'teamPermissions',
    requiredPermission: 'settings.write',
    commonTasks: [{ label: 'Review team access', docRouteId: 'teamPermissions' }],
    troubleshooting: [
      { symptom: 'A teammate cannot complete a task', docRouteId: 'teamPermissions' },
    ],
    keywords: ['member', 'role', 'permission'],
  },
  {
    id: 'settings-payments',
    routePattern: '/settings/payments',
    title: 'Payment readiness',
    summary: 'Choose capture or provider-backed payments and resolve account blockers.',
    docRouteId: 'selfHostingConfiguration',
    requiredPermission: 'settings.write',
    commonTasks: [{ label: 'Complete a test checkout', docRouteId: 'testCheckout' }],
    troubleshooting: [{ symptom: 'The payment account is blocked', docRouteId: 'testCheckout' }],
    keywords: ['payment', 'stripe', 'capture'],
  },
  {
    id: 'settings-appearance',
    routePattern: '/settings/appearance',
    title: 'Dashboard appearance',
    summary: 'Adjust personal display preferences without changing public event branding.',
    docRouteId: 'brands',
    commonTasks: [{ label: 'Configure public branding', docRouteId: 'brands' }],
    troubleshooting: [],
    keywords: ['appearance', 'theme', 'branding'],
  },
  {
    id: 'events',
    routePattern: '/events',
    title: 'Events',
    summary: 'Create, configure, and publish events.',
    docRouteId: 'events',
    requiredPermission: 'events.read',
    commonTasks: [
      { label: 'Create the first event', docRouteId: 'firstEvent' },
      { label: 'Configure schedules', docRouteId: 'eventSchedules' },
    ],
    troubleshooting: [{ symptom: 'An event cannot be published', docRouteId: 'firstEvent' }],
    keywords: ['event', 'publish', 'schedule'],
  },
  {
    id: 'event-tickets',
    routePattern: '/events/:eventId/tickets',
    title: 'Tickets and products',
    summary: 'Create sellable inventory and control availability.',
    docRouteId: 'tickets',
    requiredPermission: 'tickets.write',
    commonTasks: [{ label: 'Configure sellable tickets', docRouteId: 'tickets' }],
    troubleshooting: [{ symptom: 'A ticket is not available at checkout', docRouteId: 'tickets' }],
    keywords: ['ticket', 'product', 'inventory'],
  },
  {
    id: 'event-checkout-form',
    routePattern: '/events/:eventId/checkout-form',
    title: 'Checkout form',
    summary: 'Collect required attendee and consent information.',
    docRouteId: 'checkoutForms',
    requiredPermission: 'events.write',
    commonTasks: [{ label: 'Review checkout fields and consent', docRouteId: 'checkoutForms' }],
    troubleshooting: [
      { symptom: 'Checkout requires an unexpected field', docRouteId: 'checkoutForms' },
    ],
    keywords: ['checkout', 'form', 'consent'],
  },
  {
    id: 'event-products',
    routePattern: '/events/:eventId/products',
    title: 'Products and inventory',
    summary: 'Configure active products, pricing, and availability.',
    docRouteId: 'tickets',
    requiredPermission: 'tickets.write',
    commonTasks: [{ label: 'Configure sellable products', docRouteId: 'tickets' }],
    troubleshooting: [{ symptom: 'A product is missing from checkout', docRouteId: 'tickets' }],
    keywords: ['product', 'inventory', 'price'],
  },
  {
    id: 'event-schedule',
    routePattern: '/events/:eventId/schedule',
    title: 'Event schedule',
    summary: 'Configure occurrences and verify timezone behavior.',
    docRouteId: 'eventSchedules',
    requiredPermission: 'events.write',
    commonTasks: [{ label: 'Configure event timing', docRouteId: 'eventSchedules' }],
    troubleshooting: [{ symptom: 'An event time appears incorrect', docRouteId: 'eventSchedules' }],
    keywords: ['schedule', 'occurrence', 'timezone'],
  },
  {
    id: 'event-attendees',
    routePattern: '/events/:eventId/attendees',
    title: 'Event attendees',
    summary: 'Find scoped attendee records and admission state.',
    docRouteId: 'attendees',
    requiredPermission: 'attendees.read',
    commonTasks: [{ label: 'Find an attendee', docRouteId: 'attendees' }],
    troubleshooting: [{ symptom: 'An attendee is missing', docRouteId: 'attendees' }],
    keywords: ['attendee', 'ticket holder'],
  },
  {
    id: 'event-check-in',
    routePattern: '/events/:eventId/check-in',
    title: 'Event check-in',
    summary: 'Prepare lists and devices for this event.',
    docRouteId: 'checkIn',
    requiredPermission: 'checkins.read',
    commonTasks: [{ label: 'Prepare check-in', docRouteId: 'checkIn' }],
    troubleshooting: [{ symptom: 'A ticket will not scan', docRouteId: 'checkIn' }],
    keywords: ['check-in', 'scanner', 'door'],
  },
  {
    id: 'event-messages',
    routePattern: '/events/:eventId/messages',
    title: 'Event messages',
    summary: 'Create event-scoped lifecycle and campaign messages.',
    docRouteId: 'messages',
    requiredPermission: 'messages.write',
    commonTasks: [{ label: 'Configure messaging', docRouteId: 'messages' }],
    troubleshooting: [{ symptom: 'A message was not delivered', docRouteId: 'messages' }],
    keywords: ['message', 'email', 'sms'],
  },
  {
    id: 'event-content',
    routePattern: '/events/:eventId/content',
    title: 'Event content',
    summary: 'Edit and publish customer-facing event and message content.',
    docRouteId: 'messages',
    requiredPermission: 'events.write',
    commonTasks: [
      { label: 'Review public event content', docRouteId: 'firstEvent' },
      { label: 'Configure messaging content', docRouteId: 'messages' },
    ],
    troubleshooting: [{ symptom: 'Published content is stale', docRouteId: 'checkoutForms' }],
    keywords: ['content', 'editor', 'publish'],
  },
  {
    id: 'event-reports',
    routePattern: '/events/:eventId/reports',
    title: 'Event reports',
    summary: 'Run event-scoped reports and exports.',
    docRouteId: 'reports',
    requiredPermission: 'reports.read',
    commonTasks: [{ label: 'Create an export', docRouteId: 'reports' }],
    troubleshooting: [{ symptom: 'An export did not complete', docRouteId: 'reports' }],
    keywords: ['report', 'export'],
  },
  {
    id: 'orders',
    routePattern: '/orders',
    title: 'Orders and refunds',
    summary: 'Find orders, understand state, and apply safe remediation.',
    docRouteId: 'orders',
    requiredPermission: 'orders.read',
    commonTasks: [
      { label: 'Find an order', docRouteId: 'orders' },
      { label: 'Process a refund', docRouteId: 'refunds' },
    ],
    troubleshooting: [{ symptom: 'A payment and order disagree', docRouteId: 'orders' }],
    keywords: ['order', 'refund', 'payment'],
  },
  {
    id: 'attendees',
    routePattern: '/attendees',
    title: 'Attendees',
    summary: 'Manage attendee records and prepare admission.',
    docRouteId: 'attendees',
    requiredPermission: 'attendees.read',
    commonTasks: [{ label: 'Find an attendee', docRouteId: 'attendees' }],
    troubleshooting: [],
    keywords: ['attendee', 'admission'],
  },
  {
    id: 'check-in',
    routePattern: '/check-in',
    title: 'Check-in',
    summary: 'Configure devices and admit attendees with safe fallback paths.',
    docRouteId: 'checkIn',
    requiredPermission: 'checkins.read',
    commonTasks: [{ label: 'Prepare check-in', docRouteId: 'checkIn' }],
    troubleshooting: [{ symptom: 'A ticket will not scan', docRouteId: 'checkIn' }],
    keywords: ['check-in', 'scan', 'offline'],
  },
  {
    id: 'kiosk',
    routePattern: '/kiosk',
    title: 'Check-in kiosk',
    summary: 'Run focused door operations with the selected event and device scope.',
    docRouteId: 'checkIn',
    requiredPermission: 'checkins.read',
    commonTasks: [{ label: 'Prepare kiosk check-in', docRouteId: 'checkIn' }],
    troubleshooting: [{ symptom: 'The kiosk cannot scan', docRouteId: 'checkIn' }],
    keywords: ['kiosk', 'scanner', 'door'],
  },
  {
    id: 'messages',
    routePattern: '/messages',
    title: 'Messaging',
    summary: 'Create lifecycle and campaign messages with verified sender behavior.',
    docRouteId: 'messages',
    requiredPermission: 'messages.write',
    commonTasks: [{ label: 'Configure messaging', docRouteId: 'messages' }],
    troubleshooting: [{ symptom: 'A message was not delivered', docRouteId: 'messages' }],
    keywords: ['email', 'sms', 'message'],
  },
  {
    id: 'reports',
    routePattern: '/reports',
    title: 'Reports and exports',
    summary: 'Run operational reports and diagnose exports.',
    docRouteId: 'reports',
    requiredPermission: 'reports.read',
    commonTasks: [{ label: 'Create an export', docRouteId: 'reports' }],
    troubleshooting: [{ symptom: 'An export did not complete', docRouteId: 'reports' }],
    keywords: ['report', 'export'],
  },
  {
    id: 'developer',
    routePattern: '/developer',
    title: 'Developer console',
    summary: 'Create a safe first integration and inspect integration health.',
    docRouteId: 'firstApiCall',
    requiredPermission: 'developers.write',
    commonTasks: [
      { label: 'Make the first API call', docRouteId: 'firstApiCall' },
      { label: 'Choose an SDK', docRouteId: 'sdkJavaScript' },
    ],
    troubleshooting: [{ symptom: 'The API rejected a request', docRouteId: 'apiErrors' }],
    keywords: ['api', 'sdk', 'integration'],
  },
  {
    id: 'developer-api-keys',
    routePattern: '/developer/api-keys',
    title: 'API keys',
    summary: 'Create narrowly scoped server-only credentials and rotate them safely.',
    docRouteId: 'apiAuthentication',
    requiredPermission: 'developers.write',
    commonTasks: [
      { label: 'Create a scoped API key', docRouteId: 'apiAuthentication' },
      { label: 'Review API permissions', docRouteId: 'apiPermissions' },
    ],
    troubleshooting: [{ symptom: 'A request is unauthorized', docRouteId: 'apiAuthentication' }],
    keywords: ['api key', 'scope', 'secret'],
  },
  {
    id: 'developer-webhooks',
    routePattern: '/developer/webhooks',
    title: 'Webhooks',
    summary: 'Configure endpoints, verify signatures, and diagnose delivery failures.',
    docRouteId: 'webhookSetup',
    requiredPermission: 'developers.write',
    commonTasks: [
      { label: 'Configure an endpoint', docRouteId: 'webhookSetup' },
      { label: 'Verify signatures', docRouteId: 'webhookVerification' },
    ],
    troubleshooting: [{ symptom: 'A delivery failed', docRouteId: 'webhookTroubleshooting' }],
    keywords: ['webhook', 'signature', 'replay'],
  },
] as const satisfies readonly DashboardHelpEntry[];

function routePatternMatches(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  if (patternSegments.length > pathSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment.startsWith(':') || segment === pathSegments[index],
  );
}

export function helpForPath(pathname: string): DashboardHelpEntry | undefined {
  let match: DashboardHelpEntry | undefined;
  for (const entry of dashboardHelpRegistry) {
    if (
      routePatternMatches(entry.routePattern, pathname) &&
      (match === undefined || entry.routePattern.length > match.routePattern.length)
    ) {
      match = entry;
    }
  }
  return match;
}

export function filterHelpByPermissions(
  entries: readonly DashboardHelpEntry[],
  permissions: ReadonlySet<string>,
): DashboardHelpEntry[] {
  return entries.filter(
    (entry) => !entry.requiredPermission || permissions.has(entry.requiredPermission),
  );
}
