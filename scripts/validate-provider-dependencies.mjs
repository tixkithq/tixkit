#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProviderDependencyInventoryArtifact,
  providerDependencyViolations,
  renderProviderDependencyInventory,
  writeProviderDependencyInventoryArtifact,
} from './lib/provider-dependencies.mjs';
import { loadProviderIntegrationRegistry } from './lib/provider-integration-registry.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registry = loadProviderIntegrationRegistry(root);
const violations = providerDependencyViolations(root, registry);
if (violations.length > 0) {
  throw new Error(`Provider dependency violations:\n${violations.join('\n')}`);
}
const inventory = renderProviderDependencyInventory(root, registry);
const arguments_ = process.argv.slice(2);
const writeIndex = arguments_.indexOf('--write');
const checkIndex = arguments_.indexOf('--check');
if (writeIndex >= 0 && checkIndex >= 0) {
  throw new Error('--write and --check are mutually exclusive');
}
if (
  arguments_.some(
    (argument) => argument.startsWith('--') && !['--check', '--write'].includes(argument),
  )
) {
  throw new Error(`Unknown option: ${arguments_.find((argument) => argument.startsWith('--'))}`);
}
if (writeIndex >= 0) {
  const outputPath = arguments_[writeIndex + 1];
  if (!outputPath || outputPath.startsWith('--')) {
    throw new Error('--write requires an output path');
  }
  writeProviderDependencyInventoryArtifact(root, outputPath, registry);
  console.log(
    `Generated ${inventory.length} classified provider SDK import sites at ${outputPath}.`,
  );
} else {
  const artifactPath = checkIndex >= 0 ? arguments_[checkIndex + 1] : undefined;
  if (artifactPath?.startsWith('--')) throw new Error('--check received an invalid artifact path');
  loadProviderDependencyInventoryArtifact(root, registry, artifactPath);
  console.log(`Validated ${inventory.length} classified provider SDK import sites and inventory.`);
}
