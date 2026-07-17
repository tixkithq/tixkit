#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndVerifyHostedTrustReceipt } from './lib/hosted-trust-receipt.mjs';

const allowedArguments = new Set(['--artifact', '--receipt', '--trusted-keyring']);

function argumentsFrom(argv) {
  if (argv.length !== allowedArguments.size * 2) {
    throw new Error('--receipt, --artifact, and --trusted-keyring are required exactly once');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('Hosted trust receipt arguments are missing, duplicated, or unsupported');
    }
    values.set(name, value);
  }
  return Object.fromEntries(values);
}

export function validateHostedTrustReceiptCli(argv) {
  const values = argumentsFrom(argv);
  return loadAndVerifyHostedTrustReceipt({
    receiptPath: values['--receipt'],
    artifactPath: values['--artifact'],
    keyringPath: values['--trusted-keyring'],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = validateHostedTrustReceiptCli(process.argv.slice(2));
  process.stdout.write(
    `Verified hosted trust receipt ${result.trustRecordId}/${result.artifactKind} ` +
      `for ${result.sourceCommit} from workflow run ${result.workflowRunId}.\n`,
  );
}
