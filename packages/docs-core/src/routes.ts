export const docRoutes = {
  home: '/',
  platformOverview: '/getting-started/platform-overview',
  deploymentModel: '/getting-started/deployment-model',
  localQuickstart: '/getting-started/local-quickstart',
  firstEvent: '/getting-started/first-event',
  testCheckout: '/getting-started/test-checkout',
  firstApiCall: '/getting-started/first-api-call',
  workspace: '/operators/workspace',
  brands: '/operators/brands',
  events: '/operators/events',
  eventSchedules: '/operators/events/schedules',
  tickets: '/operators/events/tickets-and-products',
  checkoutForms: '/operators/events/checkout-forms',
  orders: '/operators/orders',
  refunds: '/operators/orders/refunds',
  attendees: '/operators/attendees',
  checkIn: '/operators/check-in',
  boxOffice: '/operators/box-office',
  messages: '/operators/messaging',
  reports: '/operators/reports-and-exports',
  teamPermissions: '/operators/team-and-permissions',
  migrationOperations: '/operators/migration-operations',
  migrationGenericCsv: '/operators/migrations/generic-csv',
  migrationPretix: '/operators/migrations/pretix',
  migrationHiEvents: '/operators/migrations/hi-events',
  migrationEventbrite: '/operators/migrations/eventbrite',
  migrationTicketTailor: '/operators/migrations/ticket-tailor',
  migrationBespokeAdapters: '/operators/migrations/bespoke-adapters',
  sandboxOperations: '/operators/sandbox-operations',
  apiFundamentals: '/developers/api-fundamentals',
  apiAuthentication: '/developers/api-fundamentals/authentication',
  apiPermissions: '/developers/api-fundamentals/permissions',
  apiErrors: '/developers/api-fundamentals/errors',
  apiPagination: '/developers/api-fundamentals/pagination',
  apiIdempotency: '/developers/api-fundamentals/idempotency',
  webhookSetup: '/developers/webhooks/setup',
  webhookVerification: '/developers/webhooks/verify-signatures',
  webhookTesting: '/developers/webhooks/testing',
  webhookTroubleshooting: '/developers/webhooks/troubleshooting',
  widgetEmbedding: '/developers/widget/embedding',
  apiReference: '/reference/api',
  apiSchemas: '/reference/api/schemas',
  webhookEvents: '/reference/webhook-events',
  apiVersions: '/reference/api-versions',
  apiReleaseTrain: '/reference/api-release-train',
  accessibility: '/reference/accessibility',
  performance: '/reference/performance',
  privacyAndRetention: '/reference/privacy-and-retention',
  sdkJavaScript: '/sdks/javascript',
  sdkNext: '/sdks/nextjs',
  sdkSvelteKit: '/sdks/sveltekit',
  sdkVue: '/sdks/vue-and-nuxt',
  sdkAstro: '/sdks/astro',
  sdkRemix: '/sdks/remix',
  sdkReactNative: '/sdks/react-native',
  sdkFlutter: '/sdks/flutter',
  sdkIos: '/sdks/ios',
  sdkAndroid: '/sdks/android',
  sdkGo: '/sdks/go',
  sdkRust: '/sdks/rust',
  selfHostingArchitecture: '/self-hosting/architecture',
  selfHostingCompact: '/self-hosting/compact',
  selfHostingConfiguration: '/self-hosting/configuration',
  selfHostingAuthentication: '/self-hosting/authentication',
  selfHostingDatabases: '/self-hosting/databases',
  selfHostingStorage: '/self-hosting/object-storage',
  selfHostingDeployment: '/self-hosting/deployment',
  selfHostingObservability: '/self-hosting/observability',
  backups: '/self-hosting/backups-and-restore',
  upgrades: '/self-hosting/upgrades',
  temporalOperations: '/operations/temporal',
  incidentRunbooks: '/operations/incidents',
  contributorSetup: '/contributing/repository-setup',
  contributorArchitecture: '/contributing/architecture',
  contributorTesting: '/contributing/testing',
  addApiRoute: '/contributing/add-an-api-route',
  addSdkOperation: '/contributing/add-an-sdk-operation',
  addDocumentation: '/contributing/add-documentation',
  support: '/support',
} as const;

export type DocRouteId = keyof typeof docRoutes;
export type DocRoute = (typeof docRoutes)[DocRouteId];

const routeEntries = Object.entries(docRoutes) as ReadonlyArray<[DocRouteId, DocRoute]>;
export const docRouteIds = routeEntries.map(([id]) => id);
export const canonicalDocRoutes = routeEntries.map(([, path]) => path);

export function isDocRouteId(value: string): value is DocRouteId {
  return Object.hasOwn(docRoutes, value);
}

export function docPath(routeId: DocRouteId): DocRoute {
  return docRoutes[routeId];
}

export function resolveDocUrl(routeId: DocRouteId, docsOrigin?: string): string {
  const path = docPath(routeId);
  if (docsOrigin === undefined || docsOrigin.trim() === '') return path;

  let origin: URL;
  try {
    origin = new URL(docsOrigin);
  } catch {
    throw new Error(`Invalid documentation origin: ${docsOrigin}`);
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error(
      `Documentation origin must be an HTTP(S) origin without credentials: ${docsOrigin}`,
    );
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(`Documentation origin must not include a path, query, or hash: ${docsOrigin}`);
  }
  return new URL(path, origin).toString();
}
