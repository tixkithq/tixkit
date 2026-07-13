#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { validateSdkParity } from './lib/sdk-parity.mjs';

const root = new URL('..', import.meta.url).pathname;
const apiVersion = '2026-07-13';
const distribution = JSON.parse(
  readFileSync(new URL('../distribution/public-distribution.json', import.meta.url), 'utf8'),
);

const checks = [
  {
    platform: 'JavaScript',
    file: 'packages/sdk-js/src/index.ts',
    patterns: [
      `TIXKIT_API_VERSION = '${apiVersion}'`,
      'CheckoutResource',
      'async conversion',
      'X-Tixkit-Version',
      'getEventPage',
      'getEventPageBySlug',
      'getEventDiscoveryCard',
      'createTicketResaleListing',
      'listResaleListings',
      'createResaleListing',
      'delistResaleListing',
      'completeResaleListing',
      'TicketListing',
      'TicketResaleCompletion',
      'RefundQueued',
      'CreateRefundInput',
      'voidTickets',
      'restoreInventory',
      '/orders/${orderId}/refunds',
      'X-Checkout-Session-Token',
      'Idempotency-Key',
      '/check-ins/scan',
      'getEventBySlug',
      'getCheckoutBootstrap',
      'getEventPageBootstrap',
      'getEventPageBootstrapBySlug',
      '/public/events/by-slug/${slug}',
      '/public/events/${eventId}/bootstrap',
      '/public/events/${eventId}/page-bootstrap',
      '/public/events/by-slug/${slug}/page-bootstrap',
    ],
  },
  {
    platform: 'Next.js',
    file: 'packages/sdk-next/src/server.ts',
    patterns: [
      'TIXKIT_API_VERSION',
      'createTixkitClient',
      'createTixkitWebhookRouteHandler',
      'createCheckoutSessionRouteHandler',
      'loadPublicEventPage',
      'loadPublicEventPageBySlug',
      'loadPublicEventDiscoveryCard',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
    ],
  },
  {
    platform: 'SvelteKit',
    file: 'packages/sdk-sveltekit/src/server.ts',
    patterns: [
      'TIXKIT_API_VERSION',
      'createTixkitClient',
      'verifyTixkitWebhook',
      'createCheckoutFormAction',
      'loadPublicEventPage',
      'loadPublicEventPageBySlug',
      'loadPublicEventDiscoveryCard',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
    ],
  },
  {
    platform: 'Vue',
    file: 'packages/sdk-vue/src/server.ts',
    patterns: [
      'TIXKIT_API_VERSION',
      'createTixkitClient',
      'verifyTixkitWebhook',
      'createCheckoutFormAction',
      'loadPublicEventPage',
      'loadPublicEventPageBySlug',
      'loadPublicEventDiscoveryCard',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
    ],
  },
  {
    platform: 'Astro',
    file: 'packages/sdk-astro/src/server.ts',
    patterns: [
      'TIXKIT_API_VERSION',
      'createTixkitClient',
      'verifyTixkitWebhook',
      'createCheckoutFormAction',
      'loadPublicEventPage',
      'loadPublicEventPageBySlug',
      'loadPublicEventDiscoveryCard',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
    ],
  },
  {
    platform: 'Remix',
    file: 'packages/sdk-remix/src/server.ts',
    patterns: [
      'TIXKIT_API_VERSION',
      'createTixkitClient',
      'verifyTixkitWebhook',
      'createCheckoutFormAction',
      'loadPublicEventPage',
      'loadPublicEventPageBySlug',
      'loadPublicEventDiscoveryCard',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
    ],
  },
  {
    platform: 'React Native',
    file: 'packages/sdk-react-native/src/index.ts',
    patterns: [
      `TIXKIT_API_VERSION = '${apiVersion}'`,
      'checkoutHandoffUrl',
      'createTixkitReactNativeComponents',
      'createTixkitSecureStorage',
      'manifestSigningKey',
      'onSyncConflict',
      'syncScans',
      'TixkitPublicEventPageClient',
      'getEventPageBySlug',
      'getEventDiscoveryCard',
      'TixkitResaleClient',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
      'TicketListing',
      'TicketResaleCompletion',
    ],
  },
  {
    platform: 'Flutter',
    file: 'packages/sdk-flutter/lib/tixkit_flutter.dart',
    patterns: [
      `tixkitApiVersion = '${apiVersion}'`,
      'tixkitCheckoutHandoffUri',
      'TixkitTicketCard',
      'TixkitScannerClient',
      'verifyManifestSignature',
      'onSyncConflict',
      'syncScans',
      'TixkitPublicEventPageClient',
      'getEventPageBySlug',
      'getEventDiscoveryCard',
      'TixkitResaleClient',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
      'TixkitTicketListing',
      'TixkitResaleCompletion',
    ],
  },
  {
    platform: 'iOS',
    file: 'packages/sdk-ios/Sources/TixkitIOS/TixkitIOS.swift',
    patterns: [
      `TixkitAPIVersion = "${apiVersion}"`,
      'TixkitCheckoutHandoffOptions',
      'TixkitTicketCard',
      'TixkitScannerClient',
      'verifyManifestSignature',
      'onSyncConflict',
      'syncScans',
      'TixkitPublicEventPageClient',
      'getEventPageBySlug',
      'getEventDiscoveryCard',
      'TixkitResaleClient',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
      'TixkitTicketListing',
      'TixkitResaleCompletion',
    ],
  },
  {
    platform: 'Android',
    file: 'packages/sdk-android/sdk/src/main/java/com/tixkit/sdk/TixkitAndroid.kt',
    patterns: [
      `API_VERSION = "${apiVersion}"`,
      'TixkitCheckoutOptions',
      'TixkitTicketDisplayView',
      'TixkitScannerClient',
      'verifyTixkitOfflineManifest',
      'onConflict',
      'syncScans',
      'TixkitPublicEventPageClient',
      'getEventPageBySlug',
      'getEventDiscoveryCard',
      'TixkitResaleClient',
      'listResaleListings',
      'createTicketResaleListing',
      'createCheckoutTicketResaleListing',
      'delistResaleListing',
      'completeResaleListing',
      'TixkitTicketListing',
      'TixkitResaleCompletion',
    ],
  },
  {
    platform: 'Rust',
    file: 'packages/sdk-rust/src/lib.rs',
    patterns: [
      `TIXKIT_API_VERSION: &str = "${apiVersion}"`,
      'TixkitClientBuilder',
      'create_box_office_order',
      'Idempotency-Key',
      'verify_tixkit_webhook',
      'PageParams',
      'PublicResource',
      'get_event_page_by_slug',
      'get_event_discovery_card',
      'TicketResource',
      'tickets',
      'list_resale_listings',
      'create_ticket_resale_listing',
      'create_resale_listing',
      'delist_resale_listing',
      'complete_resale_listing',
      'TicketListing',
      'TicketResaleCompletion',
      'RefundQueued',
      'CreateRefund',
      'pub async fn refund',
      '/orders/{order_id}/refunds',
      'void_tickets',
      'restore_inventory',
      'X-Checkout-Session-Token',
      'Idempotency-Key',
    ],
  },
  {
    platform: 'Go',
    file: 'packages/sdk-go/services.go',
    patterns: [
      'PublicService',
      'GetEventPage',
      'GetContentPage',
      'GetEventPageBySlug',
      'GetEventDiscoveryCard',
      'TicketsService',
      'ListResaleListings',
      'CreateTicketResaleListing',
      'CreateResaleListing',
      'DelistResaleListing',
      'CompleteResaleListing',
      'X-Checkout-Session-Token',
      'withIdempotencyKey',
      'func (s *OrdersService) Refund',
      '"/orders/"+escape(orderID)+"/refunds"',
    ],
  },
  {
    platform: 'Go Client',
    file: 'packages/sdk-go/client.go',
    patterns: [
      `APIVersion = "${apiVersion}"`,
      'NewClient',
      'X-Tixkit-Version',
      'Idempotency-Key',
      'Public',
      'Tickets',
    ],
  },
  {
    platform: 'Go Resale Types',
    file: 'packages/sdk-go/types.go',
    patterns: [
      'TicketListing',
      'TicketResaleCompletion',
      'CreateCheckoutTicketResaleListingRequest',
      'RefundQueued',
      'RestoreInventory',
      'VoidTickets',
    ],
  },
  {
    platform: 'Go Webhooks',
    file: 'packages/sdk-go/webhook.go',
    patterns: ['VerifyWebhookSignature', 'WebhookSignatureHeader', 't=%d,v1=%s'],
  },
];

const npmIgnores = [
  'packages/sdk-js/.npmignore',
  'packages/sdk-next/.npmignore',
  'packages/sdk-sveltekit/.npmignore',
  'packages/sdk-react-native/.npmignore',
];

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const failures = [];

const manifestSdkPaths = new Set(
  distribution.release.packages
    .map((entry) => entry.path)
    .filter((path) => path.startsWith('packages/sdk-')),
);
const checkedSdkPaths = new Set(checks.map((check) => check.file.split('/').slice(0, 2).join('/')));
for (const sdkPath of manifestSdkPaths) {
  if (!checkedSdkPaths.has(sdkPath))
    failures.push(`Distribution SDK lacks parity checks: ${sdkPath}`);
}
for (const sdkPath of checkedSdkPaths) {
  if (!manifestSdkPaths.has(sdkPath))
    failures.push(`Parity SDK is absent from distribution: ${sdkPath}`);
}

for (const check of checks) {
  try {
    const source = read(check.file);
    for (const pattern of check.patterns) {
      assert(source.includes(pattern), `${check.platform} is missing ${pattern} in ${check.file}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

for (const ignoreFile of npmIgnores) {
  try {
    const body = read(ignoreFile);
    assert(body.includes('src/'), `${ignoreFile} must exclude source tests from release tarballs`);
    assert(body.includes('!dist/**'), `${ignoreFile} must include built dist artifacts`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

try {
  const workflow = read('.github/workflows/sdk-release-dry-run.yml');
  for (const pattern of [
    'release:public:npm:dry-run',
    'flutter pub publish --dry-run',
    'swift test',
    ':sdk:publishToMavenLocal',
    'sdk-parity-matrix.mjs',
    'actions/upload-artifact@',
    'sdk-release-provenance',
    'if-no-files-found: error',
  ]) {
    assert(workflow.includes(pattern), `SDK release dry-run workflow is missing ${pattern}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

try {
  const program = [
    "import { sdkSnippetRegistry } from './packages/docs-core/src/sdk-snippets.ts';",
    "import { docRoutes } from './packages/docs-core/src/routes.ts';",
    'process.stdout.write(JSON.stringify({ sdkSnippetRegistry, docRoutes }));',
  ].join(' ');
  const shared = JSON.parse(
    execFileSync('bun', ['--eval', program], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const parity = validateSdkParity({
    root,
    registry: shared.sdkSnippetRegistry,
    docRoutes: shared.docRoutes,
  });
  failures.push(...parity.failures);
} catch (error) {
  failures.push(
    `Shared SDK registry validation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (failures.length > 0) {
  console.error('SDK parity matrix failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `SDK parity matrix passed for ${checks.length} source checks and 12 supported SDK contracts at API version ${apiVersion}.`,
);
