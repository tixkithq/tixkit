#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  assertStripePackagePlacement,
  currentEvaluationWithoutTiming,
  STRIPE_EVALUATION_PATH,
  STRIPE_EVALUATION_SCHEMA_PATH,
  stripeSdkEvaluationViolations,
} from './lib/stripe-sdk-evaluation.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evaluation = JSON.parse(readFileSync(resolve(root, STRIPE_EVALUATION_PATH), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(root, STRIPE_EVALUATION_SCHEMA_PATH), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
if (!validate(evaluation)) {
  throw new Error(
    `Stripe SDK evaluation schema violations:\n${JSON.stringify(validate.errors, null, 2)}`,
  );
}
assertStripePackagePlacement(root);
const current = currentEvaluationWithoutTiming(root, evaluation.startupMeasurement);
const violations = stripeSdkEvaluationViolations(evaluation, current);
if (violations.length > 0) {
  throw new Error(`Stripe SDK evaluation violations:\n${violations.join('\n')}`);
}
process.stdout.write(
  `Validated fail-closed Stripe SDK decision: ${evaluation.decision}; ` +
    `${evaluation.parityGates.filter(({ status }) => status === 'passed').length}/` +
    `${evaluation.parityGates.length} required gates passed.\n`,
);
