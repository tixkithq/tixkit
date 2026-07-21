import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  GITHUB_BUILD_PROVENANCE_PREDICATE,
  GITHUB_SPDX_PREDICATE,
  createGithubAttestationVerifier,
} from './lib/github-attestation.mjs';

const options = Object.fromEntries(
  process.argv
    .slice(2)
    .map((value, index, all) =>
      value.startsWith('--') ? [value.slice(2), all[index + 1]] : ['', ''],
    )
    .filter(([key]) => key),
);
const base = new URL(options['contracts-url']);
if (base.protocol !== 'https:' || base.username || base.password)
  throw new Error('contracts-url must be an exact HTTPS release directory.');

function requireExactPackageSpec(value, packageName, optionName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (
    !value ||
    !new RegExp(`^${escapedName}@\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.-]+)?$`, 'u').test(value)
  )
    throw new Error(`${optionName} must pin an exact ${packageName} version.`);
  return value;
}

const sdkSpec = requireExactPackageSpec(options['sdk-spec'], '@tixkit/js', 'sdk-spec');
const contractTestsSpec = requireExactPackageSpec(
  options['contract-tests-spec'],
  '@tixkit/contract-tests',
  'contract-tests-spec',
);
if (!options['trusted-contracts-root'])
  throw new Error(
    'trusted-contracts-root must identify contracts from the protected tag checkout.',
  );
if (options.repository) {
  const expectedSigner = `${options.repository}/.github/workflows/api-contract-release.yml`;
  if (options['signer-workflow'] !== expectedSigner)
    throw new Error(`signer-workflow must be exactly ${expectedSigner}.`);
  if (!/^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options['source-ref']))
    throw new Error('source-ref must bind the protected release tag.');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(options['source-digest'] ?? ''))
    throw new Error('source-digest must be an exact lowercase commit digest.');
  if (options.commit && options['source-digest'] !== options.commit)
    throw new Error('source-digest must equal the protected release tag commit.');
  for (const name of ['public-release-manifest', 'public-release-checksums', 'public-release-sbom'])
    if (!options[name]) throw new Error(`${name} is required when repository is configured.`);
}

function checksumEntries(value) {
  const entries = new Map();
  for (const line of value.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9@._+-]+)$/u.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Public release checksums are invalid.');
    entries.set(match[2], match[1]);
  }
  return entries;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const temp = await mkdtemp(join(tmpdir(), 'tixkit-public-release-'));
try {
  const verifyAttestation = options.repository ? createGithubAttestationVerifier() : null;
  let publicRelease;
  let publicReleaseChecksums;
  let publicReleaseSbom;
  let verifyPublicAttestation;
  if (verifyAttestation) {
    const publicTrustPaths = [
      resolve(options['public-release-manifest']),
      resolve(options['public-release-checksums']),
      resolve(options['public-release-sbom']),
    ];
    verifyPublicAttestation = createGithubAttestationVerifier();
    const authority = {
      repository: options.repository,
      signerWorkflow: `${options.repository}/.github/workflows/public-artifact-release.yml`,
      sourceRef: options['source-ref'],
      sourceDigest: options['source-digest'],
      predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
    };
    for (const path of publicTrustPaths) verifyPublicAttestation(path, authority);
    const [manifestBytes, checksumFileBytes, sbomBytes] = await Promise.all(
      publicTrustPaths.map((path) => readFile(path)),
    );
    publicReleaseChecksums = checksumEntries(checksumFileBytes.toString('utf8'));
    for (const [path, bytes] of [
      [publicTrustPaths[0], manifestBytes],
      [publicTrustPaths[2], sbomBytes],
    ])
      if (publicReleaseChecksums.get(basename(path)) !== sha256(bytes))
        throw new Error(`Public release checksum mismatch for ${basename(path)}.`);
    publicRelease = JSON.parse(manifestBytes.toString('utf8'));
    publicReleaseSbom = JSON.parse(sbomBytes.toString('utf8'));
    if (
      publicRelease?.schemaVersion !== 1 ||
      publicRelease.releaseVersion !== options['source-ref'].slice('refs/tags/v'.length) ||
      publicRelease.core?.sourceCommit !== options['source-digest'] ||
      !Array.isArray(publicRelease.core?.packages) ||
      !publicReleaseSbom ||
      typeof publicReleaseSbom !== 'object' ||
      Array.isArray(publicReleaseSbom)
    )
      throw new Error('Public release package trust root is invalid.');
  }
  const get = async (name) => {
    const response = await fetch(new URL(name, `${base.toString().replace(/\/$/u, '')}/`));
    if (!response.ok) throw new Error(`Unable to download ${name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(join(temp, name), bytes);
    return bytes;
  };
  const manifestBytes = await get('release-manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(manifest.apiVersion))
    throw new Error('Public manifest contains an invalid API version.');
  if (options.commit)
    execFileSync('git', ['merge-base', '--is-ancestor', manifest.commit, options.commit]);

  const checksumBytes = await get('CHECKSUMS.sha256');
  const trustedDirectory = resolve(options['trusted-contracts-root'], manifest.apiVersion);
  for (const [name, publicBytes] of [
    ['release-manifest.json', manifestBytes],
    ['CHECKSUMS.sha256', checksumBytes],
  ]) {
    const trustedBytes = await readFile(join(trustedDirectory, name));
    if (!Buffer.from(publicBytes).equals(trustedBytes))
      throw new Error(`Public ${name} does not match the protected tag.`);
  }

  const checksums = new Map(
    new TextDecoder()
      .decode(checksumBytes)
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, name] = line.split(/\s{2}/u);
        return [name, hash];
      }),
  );
  const artifactNames = [...manifest.artifacts.map(({ name }) => name), 'release-manifest.json'];
  for (const name of artifactNames) {
    const bytes = name === 'release-manifest.json' ? manifestBytes : await get(name);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== checksums.get(name)) throw new Error(`Checksum mismatch for ${name}.`);
  }

  if (verifyAttestation) {
    for (const name of [...artifactNames, 'CHECKSUMS.sha256']) {
      verifyAttestation(join(temp, name), {
        repository: options.repository,
        signerWorkflow: options['signer-workflow'],
        sourceRef: options['source-ref'],
        sourceDigest: options['source-digest'],
        predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
      });
    }
  }

  const packExactRegistryPackage = (spec, expectedName) => {
    const expectedPin = publicRelease?.core.packages.find(
      ({ name, version }) => `${name}@${version}` === spec,
    );
    if (publicRelease && !expectedPin)
      throw new Error(`Public release manifest does not pin ${spec}.`);
    const metadata = JSON.parse(
      execFileSync('npm', ['view', spec, 'name', 'version', 'dist.integrity', '--json'], {
        encoding: 'utf8',
      }),
    );
    const packed = JSON.parse(
      execFileSync('npm', ['pack', spec, '--json', '--pack-destination', temp], {
        encoding: 'utf8',
      }),
    )[0];
    if (
      metadata.name !== expectedName ||
      `${metadata.name}@${metadata.version}` !== spec ||
      !metadata['dist.integrity'] ||
      packed.integrity !== metadata['dist.integrity'] ||
      (expectedPin && packed.integrity !== expectedPin.integrity)
    ) {
      throw new Error(
        `Packed ${expectedName} integrity does not match the exact registry release.`,
      );
    }
    const tarball = join(temp, packed.filename);
    if (
      publicReleaseChecksums &&
      publicReleaseChecksums.get(packed.filename) !== sha256(readFileSync(tarball))
    )
      throw new Error(`Public release checksum mismatch for ${packed.filename}.`);
    if (verifyPublicAttestation) {
      const authority = {
        repository: options.repository,
        signerWorkflow: `${options.repository}/.github/workflows/public-artifact-release.yml`,
        sourceRef: options['source-ref'],
        sourceDigest: options['source-digest'],
      };
      verifyPublicAttestation(tarball, {
        ...authority,
        predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
      });
      verifyPublicAttestation(tarball, {
        ...authority,
        predicateType: GITHUB_SPDX_PREDICATE,
        expectedPredicate: publicReleaseSbom,
      });
    }
    return tarball;
  };
  const sdkTarball = packExactRegistryPackage(sdkSpec, '@tixkit/js');
  const contractTarball = packExactRegistryPackage(contractTestsSpec, '@tixkit/contract-tests');

  const auditDirectory = join(temp, 'registry-audit');
  await mkdir(auditDirectory);
  await writeFile(
    join(auditDirectory, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: {
        '@tixkit/js': sdkSpec.split('@').at(-1),
        '@tixkit/contract-tests': contractTestsSpec.split('@').at(-1),
      },
    }),
  );
  execFileSync('npm', ['install', '--ignore-scripts'], {
    cwd: auditDirectory,
    stdio: 'inherit',
  });
  execFileSync('npm', ['audit', 'signatures'], {
    cwd: auditDirectory,
    stdio: 'inherit',
  });

  const consumerDirectory = join(temp, 'consumer');
  await mkdir(consumerDirectory);
  await writeFile(
    join(consumerDirectory, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {
        '@tixkit/js': `file:${sdkTarball}`,
        '@tixkit/contract-tests': `file:${contractTarball}`,
      },
    }),
  );
  execFileSync('npm', ['install', '--ignore-scripts'], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });
  await writeFile(
    join(consumerDirectory, 'verify.mjs'),
    `import { runSdkApiConsumerContract } from '@tixkit/contract-tests';
import { TixkitClient } from '@tixkit/js';
const endpointId = 'wh_public_verification';
const apiVersion = ${JSON.stringify(manifest.apiVersion)};
const apiKey = 'tk_sandbox_${'a'.repeat(64)}';
const result = await runSdkApiConsumerContract({
  apiVersion,
  apiKey,
  endpointId,
  execute: async (expected) => {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = {
        url: String(url),
        method: init.method,
        body: init.body,
        headers: Object.fromEntries(new Headers(init.headers)),
      };
      return new Response(JSON.stringify({ queued: true, test: true, eventId: 'whe_public_verification', endpointId }), { status: 202, headers: { 'content-type': 'application/json' } });
    };
    const client = new TixkitClient({ apiKey, apiVersion, apiBaseUrl: 'https://api.example.invalid', maxRetries: 0 });
    const body = await client.webhookEndpoints.sendTest(endpointId);
    if (captured.url !== \`https://api.example.invalid\${expected.path}\`) throw new Error('Packed SDK request path mismatch.');
    if (captured.method !== expected.method) throw new Error('Packed SDK request method mismatch.');
    if (captured.body !== undefined && captured.body !== null) throw new Error('Packed SDK request body mismatch.');
    if (captured.headers.authorization !== expected.headers.authorization || captured.headers['x-tixkit-version'] !== expected.headers['X-Tixkit-Version']) throw new Error('Packed SDK request headers mismatch.');
    return { status: 202, headers: { 'content-type': 'application/json' }, body };
  },
});
if (!result.ok) throw new Error(\`Packed SDK consumer contract failed: \${JSON.stringify(result.findings)}\`);
`,
  );
  execFileSync('node', ['verify.mjs'], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });
  console.log(`Verified public API ${manifest.apiVersion}, ${sdkSpec}, and ${contractTestsSpec}.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
