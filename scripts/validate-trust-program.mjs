#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeLocalTrustEvidence, validateTrustProgram } from './lib/trust-program.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const program = JSON.parse(readFileSync(resolve(root, 'distribution/trust-program.json'), 'utf8'));
validateTrustProgram(program, root);
if (process.argv.includes('--execute-local-evidence')) {
  const executed = await executeLocalTrustEvidence(program, root);
  console.log(`Executed local trust evidence: ${executed} commands.`);
}
console.log(`Validated public trust program: ${program.records.length} records.`);
