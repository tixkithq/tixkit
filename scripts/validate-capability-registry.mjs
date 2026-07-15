#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapabilityRegistry } from './lib/capability-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(
  readFileSync(resolve(root, 'distribution/capability-registry.json'), 'utf8'),
);
validateCapabilityRegistry(registry, root);
console.log(`Validated capability registry: ${registry.capabilities.length} decisions.`);
