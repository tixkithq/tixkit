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
      { label: 'Platform overview', routeId: 'platformOverview' },
      { label: 'Choose a deployment model', routeId: 'deploymentModel' },
      { label: 'Local quickstart', routeId: 'localQuickstart' },
      { label: 'Create the first event', routeId: 'firstEvent' },
      { label: 'Complete a test checkout', routeId: 'testCheckout' },
      { label: 'Make the first API call', routeId: 'firstApiCall' },
    ],
  },
  {
    label: 'Operate Tixkit',
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
    label: 'Build with Tixkit',
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
      { label: 'Accessibility', routeId: 'accessibility' },
      { label: 'Performance', routeId: 'performance' },
      { label: 'Privacy and retention', routeId: 'privacyAndRetention' },
    ],
  },
  {
    label: 'Self-Host',
    children: [
      { label: 'Architecture', routeId: 'selfHostingArchitecture' },
      { label: 'Compact profile', routeId: 'selfHostingCompact' },
      { label: 'Configuration', routeId: 'selfHostingConfiguration' },
      { label: 'Authentication', routeId: 'selfHostingAuthentication' },
      { label: 'Databases', routeId: 'selfHostingDatabases' },
      { label: 'Object storage', routeId: 'selfHostingStorage' },
      { label: 'Deployment', routeId: 'selfHostingDeployment' },
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
