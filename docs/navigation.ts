import type { DocRouteId } from '../packages/docs-core/src/routes.ts';

export interface DocumentationNavigationItem {
  label: string;
  routeId?: DocRouteId;
  children?: readonly DocumentationNavigationItem[];
}

export const documentationNavigation = [
  {
    label: 'Choose how to use Tixkit',
    children: [
      { label: 'Sell tickets with Tixkit', routeId: 'sellTickets' },
      { label: 'Add ticketing to my product', routeId: 'platformApi' },
      { label: 'Run Tixkit on my infrastructure', routeId: 'selfHosted' },
    ],
  },
  {
    label: 'Sell tickets with Tixkit',
    children: [
      { label: 'Cloud organizer quickstart', routeId: 'sellQuickstart' },
      { label: 'Create the first event', routeId: 'firstEvent' },
      { label: 'Complete a test checkout', routeId: 'testCheckout' },
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
      { label: 'Platform API quickstart', routeId: 'platformQuickstart' },
      { label: 'Make the first API call', routeId: 'firstApiCall' },
      { label: 'API fundamentals', routeId: 'apiFundamentals' },
      { label: 'Authentication', routeId: 'apiAuthentication' },
      { label: 'Permissions and scopes', routeId: 'apiPermissions' },
      { label: 'Errors and retries', routeId: 'apiErrors' },
      { label: 'Pagination', routeId: 'apiPagination' },
      { label: 'Idempotency', routeId: 'apiIdempotency' },
      { label: 'Agent Platform API', routeId: 'platformAgents' },
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
      {
        label: 'Adopt 2026-07-19 agent controls',
        routeId: 'apiMigration20260718To20260719',
      },
      {
        label: 'Adopt 2026-07-20 agent memory',
        routeId: 'apiMigration20260719To20260720',
      },
      {
        label: 'Adopt 2026-07-21 agent authentication',
        routeId: 'apiMigration20260720To20260721',
      },
      {
        label: 'Adopt 2026-07-22 agent action preparation',
        routeId: 'apiMigration20260721To20260722',
      },
      {
        label: 'Adopt 2026-07-23 human agent approval',
        routeId: 'apiMigration20260722To20260723',
      },
      {
        label: 'Adopt 2026-07-24 agent approval revocation',
        routeId: 'apiMigration20260723To20260724',
      },
      {
        label: 'Adopt 2026-07-25 approved agent execution',
        routeId: 'apiMigration20260724To20260725',
      },
      {
        label: 'Adopt 2026-07-26 agent execution evidence',
        routeId: 'apiMigration20260725To20260726',
      },
      {
        label: 'Adopt 2026-07-27 durable agent plans',
        routeId: 'apiMigration20260726To20260727',
      },
      {
        label: 'Adopt 2026-07-28 plan-bound execution',
        routeId: 'apiMigration20260727To20260728',
      },
      {
        label: 'Adopt 2026-07-29 direct readiness reads',
        routeId: 'apiMigration20260728To20260729',
      },
      {
        label: 'Adopt 2026-07-30 direct event reads',
        routeId: 'apiMigration20260729To20260730',
      },
      {
        label: 'Adopt 2026-07-31 direct event preparation',
        routeId: 'apiMigration20260730To20260731',
      },
      { label: 'Accessibility', routeId: 'accessibility' },
      { label: 'Performance', routeId: 'performance' },
      { label: 'Privacy and retention', routeId: 'privacyAndRetention' },
    ],
  },
  {
    label: 'Run Tixkit on my infrastructure',
    children: [
      { label: 'Choose a deployment model', routeId: 'deploymentModel' },
      { label: 'Local quickstart', routeId: 'localQuickstart' },
      { label: 'Shared platform overview', routeId: 'platformOverview' },
      { label: 'Architecture', routeId: 'selfHostingArchitecture' },
      { label: 'Compact profile', routeId: 'selfHostingCompact' },
      { label: 'Configuration', routeId: 'selfHostingConfiguration' },
      { label: 'Authentication', routeId: 'selfHostingAuthentication' },
      { label: 'Databases', routeId: 'selfHostingDatabases' },
      { label: 'Microsoft SQL Server status', routeId: 'selfHostingMssqlStatus' },
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
      { label: 'Event page Puck contract', routeId: 'contributorEventPageContract' },
      { label: 'Support', routeId: 'support' },
    ],
  },
] as const satisfies readonly DocumentationNavigationItem[];
