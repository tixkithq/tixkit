import type { DocRouteId } from '../packages/docs-core/src/routes.ts';

export interface DocumentationNavigationItem {
  label: string;
  routeId?: DocRouteId;
  children?: readonly DocumentationNavigationItem[];
}

export const documentationNavigation = [
  {
    label: 'Getting Started',
    children: [
      { label: 'Sell tickets with Tixkit', routeId: 'sellTickets' },
      { label: 'Cloud organizer quickstart', routeId: 'sellQuickstart' },
      { label: 'Add ticketing to my product', routeId: 'platformApi' },
      { label: 'Platform API quickstart', routeId: 'platformQuickstart' },
      { label: 'Run Tixkit on my infrastructure', routeId: 'selfHosted' },
      { label: 'Platform overview', routeId: 'platformOverview' },
      { label: 'Choose a deployment model', routeId: 'deploymentModel' },
      { label: 'Local quickstart', routeId: 'localQuickstart' },
      { label: 'Create the first event', routeId: 'firstEvent' },
      { label: 'Complete a test checkout', routeId: 'testCheckout' },
      { label: 'Make the first API call', routeId: 'firstApiCall' },
    ],
  },
  {
    label: 'Sell tickets with Tixkit',
    children: [
      { label: 'Workspace and organizations', routeId: 'workspace' },
      { label: 'Brands and domains', routeId: 'brands' },
      { label: 'Events', routeId: 'events' },
      { label: 'Schedules', routeId: 'eventSchedules' },
      { label: 'Tickets and products', routeId: 'tickets' },
      { label: 'Checkout forms', routeId: 'checkoutForms' },
      { label: 'Orders', routeId: 'orders' },
      { label: 'Refunds', routeId: 'refunds' },
      { label: 'Attendees', routeId: 'attendees' },
      { label: 'Check-in', routeId: 'checkIn' },
      { label: 'Box office', routeId: 'boxOffice' },
      { label: 'Messaging', routeId: 'messages' },
      { label: 'Reports and exports', routeId: 'reports' },
      { label: 'Team and permissions', routeId: 'teamPermissions' },
      {
        label: 'Migrations',
        routeId: 'migrationOperations',
        children: [
          { label: 'Generic CSV', routeId: 'migrationGenericCsv' },
          { label: 'pretix', routeId: 'migrationPretix' },
          { label: 'Hi.Events', routeId: 'migrationHiEvents' },
          { label: 'Eventbrite', routeId: 'migrationEventbrite' },
          { label: 'Ticket Tailor', routeId: 'migrationTicketTailor' },
          { label: 'Bespoke adapters', routeId: 'migrationBespokeAdapters' },
        ],
      },
      { label: 'Sandbox operations', routeId: 'sandboxOperations' },
    ],
  },
  {
    label: 'Add ticketing to my product',
    children: [
      { label: 'API fundamentals', routeId: 'apiFundamentals' },
      { label: 'Authentication', routeId: 'apiAuthentication' },
      { label: 'Permissions and scopes', routeId: 'apiPermissions' },
      { label: 'Errors and retries', routeId: 'apiErrors' },
      { label: 'Pagination', routeId: 'apiPagination' },
      { label: 'Idempotency', routeId: 'apiIdempotency' },
      { label: 'Configure webhooks', routeId: 'webhookSetup' },
      { label: 'Verify signatures', routeId: 'webhookVerification' },
      { label: 'Test webhooks', routeId: 'webhookTesting' },
      { label: 'Troubleshoot webhooks', routeId: 'webhookTroubleshooting' },
      { label: 'Embed the widget', routeId: 'widgetEmbedding' },
    ],
  },
  {
    label: 'SDKs',
    children: [
      { label: 'JavaScript', routeId: 'sdkJavaScript' },
      { label: 'Next.js', routeId: 'sdkNext' },
      { label: 'SvelteKit', routeId: 'sdkSvelteKit' },
      { label: 'Vue and Nuxt', routeId: 'sdkVue' },
      { label: 'Astro', routeId: 'sdkAstro' },
      { label: 'Remix', routeId: 'sdkRemix' },
      { label: 'React Native', routeId: 'sdkReactNative' },
      { label: 'Flutter', routeId: 'sdkFlutter' },
      { label: 'iOS', routeId: 'sdkIos' },
      { label: 'Android', routeId: 'sdkAndroid' },
      { label: 'Go', routeId: 'sdkGo' },
      { label: 'Rust', routeId: 'sdkRust' },
    ],
  },
  {
    label: 'API Reference',
    children: [
      { label: 'Endpoints', routeId: 'apiReference' },
      { label: 'Schemas', routeId: 'apiSchemas' },
      { label: 'Webhook events', routeId: 'webhookEvents' },
      { label: 'Versions', routeId: 'apiVersions' },
      { label: 'API release train', routeId: 'apiReleaseTrain' },
      {
        label: 'Migrate 2026-01-01 to 2026-07-12',
        routeId: 'apiMigration20260101To20260712',
      },
      {
        label: 'Migrate 2026-07-13 to 2026-07-14',
        routeId: 'apiMigration20260713To20260714',
      },
      {
        label: 'Migrate 2026-07-14 to 2026-07-15',
        routeId: 'apiMigration20260714To20260715',
      },
      {
        label: 'Migrate 2026-07-15 to 2026-07-16',
        routeId: 'apiMigration20260715To20260716',
      },
      {
        label: 'Adopt 2026-07-17 delta exports',
        routeId: 'apiMigration20260716To20260717',
      },
      {
        label: 'Adopt 2026-07-18 import intake',
        routeId: 'apiMigration20260717To20260718',
      },
      { label: 'Accessibility', routeId: 'accessibility' },
      { label: 'Performance', routeId: 'performance' },
      { label: 'Privacy and retention', routeId: 'privacyAndRetention' },
    ],
  },
  {
    label: 'Run Tixkit on my infrastructure',
    children: [
      { label: 'Architecture', routeId: 'selfHostingArchitecture' },
      { label: 'Compact profile', routeId: 'selfHostingCompact' },
      { label: 'Configuration', routeId: 'selfHostingConfiguration' },
      { label: 'Authentication', routeId: 'selfHostingAuthentication' },
      { label: 'Databases', routeId: 'selfHostingDatabases' },
      { label: 'Object storage', routeId: 'selfHostingStorage' },
      { label: 'Deployment', routeId: 'selfHostingDeployment' },
      { label: 'Production profile', routeId: 'selfHostingProduction' },
      { label: 'Observability', routeId: 'selfHostingObservability' },
      { label: 'Backups and restore', routeId: 'backups' },
      { label: 'Upgrades', routeId: 'upgrades' },
      { label: 'Temporal operations', routeId: 'temporalOperations' },
      { label: 'Incident runbooks', routeId: 'incidentRunbooks' },
    ],
  },
  {
    label: 'Contribute',
    children: [
      { label: 'Repository setup', routeId: 'contributorSetup' },
      { label: 'Architecture', routeId: 'contributorArchitecture' },
      { label: 'Testing', routeId: 'contributorTesting' },
      { label: 'Add an API route', routeId: 'addApiRoute' },
      { label: 'Add an SDK operation', routeId: 'addSdkOperation' },
      { label: 'Add documentation', routeId: 'addDocumentation' },
      { label: 'Support', routeId: 'support' },
    ],
  },
] as const satisfies readonly DocumentationNavigationItem[];
