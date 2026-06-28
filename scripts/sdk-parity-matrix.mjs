#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const apiVersion = '2026-01-01';

const checks = [
  {
    platform: 'JavaScript',
    file: 'packages/sdk-js/src/index.ts',
    patterns: [
      "TIXKIT_API_VERSION = '2026-01-01'",
      'CheckoutResource',
      'async conversion',
      'X-Tixkit-Version',
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
    ],
  },
  {
    platform: 'React Native',
    file: 'packages/sdk-react-native/src/index.ts',
    patterns: [
      "TIXKIT_API_VERSION = '2026-01-01'",
      'checkoutHandoffUrl',
      'createTixkitReactNativeComponents',
      'createTixkitSecureStorage',
      'manifestSigningKey',
      'onSyncConflict',
      'syncScans',
    ],
  },
  {
    platform: 'Flutter',
    file: 'packages/sdk-flutter/lib/tixkit_flutter.dart',
    patterns: [
      "tixkitApiVersion = '2026-01-01'",
      'tixkitCheckoutHandoffUri',
      'TixkitTicketCard',
      'TixkitScannerClient',
      'verifyManifestSignature',
      'onSyncConflict',
      'syncScans',
    ],
  },
  {
    platform: 'iOS',
    file: 'packages/sdk-ios/Sources/TixkitIOS/TixkitIOS.swift',
    patterns: [
      'TixkitAPIVersion = "2026-01-01"',
      'TixkitCheckoutHandoffOptions',
      'TixkitTicketCard',
      'TixkitScannerClient',
      'verifyManifestSignature',
      'onSyncConflict',
      'syncScans',
    ],
  },
  {
    platform: 'Android',
    file: 'packages/sdk-android/sdk/src/main/java/com/tixkit/sdk/TixkitAndroid.kt',
    patterns: [
      'API_VERSION = "2026-01-01"',
      'TixkitCheckoutOptions',
      'TixkitTicketDisplayView',
      'TixkitScannerClient',
      'verifyTixkitOfflineManifest',
      'onConflict',
      'syncScans',
    ],
  },
];

const guides = [
  'docs/sdk-guides/javascript.md',
  'docs/sdk-guides/nextjs.md',
  'docs/sdk-guides/sveltekit.md',
  'docs/sdk-guides/react-native.md',
  'docs/sdk-guides/flutter.md',
  'docs/sdk-guides/ios.md',
  'docs/sdk-guides/android.md',
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

for (const guide of guides) {
  try {
    const body = read(guide);
    assert(statSync(join(root, guide)).size > 0, `${guide} is empty`);
    assert(body.includes(apiVersion), `${guide} does not pin API version ${apiVersion}`);
    assert(body.includes('Validation'), `${guide} is missing a Validation section`);
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
    'npm pack --dry-run',
    'flutter pub publish --dry-run',
    'swift test',
    ':sdk:publishToMavenLocal',
    'sdk-parity-matrix.mjs',
    'actions/upload-artifact@v4',
    'sdk-release-provenance',
  ]) {
    assert(workflow.includes(pattern), `SDK release dry-run workflow is missing ${pattern}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error('SDK parity matrix failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `SDK parity matrix passed for ${checks.length} platforms at API version ${apiVersion}.`,
);
