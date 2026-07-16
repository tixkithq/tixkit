import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const sourceExtension = /\.(?:cjs|js|jsx|mjs|mts|ts|tsx)$/u;
const ignoredSegment =
  /(?:^|\/)(?:__tests__|dist|fixtures|generated|node_modules|test-results)(?:\/|$)/u;
const testFile = /(?:^|\/)[^/]+\.(?:integration\.)?(?:spec|test)\.[^.]+$/u;
const stripeSdk = /(?:from\s+['"]stripe['"]|require\(\s*['"]stripe['"]\s*\)|new\s+Stripe\s*\()/u;
const migratedProviderEndpoint =
  /https:\/\/(?:api\.resend\.com|api\.telnyx\.com|api\.twilio\.com|rest\.nexmo\.com|api\.vonage\.com|api\.plivo\.com)(?:[/'"`]|$)/u;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      ['__tests__', 'dist', 'fixtures', 'generated', 'node_modules', 'test-results'].includes(
        entry.name,
      )
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function normalizedRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function isRuntimeSource(path) {
  return sourceExtension.test(path) && !ignoredSegment.test(path) && !testFile.test(path);
}

function stripeSdkAllowed(path) {
  return (
    path.startsWith('packages/provider-clients/') ||
    path === 'packages/api/src/routes/modules/stripe-webhooks.ts'
  );
}

function migratedEndpointAllowed(path) {
  return path.startsWith('packages/provider-clients/');
}

export function providerClientBoundaryViolations(
  root,
  { sourceRoots = ['apps', 'packages'] } = {},
) {
  const repositoryRoot = resolve(root);
  const violations = [];
  for (const sourceRoot of sourceRoots) {
    const absoluteRoot = resolve(repositoryRoot, sourceRoot);
    let files;
    try {
      files = walk(absoluteRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const absolutePath of files) {
      const path = normalizedRelative(repositoryRoot, absolutePath);
      if (!isRuntimeSource(path)) continue;
      const source = readFileSync(absolutePath, 'utf8');
      if (!stripeSdkAllowed(path) && stripeSdk.test(source)) {
        violations.push(
          `${path}: server-side Stripe SDK execution must cross @tixkit/provider-clients`,
        );
      }
      if (!migratedEndpointAllowed(path) && migratedProviderEndpoint.test(source)) {
        violations.push(
          `${path}: migrated messaging provider endpoints must be owned by @tixkit/provider-clients`,
        );
      }
    }
  }
  return violations.sort();
}
