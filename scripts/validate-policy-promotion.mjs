#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndVerifyPolicyApprovalPromotion } from './lib/policy-approval-receipt.mjs';

const allowedArguments = new Set([
  '--current-program',
  '--proposed-program',
  '--receipt',
  '--repository-root',
  '--trusted-keyring',
]);

function argumentsFrom(argv) {
  if (argv.length !== allowedArguments.size * 2) {
    throw new Error(
      '--current-program, --proposed-program, --receipt, --trusted-keyring, and --repository-root are required exactly once',
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('Policy promotion arguments are missing, duplicated, or unsupported');
    }
    values.set(name, value);
  }
  return Object.fromEntries(values);
}

export function validatePolicyPromotionCli(argv) {
  const values = argumentsFrom(argv);
  return loadAndVerifyPolicyApprovalPromotion({
    currentProgramPath: values['--current-program'],
    proposedProgramPath: values['--proposed-program'],
    receiptPath: values['--receipt'],
    trustedKeyringPath: values['--trusted-keyring'],
    repositoryRoot: values['--repository-root'],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = validatePolicyPromotionCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
