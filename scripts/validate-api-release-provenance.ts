#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiSpec } from '../packages/openapi/src/index.js';
import {
  API_PROVENANCE_EXCLUSIONS,
  collectCommittedApiReleaseProvenance,
} from './lib/api-release-provenance.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distributionArgument = process.argv.indexOf('--distribution');
const distributionPath =
  distributionArgument === -1
    ? resolve(root, 'distribution/public-distribution.json')
    : resolve(process.argv[distributionArgument + 1] ?? '');
const distribution = JSON.parse(readFileSync(distributionPath, 'utf8'));
const allowRecordedSource = process.argv.includes('--allow-recorded-source');
const allowDerivedExport = process.argv.includes('--allow-derived-export');
const activeVersion = openApiSpec.info.version;
const declaredApiContracts = distribution.release.contracts.filter((path: string) =>
  path.startsWith('artifacts/api/'),
);
const activeContract = `artifacts/api/${activeVersion}`;
const violations: string[] = [];
if (!declaredApiContracts.includes(activeContract)) {
  violations.push(`active API contract is not manifest-declared: ${activeContract}`);
}

let validatedSourceCommit = '';
let recordedOnly = false;
let derivedExportOnly = false;
if (allowDerivedExport && !allowRecordedSource) {
  violations.push('--allow-derived-export requires --allow-recorded-source');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isPendingLicenseDerivedExport(provenance: Record<string, unknown>): boolean {
  const transformation = provenance.exportTransformation as
    | {
        kind?: unknown;
        licensingStatus?: unknown;
        sourceArtifacts?: Record<string, unknown>;
      }
    | undefined;
  return (
    distribution.licensing?.status === 'pending-legal-review' &&
    distribution.licensing?.mayClaimLegalApproval === false &&
    distribution.licensing?.legalReviewEvidence === '' &&
    provenance.publishable === false &&
    provenance.reproducible === false &&
    transformation?.kind === 'license-status-normalization' &&
    transformation.licensingStatus === 'pending-legal-review' &&
    Object.keys(transformation.sourceArtifacts ?? {})
      .sort()
      .join(',') === 'openapi.json,openapi.yaml' &&
    isSha256(transformation.sourceArtifacts?.['openapi.json']) &&
    isSha256(transformation.sourceArtifacts?.['openapi.yaml'])
  );
}
function gitObjectType(objectId: string): string | undefined {
  try {
    return execFileSync('git', ['cat-file', '-t', objectId], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer | string };
    const stderr = String(failure.stderr ?? '');
    if (
      failure.status === 128 &&
      /could not get object info|not a valid object name/iu.test(stderr)
    )
      return undefined;
    throw error;
  }
}
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
  if (allowDerivedExport) {
    if (isPendingLicenseDerivedExport(manifest.provenance ?? {})) {
      derivedExportOnly = true;
    } else {
      violations.push(`${contract}: release is not a pending-license derived export`);
    }
  }
  if (contract === activeContract) {
    const sourceCommit = manifest.provenance?.sourceCommit;
    if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(sourceCommit))
      violations.push('provenance sourceCommit is not a canonical SHA-1 commit identifier');
    if (
      typeof manifest.provenance?.headTreeHash !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(manifest.provenance.headTreeHash)
    )
      violations.push('provenance headTreeHash is not a canonical SHA-1 tree identifier');
    if (
      typeof manifest.provenance?.sourceTreeHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(manifest.provenance.sourceTreeHash)
    )
      violations.push('provenance sourceTreeHash is not a SHA-256 digest');
    if (
      !Number.isSafeInteger(manifest.provenance?.trackedFileCount) ||
      manifest.provenance.trackedFileCount < 1
    )
      violations.push('provenance trackedFileCount is invalid');
    let expected: ReturnType<typeof collectCommittedApiReleaseProvenance> | undefined;
    try {
      const objectType = typeof sourceCommit === 'string' ? gitObjectType(sourceCommit) : undefined;
      if (objectType === 'commit') {
        expected = collectCommittedApiReleaseProvenance(root, sourceCommit);
        validatedSourceCommit = expected.headCommit;
      } else if (objectType) {
        violations.push('provenance sourceCommit resolves to an object that is not a commit');
      } else if (allowRecordedSource && typeof sourceCommit === 'string') {
        recordedOnly = true;
        validatedSourceCommit = sourceCommit;
      } else {
        violations.push(
          'provenance source commit is unavailable; use --allow-recorded-source only for shallow or exported repository integrity checks',
        );
      }
    } catch {
      violations.push(
        'recorded source commit exists but its provenance could not be reconstructed',
      );
    }
    if (manifest.commit !== manifest.provenance?.sourceCommit)
      violations.push('release commit does not match provenance sourceCommit');
    if (expected && manifest.timestamp !== expected.headTimestamp)
      violations.push('release timestamp does not match recorded source commit');
    if (expected && manifest.provenance?.sourceCommit !== expected.headCommit)
      violations.push('provenance sourceCommit is not canonical');
    if (expected && manifest.provenance?.headTreeHash !== expected.headTreeHash)
      violations.push('provenance headTreeHash does not match recorded source commit');
    if (expected && manifest.provenance?.sourceTreeHash !== expected.sourceTreeHash)
      violations.push('provenance sourceTreeHash does not match recorded source inputs');
    if (expected && manifest.provenance?.trackedFileCount !== expected.inputCount)
      violations.push('provenance trackedFileCount does not match recorded source inputs');
    if (
      JSON.stringify(manifest.provenance?.excludedGeneratedPaths) !==
      JSON.stringify(API_PROVENANCE_EXCLUSIONS)
    )
      violations.push('provenance exclusions do not match the generator contract');
    if (manifest.provenance?.worktreeState !== 'clean')
      violations.push('release provenance is not clean');
    if (manifest.provenance?.publishable !== true && !allowDerivedExport)
      violations.push('release provenance is not publishable');
  }

  const checksumEntries = readFileSync(resolve(releaseDirectory, 'CHECKSUMS.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [digest, name, ...remainder] = line.split(/\s{2}/u);
      if (!isSha256(digest) || !name || remainder.length > 0) {
        violations.push(`${contract}: malformed checksum entry`);
      }
      return [name, digest] as const;
    });
  const checksums = new Map(checksumEntries);
  const expectedArtifactNames = [
    ...manifest.artifacts.map((artifact: { name: string }) => artifact.name),
    'release-manifest.json',
  ];
  if (checksums.size !== checksumEntries.length) {
    violations.push(`${contract}: duplicate checksum entries`);
  }
  if ([...checksums.keys()].sort().join('\n') !== [...expectedArtifactNames].sort().join('\n')) {
    violations.push(`${contract}: checksum names do not exactly match release artifacts`);
  }
  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(resolve(releaseDirectory, artifact.name));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (artifact.sha256 !== digest)
      violations.push(`${artifact.name} manifest sha256 does not match`);
    if (artifact.size !== bytes.byteLength)
      violations.push(`${artifact.name} manifest size does not match`);
    if (checksums.get(artifact.name) !== digest)
      violations.push(`${artifact.name} checksum does not match`);
  }
  const manifestBytes = readFileSync(resolve(releaseDirectory, 'release-manifest.json'));
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  if (checksums.get('release-manifest.json') !== manifestDigest)
    violations.push('release-manifest.json checksum does not match');
}

if (violations.length > 0) {
  throw new Error(`API release provenance validation failed:\n${violations.join('\n')}`);
}
process.stdout.write(
  derivedExportOnly
    ? `Validated pending-license derived API artifact integrity for ${activeVersion}; this evidence is not sufficient for publication.\n`
    : recordedOnly
      ? `Validated API artifact integrity for ${activeVersion}; source provenance ${validatedSourceCommit} is recorded but unverified and is not sufficient for publication.\n`
      : `Validated publishable API release ${activeVersion} for ${validatedSourceCommit}.\n`,
);
