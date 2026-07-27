import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertSecureGitProvenanceRoot } from './authoritative-public-repository.mjs';

function git(root: string, arguments_: string[], options: Record<string, unknown> = {}) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd: root,
    ...options,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

export const API_PROVENANCE_EXCLUSIONS = [
  'apps/admin-dashboard/next-env.d.ts',
  'apps/docs/public/contracts/',
  'apps/docs/public/openapi.json',
  'apps/docs/src/generated/',
  'artifacts/api/',
  'artifacts/api-integration-skills/',
  'distribution/public-distribution.json',
  'graphify-out/',
] as const;

export const canonicalJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const formatJson = (value: unknown, level = 0): string => {
  const indentation = '  '.repeat(level);
  const childIndentation = '  '.repeat(level + 1);
  if (Array.isArray(value)) {
    const compact = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    if (
      value.every(
        (item) => item === null || ['boolean', 'number', 'string'].includes(typeof item),
      ) &&
      value.length <= 3 &&
      indentation.length + compact.length <= 120
    )
      return compact;
    return `[\n${value.map((item) => `${childIndentation}${formatJson(item, level + 1)}`).join(',\n')}\n${indentation}]`;
  }
  if (value && typeof value === 'object')
    return `{\n${Object.entries(value)
      .map(
        ([key, item]) =>
          `${childIndentation}${JSON.stringify(key)}: ${formatJson(item, level + 1)}`,
      )
      .join(',\n')}\n${indentation}}`;
  return JSON.stringify(value);
};
export const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

export const isApiProvenanceOutput = (name: string): boolean =>
  API_PROVENANCE_EXCLUSIONS.some((excluded) =>
    excluded.endsWith('/') ? name.startsWith(excluded) : name === excluded,
  );

export async function collectApiReleaseProvenance(root: string) {
  assertSecureGitProvenanceRoot(root);
  const headCommit = git(root, ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const headTimestamp = git(root, ['show', '-s', '--format=%cI', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const headTreeHash = git(root, ['rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim();
  const inputs = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((name) => name && !isApiProvenanceOutput(name))
    .sort();
  const changes = git(root, ['status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/gu, '');
      return !isApiProvenanceOutput(path);
    });
  const inputHashes = await Promise.all(
    inputs.map(async (name) => {
      try {
        return { name, sha256: sha256(await readFile(resolve(root, name))) };
      } catch {
        return { name, sha256: sha256('<deleted>') };
      }
    }),
  );
  return {
    headCommit,
    headTimestamp,
    headTreeHash,
    sourceTreeHash: sha256(canonicalJson(inputHashes)),
    inputCount: inputHashes.length,
    worktreeState: changes.length === 0 ? ('clean' as const) : ('modified' as const),
  };
}

export function collectCommittedApiReleaseProvenance(root: string, commit: string) {
  assertSecureGitProvenanceRoot(root);
  const headCommit = git(root, ['rev-parse', '--verify', `${commit}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const headTimestamp = git(root, ['show', '-s', '--format=%cI', headCommit], {
    encoding: 'utf8',
  }).trim();
  const headTreeHash = git(root, ['rev-parse', `${headCommit}^{tree}`], {
    encoding: 'utf8',
  }).trim();
  const tree = git(root, ['ls-tree', '-rz', '--full-tree', headCommit], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = tree
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t');
      const [, type, object] = entry.slice(0, separator).split(' ');
      return { type, object, name: entry.slice(separator + 1) };
    })
    .filter(({ name, type }) => type === 'blob' && !isApiProvenanceOutput(name));
  const objects = git(root, ['cat-file', '--batch'], {
    input: `${entries.map(({ object }) => object).join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  const inputHashes = entries.map(({ name, object }) => {
    const headerEnd = objects.indexOf(10, offset);
    if (headerEnd === -1) throw new Error(`Missing Git object header for ${name}`);
    const [resolvedObject, type, rawSize] = objects
      .subarray(offset, headerEnd)
      .toString('utf8')
      .split(' ');
    const size = Number(rawSize);
    const dataStart = headerEnd + 1;
    const dataEnd = dataStart + size;
    if (resolvedObject !== object || type !== 'blob' || !Number.isSafeInteger(size))
      throw new Error(`Invalid Git object response for ${name}`);
    if (dataEnd >= objects.length || objects[dataEnd] !== 10)
      throw new Error(`Truncated Git object response for ${name}`);
    offset = dataEnd + 1;
    return { name, sha256: sha256(objects.subarray(dataStart, dataEnd)) };
  });
  inputHashes.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    headCommit,
    headTimestamp,
    headTreeHash,
    sourceTreeHash: sha256(canonicalJson(inputHashes)),
    inputCount: inputHashes.length,
    worktreeState: 'clean' as const,
  };
}
