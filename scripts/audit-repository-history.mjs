#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPublicDistribution } from './lib/public-distribution.mjs';
import {
  auditRepositoryHistory,
  safeHistoryAuditOutput,
  secureHistoryAuditReport,
} from './lib/repository-history-audit.mjs';

const root = resolve(import.meta.dirname, '..');
const outputIndex = process.argv.indexOf('--out');
if (outputIndex === -1 || !process.argv[outputIndex + 1]) throw new Error('--out is required');
const output = safeHistoryAuditOutput(process.argv[outputIndex + 1]);
const result = auditRepositoryHistory(root, loadPublicDistribution(root));
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
secureHistoryAuditReport(output);
console.log(
  `Repository high-confidence credential history audit ${result.status}: ${result.commitCount} commits, ${result.uniqueBlobCount} blobs, digest ${result.auditDigest}.`,
);
if (result.status !== 'pass') process.exitCode = 1;
