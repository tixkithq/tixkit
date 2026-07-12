#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiSpec } from '../packages/openapi/src/index.js';
import {
  API_PROVENANCE_EXCLUSIONS,
  collectApiReleaseProvenance,
} from './lib/api-release-provenance.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionArgument = process.argv.indexOf('--distribution');
const distributionPath =
  distributionArgument === -1
    ? resolve(root, 'distribution/public-distribution.json')
    : resolve(process.argv[distributionArgument + 1] ?? '');
const distribution = JSON.parse(readFileSync(distributionPath, 'utf8'));
const activeVersion = openApiSpec.info.version;
const declaredApiContracts = distribution.release.contracts.filter((path: string) =>
  path.startsWith('artifacts/api/'),
);
const activeContract = `artifacts/api/${activeVersion}`;
const violations: string[] = [];
if (!declaredApiContracts.includes(activeContract)) {
  violations.push(`active API contract is not manifest-declared: ${activeContract}`);
}

const expected = await collectApiReleaseProvenance(root);
for (const contract of declaredApiContracts) {
  const releaseDirectory = resolve(root, contract);
  if (!existsSync(releaseDirectory)) {
    violations.push(`${contract}: declared API release contract does not exist`);
    continue;
  }
  const manifest = JSON.parse(
    readFileSync(resolve(releaseDirectory, 'release-manifest.json'), 'utf8'),
  );
  const contractVersion = basename(contract);
  if (manifest.apiVersion !== contractVersion)
    violations.push(`${contract}: apiVersion does not match its versioned path`);
  if (contract === activeContract) {
    if (manifest.commit !== expected.headCommit)
      violations.push('release commit does not match HEAD');
    if (manifest.timestamp !== expected.headTimestamp)
      violations.push('release timestamp does not match HEAD');
    if (manifest.provenance?.sourceCommit !== expected.headCommit)
      violations.push('provenance sourceCommit does not match HEAD');
    if (manifest.provenance?.headTreeHash !== expected.headTreeHash)
      violations.push('provenance headTreeHash does not match HEAD');
    if (manifest.provenance?.sourceTreeHash !== expected.sourceTreeHash)
      violations.push('provenance sourceTreeHash does not match repository inputs');
    if (manifest.provenance?.trackedFileCount !== expected.inputCount)
      violations.push('provenance trackedFileCount does not match repository inputs');
    if (
      JSON.stringify(manifest.provenance?.excludedGeneratedPaths) !==
      JSON.stringify(API_PROVENANCE_EXCLUSIONS)
    )
      violations.push('provenance exclusions do not match the generator contract');
    if (manifest.provenance?.worktreeState !== 'clean')
      violations.push('release provenance is not clean');
    if (manifest.provenance?.publishable !== true)
      violations.push('release provenance is not publishable');
  }

  const checksums = new Map(
    readFileSync(resolve(releaseDirectory, 'CHECKSUMS.sha256'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [digest, name] = line.split(/\s{2}/u);
        return [name, digest];
      }),
  );
  for (const artifact of [...manifest.artifacts, { name: 'release-manifest.json' }]) {
    const bytes = readFileSync(resolve(releaseDirectory, artifact.name));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (checksums.get(artifact.name) !== digest)
      violations.push(`${artifact.name} checksum does not match`);
  }
}

if (violations.length > 0) {
  throw new Error(`API release provenance validation failed:\n${violations.join('\n')}`);
}
process.stdout.write(
  `Validated publishable API release ${activeVersion} for ${expected.headCommit}.\n`,
);
