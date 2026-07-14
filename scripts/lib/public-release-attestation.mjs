import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadPublicDistribution } from './public-distribution.mjs';

export function verifyPublicReleaseAttestation(publicRoot, publicReleasePath, run = execFileSync) {
  const untrustedRelease = JSON.parse(readFileSync(publicReleasePath, 'utf8'));
  const authority = loadPublicDistribution(publicRoot).authority.publicRepository;
  const releaseTag = untrustedRelease.releaseVersion?.startsWith('v')
    ? untrustedRelease.releaseVersion
    : `v${untrustedRelease.releaseVersion}`;
  const verification = run(
    'gh',
    [
      'attestation',
      'verify',
      publicReleasePath,
      '--repo',
      authority,
      '--signer-workflow',
      `${authority}/.github/workflows/public-artifact-release.yml`,
      '--source-ref',
      `refs/tags/${releaseTag}`,
      '--source-digest',
      untrustedRelease.core?.sourceCommit,
      '--deny-self-hosted-runners',
      '--format',
      'json',
    ],
    { encoding: 'utf8' },
  );
  const verifiedBytes = readFileSync(publicReleasePath);
  const artifactSha256 = createHash('sha256').update(verifiedBytes).digest('hex');
  const results = JSON.parse(String(verification));
  const subjectMatches = results.some((result) =>
    result?.verificationResult?.statement?.subject?.some(
      (subject) => subject?.digest?.sha256 === artifactSha256,
    ),
  );
  if (!subjectMatches)
    throw new Error('verified attestation does not bind the consumed public release bytes');
  return JSON.parse(verifiedBytes.toString('utf8'));
}
