#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
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
const outputPath = resolve(root, STRIPE_EVALUATION_PATH);
writeFileSync(outputPath, `${JSON.stringify(evaluation, null, 2)}\n`, {
  mode: 0o644,
});
const formatter = spawnSync(resolve(root, 'node_modules/.bin/oxfmt'), ['--write', outputPath], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (formatter.status !== 0 || formatter.signal) {
  throw new Error(
    `Stripe SDK evaluation formatting failed: ${formatter.stderr || formatter.signal || formatter.status}`,
  );
}
process.stdout.write(
  `Measured Stripe SDK evaluation: ${evaluation.decision}; ` +
    `${evaluation.containedSdk.logicalInstalledBytes} logical bytes, ` +
    `${evaluation.containedSdk.logicalInstalledFiles} files.\n`,
);
