import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const verifierPath = join(repositoryRoot, 'infra/ci/scripts/verify-arc-kata.sh');
const manifestPath = join(repositoryRoot, 'infra/ci/k8s/trusted-ci-mssql.yaml');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function verifyManifest(addition) {
  const root = await mkdtemp(join(tmpdir(), 'tixkit-arc-verifier-'));
  temporaryDirectories.push(root);
  const candidatePath = join(root, 'trusted-ci-mssql.yaml');
  const manifest = await readFile(manifestPath, 'utf8');
  await writeFile(candidatePath, `${addition}\n---\n${manifest}`);

  return spawnSync('bash', [verifierPath, '--supply-chain-only'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, TIXKIT_MSSQL_MANIFEST: candidatePath },
  });
}

for (const [description, secretDocument] of [
  [
    'block-style Secret',
    `apiVersion: v1
kind: Secret
data:
  MSSQL_SA_PASSWORD: dW5zYWZl`,
  ],
  [
    'flow-style Secret',
    `apiVersion: v1
kind: Secret
data: {MSSQL_SA_PASSWORD: dW5zYWZl}`,
  ],
  [
    'quoted flow-style Secret',
    `{"apiVersion": "v1", "kind": "Secret", "data": {"MSSQL_SA_PASSWORD": "dW5zYWZl"}}`,
  ],
]) {
  test(`rejects an embedded ${description} in the trusted MSSQL workload manifest`, async () => {
    const result = await verifyManifest(secretDocument);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not create the externally provisioned Secret/);
  });
}
