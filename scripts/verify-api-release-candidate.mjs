#!/usr/bin/env node

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_BUILD_PROVENANCE_PREDICATE,
  createGithubAttestationVerifier,
} from './lib/github-attestation.mjs';

const OPTION_NAMES = new Set([
  '--directory',
  '--repository',
  '--signer-workflow',
  '--source-ref',
  '--source-digest',
]);
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/u;
const TAG_REF_PATTERN = /^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

export function parseApiReleaseCandidateOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTION_NAMES.has(name)) throw new Error(`unknown option: ${name ?? '<missing>'}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate option: ${name}`);
    if (!value || value.startsWith('-') || hasControlCharacters(value))
      throw new Error(`${name} has an invalid value`);
    values[name] = value;
  }
  for (const name of OPTION_NAMES)
    if (!Object.hasOwn(values, name)) throw new Error(`${name} is required`);
  if (!REPOSITORY_PATTERN.test(values['--repository'])) throw new Error('repository is invalid');
  const expectedSigner = `${values['--repository']}/.github/workflows/api-contract-release.yml`;
  if (values['--signer-workflow'] !== expectedSigner)
    throw new Error(`signer workflow must be exactly ${expectedSigner}`);
  if (!TAG_REF_PATTERN.test(values['--source-ref'])) throw new Error('source ref is invalid');
  if (!DIGEST_PATTERN.test(values['--source-digest'])) throw new Error('source digest is invalid');
  return {
    directory: resolve(values['--directory']),
    repository: values['--repository'],
    signerWorkflow: values['--signer-workflow'],
    sourceRef: values['--source-ref'],
    sourceDigest: values['--source-digest'],
  };
}

export function verifyApiReleaseCandidate(options, run) {
  const metadata = lstatSync(options.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error('API release candidate must be a real directory');
  const directory = realpathSync(options.directory);
  const files = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error(`API release candidate entries must be regular files: ${entry.name}`);
      return join(directory, entry.name);
    });
  if (files.length === 0) throw new Error('API release candidate is empty');
  const verify = createGithubAttestationVerifier(run);
  for (const file of files)
    verify(file, {
      repository: options.repository,
      signerWorkflow: options.signerWorkflow,
      sourceRef: options.sourceRef,
      sourceDigest: options.sourceDigest,
      predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
    });
  return { files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = verifyApiReleaseCandidate(parseApiReleaseCandidateOptions(process.argv.slice(2)));
  process.stdout.write(`Verified provenance for ${result.files} API release candidate files.\n`);
}
