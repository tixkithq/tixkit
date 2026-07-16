#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertStripePackagePlacement,
  buildStripeSdkEvaluation,
  STRIPE_EVALUATION_PATH,
} from './lib/stripe-sdk-evaluation.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
assertStripePackagePlacement(root);
const evaluation = buildStripeSdkEvaluation(root);
writeFileSync(resolve(root, STRIPE_EVALUATION_PATH), `${JSON.stringify(evaluation, null, 2)}\n`, {
  mode: 0o644,
});
process.stdout.write(
  `Measured Stripe SDK evaluation: ${evaluation.decision}; ` +
    `${evaluation.containedSdk.logicalInstalledBytes} logical bytes, ` +
    `${evaluation.containedSdk.logicalInstalledFiles} files.\n`,
);
