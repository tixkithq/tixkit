import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SDK_API_VERSION = '2026-07-26';

export const sdkParityCatalog = [
  {
    id: 'javascript',
    packageName: '@tixkit/js',
    packagePath: 'packages/sdk-js',
    sourceFiles: ['packages/sdk-js/src/index.ts'],
    requiredExports: ['TixkitClient'],
    guidePath: 'docs/public/sdks/javascript.mdx',
    route: '/sdks/javascript',
    guideDemoMarker: 'new TixkitClient',
  },
  {
    id: 'nextjs',
    packageName: '@tixkit/next',
    packagePath: 'packages/sdk-next',
    sourceFiles: ['packages/sdk-next/src/server.ts'],
    requiredExports: ['createTixkitClient'],
    guidePath: 'docs/public/sdks/nextjs.mdx',
    route: '/sdks/nextjs',
    demoDependency: '@tixkit/next',
  },
  {
    id: 'sveltekit',
    packageName: '@tixkit/sveltekit',
    packagePath: 'packages/sdk-sveltekit',
    sourceFiles: ['packages/sdk-sveltekit/src/server.ts'],
    requiredExports: ['createTixkitClient'],
    guidePath: 'docs/public/sdks/sveltekit.mdx',
    route: '/sdks/sveltekit',
    demoDependency: '@tixkit/sveltekit',
  },
  {
    id: 'vue',
    packageName: '@tixkit/vue',
    packagePath: 'packages/sdk-vue',
    sourceFiles: ['packages/sdk-vue/src/server.ts'],
    requiredExports: ['createTixkitClient'],
    guidePath: 'docs/public/sdks/vue-and-nuxt.mdx',
    route: '/sdks/vue-and-nuxt',
    demoDependency: '@tixkit/vue',
  },
  {
    id: 'astro',
    packageName: '@tixkit/astro',
    packagePath: 'packages/sdk-astro',
    sourceFiles: ['packages/sdk-astro/src/server.ts'],
    requiredExports: ['createTixkitClient'],
    guidePath: 'docs/public/sdks/astro.mdx',
    route: '/sdks/astro',
    demoDependency: '@tixkit/astro',
  },
  {
    id: 'remix',
    packageName: '@tixkit/remix',
    packagePath: 'packages/sdk-remix',
    sourceFiles: ['packages/sdk-remix/src/server.ts'],
    requiredExports: ['createTixkitClient'],
    guidePath: 'docs/public/sdks/remix.mdx',
    route: '/sdks/remix',
    demoDependency: '@tixkit/remix',
  },
  {
    id: 'react-native',
    packageName: '@tixkit/react-native',
    packagePath: 'packages/sdk-react-native',
    sourceFiles: ['packages/sdk-react-native/src/index.ts'],
    requiredExports: ['TixkitScannerClient'],
    guidePath: 'docs/public/sdks/react-native.mdx',
    route: '/sdks/react-native',
    demoDependency: '@tixkit/react-native',
  },
  {
    id: 'flutter',
    packageName: 'tixkit_flutter',
    packagePath: 'packages/sdk-flutter',
    sourceFiles: ['packages/sdk-flutter/lib/tixkit_flutter.dart'],
    requiredExports: ['TixkitScannerClient'],
    guidePath: 'docs/public/sdks/flutter.mdx',
    route: '/sdks/flutter',
    manifest: 'pubspec.yaml',
  },
  {
    id: 'ios',
    packageName: 'TixkitIOS',
    packagePath: 'packages/sdk-ios',
    sourceFiles: ['packages/sdk-ios/Sources/TixkitIOS/TixkitIOS.swift'],
    requiredExports: ['TixkitScannerClient'],
    guidePath: 'docs/public/sdks/ios.mdx',
    route: '/sdks/ios',
    manifest: 'Package.swift',
    guideDemoMarker: 'package test suite',
  },
  {
    id: 'android',
    packageName: 'com.tixkit:tixkit-android',
    packagePath: 'packages/sdk-android',
    sourceFiles: ['packages/sdk-android/sdk/src/main/java/com/tixkit/sdk/TixkitAndroid.kt'],
    requiredExports: ['TixkitScannerClient'],
    guidePath: 'docs/public/sdks/android.mdx',
    route: '/sdks/android',
    manifest: 'sdk/build.gradle.kts',
  },
  {
    id: 'go',
    packageName: 'github.com/tixkit/tixkit-go',
    packagePath: 'packages/sdk-go',
    sourceFiles: ['packages/sdk-go/client.go', 'packages/sdk-go/services.go'],
    requiredExports: ['NewClient'],
    guidePath: 'docs/public/sdks/go.mdx',
    route: '/sdks/go',
    manifest: 'go.mod',
  },
  {
    id: 'rust',
    packageName: 'tixkit',
    packagePath: 'packages/sdk-rust',
    sourceFiles: ['packages/sdk-rust/src/lib.rs'],
    requiredExports: ['TixkitClient'],
    guidePath: 'docs/public/sdks/rust.mdx',
    route: '/sdks/rust',
    manifest: 'Cargo.toml',
  },
];

function read(root, relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function frontmatterValue(body, key) {
  const frontmatter = body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return frontmatter.match(new RegExp(`^${key}:\\s*([^\\n]+)$`, 'm'))?.[1]?.trim();
}

function packageIdentity(root, item) {
  const manifest = item.manifest ?? 'package.json';
  const path = `${item.packagePath}/${manifest}`;
  const body = read(root, path);
  if (manifest === 'package.json') return JSON.parse(body).name;
  if (manifest === 'pubspec.yaml') return body.match(/^name:\s*(\S+)/m)?.[1];
  if (manifest === 'Package.swift') return body.match(/name:\s*"([^"]+)"/)?.[1];
  if (manifest === 'go.mod') return body.match(/^module\s+(\S+)/m)?.[1];
  if (manifest === 'Cargo.toml') return body.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (manifest.endsWith('.gradle.kts')) {
    const group = body.match(/^group\s*=\s*"([^"]+)"/m)?.[1];
    return group ? `${group}:tixkit-android` : undefined;
  }
  return undefined;
}

export function validateSdkParity({ root, registry, docRoutes, catalog = sdkParityCatalog }) {
  const failures = [];
  const registryById = new Map();
  const catalogIds = new Set(catalog.map(({ id }) => id));

  for (const entry of registry) {
    if (registryById.has(entry.id)) failures.push(`duplicate shared registry ID: ${entry.id}`);
    registryById.set(entry.id, entry);
  }
  for (const entry of registry) {
    if (!catalogIds.has(entry.id))
      failures.push(`shared registry entry ${entry.id} has no parity catalog definition`);
  }

  for (const item of catalog) {
    const entry = registryById.get(item.id);
    if (!entry) {
      failures.push(`${item.id}: missing from shared SDK snippet registry`);
      continue;
    }

    if (entry.packageName !== item.packageName)
      failures.push(
        `${item.id}: registry package ${entry.packageName} does not match ${item.packageName}`,
      );
    if (entry.apiVersion !== SDK_API_VERSION)
      failures.push(`${item.id}: registry API version must be ${SDK_API_VERSION}`);
    if (!['beta', 'stable'].includes(entry.supportStatus))
      failures.push(`${item.id}: unsupported support status ${entry.supportStatus}`);
    if (!entry.install?.trim() || !entry.initialization?.trim() || !entry.firstRequest?.trim())
      failures.push(`${item.id}: install, initialization, and firstRequest snippets are required`);
    if (!existsSync(join(root, entry.demoPath)))
      failures.push(`${item.id}: demo path does not exist: ${entry.demoPath}`);

    const route = docRoutes[entry.docRouteId];
    if (route !== item.route)
      failures.push(
        `${item.id}: ${entry.docRouteId} resolves to ${route ?? 'nothing'}, expected ${item.route}`,
      );

    try {
      if (packageIdentity(root, item) !== item.packageName)
        failures.push(`${item.id}: package manifest identity does not match ${item.packageName}`);
    } catch (error) {
      failures.push(`${item.id}: cannot read package manifest (${error.message})`);
    }

    const readmePath = `${item.packagePath}/README.md`;
    if (!existsSync(join(root, readmePath)) || statSync(join(root, readmePath)).size === 0)
      failures.push(`${item.id}: missing non-empty package README at ${readmePath}`);
    else {
      const readme = read(root, readmePath);
      if (!readme.includes(SDK_API_VERSION))
        failures.push(`${item.id}: package README does not state API version ${SDK_API_VERSION}`);
    }

    try {
      const guide = read(root, item.guidePath);
      if (frontmatterValue(guide, 'status') !== entry.supportStatus)
        failures.push(
          `${item.id}: guide status does not match registry status ${entry.supportStatus}`,
        );
      if (!guide.includes(item.packageName))
        failures.push(`${item.id}: guide does not identify package ${item.packageName}`);
      if (!guide.includes(`<SdkGuide sdkId="${item.id}" />`))
        failures.push(`${item.id}: guide must render the structured install-to-first-call guide`);
      const demoMarker = item.guideDemoMarker ?? entry.demoPath;
      if (!guide.includes(demoMarker))
        failures.push(`${item.id}: guide does not identify executable fixture ${demoMarker}`);
    } catch (error) {
      failures.push(`${item.id}: cannot read canonical guide ${item.guidePath} (${error.message})`);
    }

    let source = '';
    for (const sourceFile of item.sourceFiles) {
      try {
        source += `\n${read(root, sourceFile)}`;
      } catch (error) {
        failures.push(`${item.id}: cannot read source ${sourceFile} (${error.message})`);
      }
    }
    for (const exported of item.requiredExports) {
      if (!source.includes(exported))
        failures.push(`${item.id}: required export ${exported} is absent from package source`);
      if (!entry.initialization.includes(exported) && !entry.firstRequest.includes(exported))
        failures.push(`${item.id}: snippets do not exercise required export ${exported}`);
    }
    if (!source.includes(SDK_API_VERSION) && !source.includes('TIXKIT_API_VERSION'))
      failures.push(
        `${item.id}: package source does not pin or consume API version ${SDK_API_VERSION}`,
      );

    if (item.demoDependency) {
      try {
        const demoManifest = JSON.parse(read(root, `${entry.demoPath}/package.json`));
        const dependencies = { ...demoManifest.dependencies, ...demoManifest.devDependencies };
        if (!dependencies[item.demoDependency])
          failures.push(`${item.id}: demo does not depend on ${item.demoDependency}`);
        if (!demoManifest.scripts?.typecheck)
          failures.push(`${item.id}: demo is missing a typecheck script`);
      } catch (error) {
        failures.push(`${item.id}: cannot validate demo manifest (${error.message})`);
      }
    }
  }

  return { failures, checkedEntries: catalog.length, apiVersion: SDK_API_VERSION };
}
