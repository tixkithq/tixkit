import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  auditRepositoryCredentialHistory,
  auditRepositoryHistory,
  highConfidenceSecretKinds,
  parseRawHistory,
  safeHistoryAuditOutput,
} from '../lib/repository-history-audit.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.name=History Audit Test',
    '-c',
    'user.email=history-audit@tixkit.invalid',
    'commit',
    '-qm',
    message,
  ]);
}

function manifest() {
  return {
    classification: {
      historyValidation: 'full',
      historyScope: 'head-and-tags',
      historical: { public: [], privateCloud: [], internalPlanning: [] },
      topLevel: { public: ['README.md'], privateCloud: [], internalPlanning: [], mixed: [] },
      docs: { public: [], internalPlanning: [] },
      generatedRoots: [],
    },
  };
}

test('parses old and new blobs from NUL-delimited raw history', () => {
  const oldId = '1'.repeat(40);
  const newId = '2'.repeat(40);
  const parsed = parseRawHistory(`:100644 100644 ${oldId} ${newId} M\0README.md\0`);
  assert.deepEqual([...parsed.get(oldId)], ['README.md']);
  assert.deepEqual([...parsed.get(newId)], ['README.md']);
});

test('audits deleted private-history blobs and commit metadata without a public manifest', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-private-history-audit-'));
  try {
    git(root, ['init', '-q']);
    writeFileSync(resolve(root, 'cloud.ts'), `export const secret = 'npm_${'J'.repeat(24)}';\n`);
    commit(root, 'private secret');
    writeFileSync(resolve(root, 'cloud.ts'), 'export const clean = true;\n');
    commit(root, `remove secret github_pat_${'K'.repeat(24)}`);
    const result = auditRepositoryCredentialHistory(root);
    assert.equal(result.status, 'fail');
    assert.ok(result.findings.some(({ secretKinds }) => secretKinds.includes('npm-token')));
    assert.deepEqual(result.metadataSecretKinds, ['github-token']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detects high-confidence secrets without returning values and allows fixed fixtures', () => {
  const credentials = [
    [`ASIA${'A'.repeat(16)}`, 'aws-access-key'],
    [`github_pat_${'B'.repeat(24)}`, 'github-token'],
    [`npm_${'C'.repeat(24)}`, 'npm-token'],
    [`sk_test_${'D'.repeat(24)}`, 'stripe-api-key'],
    [`rk_test_${'E'.repeat(24)}`, 'stripe-api-key'],
    [`whsec_${'F'.repeat(24)}`, 'stripe-webhook-secret'],
    [['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '), 'private-key'],
  ];
  for (const [credential, kind] of credentials)
    assert.deepEqual(highConfidenceSecretKinds(Buffer.from(`token ${credential}`)), [kind]);
  assert.deepEqual(
    highConfidenceSecretKinds(Buffer.from(['tk_test_', '1234567890abcdef'].join(''))),
    [],
  );
});

test('audits every historical blob and fails on a secret removed from HEAD', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-history-audit-'));
  try {
    git(root, ['init', '-q']);
    writeFileSync(resolve(root, 'README.md'), `ghp_${'A'.repeat(36)}\n`);
    commit(root, 'secret');
    writeFileSync(resolve(root, 'README.md'), '# clean\n');
    commit(root, 'remove secret');

    const result = auditRepositoryHistory(root, manifest());
    assert.equal(result.status, 'fail');
    assert.equal(result.commitCount, 2);
    assert.equal(result.uniqueBlobCount, 2);
    assert.deepEqual(
      result.findings.map(({ secretKinds }) => secretKinds),
      [['github-token']],
    );
    assert.equal('paths' in result.findings[0], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audits blobs introduced only by a merge commit', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-history-merge-audit-'));
  try {
    git(root, ['init', '-q']);
    writeFileSync(resolve(root, 'README.md'), '# initial\n');
    commit(root, 'initial');
    git(root, ['checkout', '-qb', 'feature']);
    writeFileSync(resolve(root, 'feature.md'), '# feature\n');
    commit(root, 'feature');
    git(root, ['checkout', '-q', '-']);
    writeFileSync(resolve(root, 'README.md'), '# main\n');
    commit(root, 'main');
    git(root, ['merge', '--no-ff', '--no-commit', 'feature']);
    writeFileSync(resolve(root, 'merge-only.md'), `ghp_${'B'.repeat(36)}\n`);
    commit(root, 'merge with exclusive content');

    const fixtureManifest = manifest();
    fixtureManifest.classification.topLevel.public.push('feature.md', 'merge-only.md');
    const result = auditRepositoryHistory(root, fixtureManifest);
    assert.equal(result.status, 'fail');
    assert.equal(result.commitCount, 4);
    assert.ok(result.findings.some(({ secretKinds }) => secretKinds.includes('github-token')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires a new mode-0600 report under the system temporary directory', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-history-output-'));
  try {
    assert.equal(
      safeHistoryAuditOutput(resolve(root, 'audit.json')),
      resolve(realpathSync(root), 'audit.json'),
    );
    assert.throws(
      () => safeHistoryAuditOutput(resolve(realpathSync(tmpdir()), '..', 'audit.json')),
      /system temporary directory/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects dirty and shallow audit inputs', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-history-trust-'));
  try {
    git(root, ['init', '-q']);
    writeFileSync(resolve(root, 'README.md'), '# clean\n');
    commit(root, 'initial');
    writeFileSync(resolve(root, 'dirty.md'), 'not committed\n');
    assert.throws(() => auditRepositoryHistory(root, manifest()), /clean worktree/u);
    rmSync(resolve(root, 'dirty.md'));
    writeFileSync(resolve(root, '.git/shallow'), `${git(root, ['rev-parse', 'HEAD'])}\n`);
    assert.throws(() => auditRepositoryHistory(root, manifest()), /complete ancestry/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audits tagged history that is not reachable from HEAD', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-history-tag-'));
  try {
    git(root, ['init', '-q']);
    writeFileSync(resolve(root, 'README.md'), '# main\n');
    commit(root, 'main');
    const main = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '--orphan', 'tagged-secret']);
    git(root, ['rm', '-q', '-rf', '.']);
    writeFileSync(resolve(root, 'README.md'), `whsec_${'G'.repeat(24)}\n`);
    commit(root, 'tagged secret');
    git(root, ['tag', 'v0-secret']);
    git(root, ['checkout', '-q', main]);

    const result = auditRepositoryHistory(root, manifest());
    assert.equal(result.status, 'fail');
    assert.equal(result.commitCount, 2);
    assert.ok(
      result.findings.some(({ secretKinds }) => secretKinds.includes('stripe-webhook-secret')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not let Git replacement objects sanitize audited history', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-history-replace-'));
  try {
    git(root, ['init', '-q']);
    writeFileSync(resolve(root, 'README.md'), `github_pat_${'H'.repeat(24)}\n`);
    commit(root, 'secret history');
    const secretCommit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '--orphan', 'sanitized']);
    git(root, ['rm', '-q', '-rf', '.']);
    writeFileSync(resolve(root, 'README.md'), '# sanitized\n');
    commit(root, 'sanitized replacement');
    const sanitizedCommit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['replace', secretCommit, sanitizedCommit]);
    git(root, ['checkout', '-q', '--detach', secretCommit]);
    git(root, ['reset', '-q', '--hard', secretCommit]);

    assert.throws(() => auditRepositoryHistory(root, manifest()), /clean worktree/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
