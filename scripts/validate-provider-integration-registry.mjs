#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProviderIntegrationRegistry } from './lib/provider-integration-registry.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registry = loadProviderIntegrationRegistry(root);
console.log(`Validated ${registry.integrations.length} provider integration classifications.`);
