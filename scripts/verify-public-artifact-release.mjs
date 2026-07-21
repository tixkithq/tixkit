#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_BUILD_PROVENANCE_PREDICATE,
  GITHUB_SPDX_PREDICATE,
  createGithubAttestationVerifier,
} from './lib/github-attestation.mjs';

const OPTION_NAMES = new Set([
  '--directory',
  '--repository',
  '--signer-workflow',
  '--source-ref',
  '--source-digest',
]);
const OPTION_FLAGS = new Set(['--existing-assets-only']);
const TAG_REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?$/u;
const IMAGE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

function assertSafeOptionValue(value, option) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith('-') ||
    hasControlCharacters(value)
  )
    throw new Error(`${option} has an invalid value`);
  return value;
}

export function parsePublicArtifactReleaseOptions(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length;) {
    const option = argv[index];
    if (OPTION_FLAGS.has(option)) {
      if (Object.hasOwn(parsed, option)) throw new Error(`duplicate option: ${option}`);
      parsed[option] = true;
      index += 1;
      continue;
    }
    const optionValue = argv[index + 1];
    if (!OPTION_NAMES.has(option)) throw new Error(`unknown option: ${option ?? '<missing>'}`);
    if (Object.hasOwn(parsed, option)) throw new Error(`duplicate option: ${option}`);
    parsed[option] = assertSafeOptionValue(optionValue, option);
    index += 2;
  }
  for (const option of OPTION_NAMES)
    if (!Object.hasOwn(parsed, option)) throw new Error(`${option} is required`);
  if (!REPOSITORY_PATTERN.test(parsed['--repository']))
    throw new Error('--repository must be an exact lowercase owner/repository');
  const expectedSigner = `${parsed['--repository']}/.github/workflows/public-artifact-release.yml`;
  if (parsed['--signer-workflow'] !== expectedSigner)
    throw new Error(`--signer-workflow must be exactly ${expectedSigner}`);
  if (!TAG_REF_PATTERN.test(parsed['--source-ref']))
    throw new Error('--source-ref must be an exact version tag ref');
  if (!SHA_PATTERN.test(parsed['--source-digest']))
    throw new Error('--source-digest must be an exact lowercase commit digest');
  return {
    directory: resolve(parsed['--directory']),
    repository: parsed['--repository'],
    signerWorkflow: parsed['--signer-workflow'],
    sourceRef: parsed['--source-ref'],
    sourceDigest: parsed['--source-digest'],
    existingAssetsOnly: parsed['--existing-assets-only'] === true,
  };
}

function assertContainedRegularFile(root, path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error(`release candidate must be a regular file: ${relative(root, path)}`);
  const realPath = realpathSync(path);
  if (realPath !== root && !realPath.startsWith(`${root}${sep}`))
    throw new Error(`release candidate escapes its directory: ${relative(root, path)}`);
  return realPath;
}

function releaseCandidates(directory) {
  const directoryMetadata = lstatSync(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory())
    throw new Error('release directory must be a real directory');
  const root = realpathSync(directory);
  const candidates = [];
  let hasPackageDirectory = false;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`release candidate cannot be a symlink: ${entry.name}`);
    if (entry.isDirectory()) {
      if (entry.name !== 'packages' || hasPackageDirectory)
        throw new Error(`unexpected release candidate directory: ${entry.name}`);
      hasPackageDirectory = true;
      for (const packageEntry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          !packageEntry.isFile() ||
          packageEntry.isSymbolicLink() ||
          !packageEntry.name.endsWith('.tgz')
        )
          throw new Error(`packages must contain only regular npm tarballs: ${packageEntry.name}`);
        candidates.push(assertContainedRegularFile(root, join(path, packageEntry.name)));
      }
      continue;
    }
    candidates.push(assertContainedRegularFile(root, path));
  }
  const rootTarballs = candidates.filter(
    (path) => path.endsWith('.tgz') && relative(root, path).split(sep).length === 1,
  );
  const nestedTarballs = candidates.filter((path) =>
    relative(root, path).startsWith(`packages${sep}`),
  );
  if (hasPackageDirectory && rootTarballs.length > 0)
    throw new Error('release package layout cannot mix nested and resumed flat tarballs');
  if (
    (hasPackageDirectory && nestedTarballs.length === 0) ||
    (!hasPackageDirectory && rootTarballs.length === 0)
  )
    throw new Error('release candidate must contain npm tarballs');
  if (candidates.length === 0) throw new Error('release candidate is empty');
  return { candidates, root };
}

function existingReleaseCandidates(directory) {
  const directoryMetadata = lstatSync(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory())
    throw new Error('release directory must be a real directory');
  const root = realpathSync(directory);
  const candidates = readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error(`existing release assets must be regular files: ${entry.name}`);
      return assertContainedRegularFile(root, join(root, entry.name));
    });
  if (candidates.length === 0) throw new Error('release candidate is empty');
  return candidates;
}

function exactImageReferences(root, repository) {
  const imagePath = join(root, 'images.json');
  assertContainedRegularFile(root, imagePath);
  let images;
  try {
    images = JSON.parse(readFileSync(imagePath, 'utf8'));
  } catch {
    throw new Error('images.json must contain valid JSON');
  }
  if (!Array.isArray(images) || images.length === 0)
    throw new Error('images.json must contain a non-empty image array');
  const names = new Set();
  const references = new Set();
  return images.map((image) => {
    if (!image || typeof image !== 'object' || Array.isArray(image))
      throw new Error('images.json contains a malformed image record');
    const keys = Object.keys(image).sort();
    if (keys.join(',') !== 'digest,name,reference')
      throw new Error('images.json image records must contain exactly digest, name, and reference');
    if (!IMAGE_NAME_PATTERN.test(image.name) || names.has(image.name))
      throw new Error('images.json contains an invalid or duplicate image name');
    if (!/^sha256:[a-f0-9]{64}$/u.test(image.digest))
      throw new Error('images.json contains an invalid image digest');
    const expectedReference = `ghcr.io/${repository}-${image.name}@${image.digest}`;
    if (image.reference !== expectedReference || references.has(image.reference))
      throw new Error('images.json contains an unknown, malformed, or duplicate image reference');
    names.add(image.name);
    references.add(image.reference);
    return { name: image.name, reference: image.reference };
  });
}

function readExactJson(path, description) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('not an object');
    return value;
  } catch {
    throw new Error(`${description} must contain an exact JSON object`);
  }
}

export function verifyPublicArtifactRelease(options, run) {
  const { candidates, root } = releaseCandidates(resolve(options.directory));
  const repository = options.repository;
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('repository is invalid');
  const expectedSigner = `${repository}/.github/workflows/public-artifact-release.yml`;
  if (options.signerWorkflow !== expectedSigner) throw new Error('signer workflow is invalid');
  if (!TAG_REF_PATTERN.test(options.sourceRef)) throw new Error('source ref is invalid');
  if (!SHA_PATTERN.test(options.sourceDigest)) throw new Error('source digest is invalid');
  const authority = {
    repository,
    signerWorkflow: options.signerWorkflow,
    sourceRef: options.sourceRef,
    sourceDigest: options.sourceDigest,
  };
  const references = exactImageReferences(root, repository);
  const npmPredicate = readExactJson(
    join(root, 'npm-packages.spdx.json'),
    'npm-packages.spdx.json',
  );
  const verify = createGithubAttestationVerifier(run);
  for (const candidate of candidates) {
    verify(candidate, { ...authority, predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE });
    if (candidate.endsWith('.tgz'))
      verify(candidate, {
        ...authority,
        predicateType: GITHUB_SPDX_PREDICATE,
        expectedPredicate: npmPredicate,
      });
  }
  for (const { name, reference } of references) {
    const imagePredicate = readExactJson(
      join(root, `image-${name}.spdx.json`),
      `image-${name}.spdx.json`,
    );
    verify(`oci://${reference}`, {
      ...authority,
      predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
    });
    verify(`oci://${reference}`, {
      ...authority,
      predicateType: GITHUB_SPDX_PREDICATE,
      expectedPredicate: imagePredicate,
    });
  }
  return {
    files: candidates.length,
    npmTarballs: candidates.filter((path) => path.endsWith('.tgz')).length,
    images: references.length,
  };
}

export function verifyExistingPublicReleaseAssets(options, run) {
  const candidates = existingReleaseCandidates(resolve(options.directory));
  const repository = options.repository;
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('repository is invalid');
  const expectedSigner = `${repository}/.github/workflows/public-artifact-release.yml`;
  if (options.signerWorkflow !== expectedSigner) throw new Error('signer workflow is invalid');
  if (!TAG_REF_PATTERN.test(options.sourceRef)) throw new Error('source ref is invalid');
  if (!SHA_PATTERN.test(options.sourceDigest)) throw new Error('source digest is invalid');
  const verify = createGithubAttestationVerifier(run);
  for (const candidate of candidates)
    verify(candidate, {
      repository,
      signerWorkflow: options.signerWorkflow,
      sourceRef: options.sourceRef,
      sourceDigest: options.sourceDigest,
      predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
    });
  return { files: candidates.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parsePublicArtifactReleaseOptions(process.argv.slice(2));
  if (options.existingAssetsOnly) {
    const result = verifyExistingPublicReleaseAssets(options);
    process.stdout.write(`Verified provenance for ${result.files} existing release assets.\n`);
  } else {
    const result = verifyPublicArtifactRelease(options);
    process.stdout.write(
      `Verified ${result.files} public release files, ${result.npmTarballs} npm tarballs, and ${result.images} OCI images.\n`,
    );
  }
}
