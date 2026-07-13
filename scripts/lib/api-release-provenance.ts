import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const API_PROVENANCE_EXCLUSIONS = [
  'apps/docs/public/contracts/',
  'apps/docs/public/openapi.json',
  'apps/docs/src/generated/',
  'artifacts/api/',
  'graphify-out/',
] as const;

export const canonicalJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

export const isApiProvenanceOutput = (name: string): boolean =>
  API_PROVENANCE_EXCLUSIONS.some((excluded) =>
    excluded.endsWith('/') ? name.startsWith(excluded) : name === excluded,
  );

export async function collectApiReleaseProvenance(root: string) {
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const headTimestamp = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const headTreeHash = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const inputs = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter((name) => name && !isApiProvenanceOutput(name))
    .sort();
  const changes = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
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
  const headCommit = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const headTimestamp = execFileSync('git', ['show', '-s', '--format=%cI', headCommit], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const headTreeHash = execFileSync('git', ['rev-parse', `${headCommit}^{tree}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['ls-tree', '-rz', '--full-tree', headCommit], {
    cwd: root,
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
  const objects = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
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
