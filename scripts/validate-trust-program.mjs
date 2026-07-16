#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrustProgram } from './lib/trust-program.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const program = JSON.parse(readFileSync(resolve(root, 'distribution/trust-program.json'), 'utf8'));
validateTrustProgram(program, root);
console.log(`Validated public trust program: ${program.records.length} records.`);
