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
