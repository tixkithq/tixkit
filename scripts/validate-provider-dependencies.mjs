#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  providerDependencyViolations,
  renderProviderDependencyInventory,
} from './lib/provider-dependencies.mjs';
import { loadProviderIntegrationRegistry } from './lib/provider-integration-registry.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registry = loadProviderIntegrationRegistry(root);
const violations = providerDependencyViolations(root, registry);
if (violations.length > 0) {
  throw new Error(`Provider dependency violations:\n${violations.join('\n')}`);
}
const inventory = renderProviderDependencyInventory(root, registry);
console.log(`Validated ${inventory.length} classified provider SDK import sites.`);
