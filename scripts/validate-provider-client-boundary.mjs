#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerClientBoundaryViolations } from './lib/provider-client-boundary.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const violations = providerClientBoundaryViolations(root);
if (violations.length > 0) {
  throw new Error(`Outbound provider-client boundary violations:\n${violations.join('\n')}`);
}
console.log('Validated outbound provider-client boundary.');
