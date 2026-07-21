import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  canonicalPolicyApprovalJson,
  policyApprovalPromotionViolations,
  policyApprovalReceiptSigningBytes,
  policyApprovalSha256,
  verifyPolicyApprovalPromotion,
} from '../lib/policy-approval-receipt.mjs';
import { validatePolicyPromotionCli } from '../validate-policy-promotion.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const receiptSchema = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'distribution/policy-approval-receipt.schema.json'), 'utf8'),
);
const keyringSchema = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'distribution/policy-approval-keyring.schema.json'), 'utf8'),
);
const now = Date.parse('2026-07-20T18:00:00.000Z');

function git(root, arguments_) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function canonicalFile(path, value) {
  writeFileSync(path, `${canonicalPolicyApprovalJson(value)}\n`, { mode: 0o600 });
}

function signingKey(role, suffix = role) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId: `${role}-${suffix}`,
    privateKey,
    trusted: {
      algorithm: 'Ed25519',
      publicKeyPem: String(publicKey.export({ type: 'spki', format: 'pem' })),
      role,
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    },
  };
}

function fixture(policyRecordId = 'data-residency') {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'tixkit-policy-approval-')));
  const artifactPath = 'docs/public/policy.mdx';
  const artifactBytes = Buffer.from('# Approved policy\n');
  const currentProgram = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'distribution/trust-program.json'), 'utf8'),
  );
  mkdirSync(resolve(root, 'docs/public'), { recursive: true });
  mkdirSync(resolve(root, 'distribution'));
  writeFileSync(resolve(root, artifactPath), artifactBytes);
  writeFileSync(
    resolve(root, 'distribution/public-distribution.json'),
    readFileSync(resolve(repositoryRoot, 'distribution/public-distribution.json')),
  );
  writeFileSync(
    resolve(root, 'distribution/trust-program.json'),
    readFileSync(resolve(repositoryRoot, 'distribution/trust-program.json')),
  );
  git(root, ['init', '-q']);
  git(root, [
    'add',
    artifactPath,
    'distribution/public-distribution.json',
    'distribution/trust-program.json',
  ]);
  git(root, [
    '-c',
    'user.name=Tixkit Test',
    '-c',
    'user.email=test@tixkit.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const sourceCommit = git(root, ['rev-parse', '--verify', 'HEAD']);
  const sourceTree = git(root, ['rev-parse', '--verify', 'HEAD^{tree}']);

  const proposedProgram = structuredClone(currentProgram);
  const currentRecord = currentProgram.records.find(({ id }) => id === policyRecordId);
  const proposedIndex = proposedProgram.records.findIndex(({ id }) => id === policyRecordId);
  assert.ok(currentRecord);
  assert.notEqual(proposedIndex, -1);
  proposedProgram.asOf = '2026-07-20';
  proposedProgram.records[proposedIndex] = {
    id: currentRecord.id,
    kind: currentRecord.kind,
    scope: currentRecord.scope,
    state: 'published',
    claim: `The approved ${policyRecordId} policy is published.`,
    lastVerified: '2026-07-20',
    publicArtifacts: [artifactPath],
  };

  const roles =
    policyRecordId === 'managed-sla'
      ? ['legal', 'operations', 'product']
      : policyRecordId === 'version-lifecycle'
        ? ['product', 'release', 'security']
        : policyRecordId === 'vulnerability-response'
          ? ['maintainer', 'security']
          : ['legal', 'privacy', 'product'];
  const keys = roles.map((role) => signingKey(role));
  const trustedKeyring = {
    schemaVersion: 1,
    purpose: 'tixkit.policy-approval-receipt',
    keys: Object.fromEntries(keys.map(({ keyId, trusted }) => [keyId, trusted])),
    decisions: {
      [policyRecordId]: {
        id: `policy-${policyRecordId}-approval`,
        version: 1,
        decidedAt: '2026-07-20T17:59:00.000Z',
        publicationAt: '2026-07-20T17:59:30.000Z',
        revokedAt: null,
      },
    },
  };
  const unsigned = {
    $schema: 'https://tixkit.com/schemas/policy-approval-receipt.schema.json',
    schemaVersion: 1,
    kind: 'tixkit.policy-approval-receipt',
    policyRecordId,
    source: {
      repository: 'tixkit/tixkit',
      commit: sourceCommit,
      tree: sourceTree,
    },
    decision: {
      id: `policy-${policyRecordId}-approval`,
      version: 1,
      decidedAt: '2026-07-20T17:59:00.000Z',
      publicationAt: '2026-07-20T17:59:30.000Z',
    },
    currentRecordSha256: policyApprovalSha256(currentRecord),
    proposedRecordSha256: policyApprovalSha256(proposedProgram.records[proposedIndex]),
    artifacts: [{ path: artifactPath, sha256: policyApprovalSha256(artifactBytes) }],
    signatures: keys.map(({ keyId, trusted }) => ({
      algorithm: 'Ed25519',
      keyId,
      role: trusted.role,
      value: '',
    })),
  };
  const signingBytes = policyApprovalReceiptSigningBytes(unsigned);
  const receipt = {
    ...unsigned,
    signatures: unsigned.signatures.map((signature, index) => ({
      ...signature,
      value: sign(null, signingBytes, keys[index].privateKey).toString('base64'),
    })),
  };
  return {
    currentProgram,
    keys,
    proposedProgram,
    receipt,
    repositoryRoot: root,
    root,
    trustedKeyring,
  };
}

function resign(candidate) {
  candidate.receipt.signatures = candidate.receipt.signatures.map((signature) => ({
    ...signature,
    value: '',
  }));
  const bytes = policyApprovalReceiptSigningBytes(candidate.receipt);
  candidate.receipt.signatures = candidate.receipt.signatures.map((signature, index) => ({
    ...signature,
    value: sign(null, bytes, candidate.keys[index].privateKey).toString('base64'),
  }));
}

function violations(candidate) {
  return policyApprovalPromotionViolations(candidate, { now });
}

function writeCliFiles(candidate) {
  const paths = {
    current: resolve(candidate.root, 'current.json'),
    proposed: resolve(candidate.root, 'proposed.json'),
    receipt: resolve(candidate.root, 'receipt.json'),
    keyring: resolve(candidate.root, 'keyring.json'),
  };
  writeFileSync(paths.current, `${JSON.stringify(candidate.currentProgram, null, 2)}\n`);
  writeFileSync(paths.proposed, `${JSON.stringify(candidate.proposedProgram, null, 2)}\n`);
  canonicalFile(paths.receipt, candidate.receipt);
  canonicalFile(paths.keyring, candidate.trustedKeyring);
  const argv = [
    '--current-program',
    paths.current,
    '--proposed-program',
    paths.proposed,
    '--receipt',
    paths.receipt,
    '--trusted-keyring',
    paths.keyring,
    '--repository-root',
    candidate.root,
  ];
  return { argv, paths };
}

test('strict draft 2020-12 schemas accept the bounded receipt and independent public keyring', () => {
  const candidate = fixture();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateReceipt = ajv.compile(receiptSchema);
  const validateKeyring = ajv.compile(keyringSchema);
  assert.equal(validateReceipt(candidate.receipt), true, JSON.stringify(validateReceipt.errors));
  assert.equal(
    validateKeyring(candidate.trustedKeyring),
    true,
    JSON.stringify(validateKeyring.errors),
  );
  const privateKeyring = structuredClone(candidate.trustedKeyring);
  privateKeyring.keys['legal-legal'].privateKeyPem = 'PRIVATE KEY';
  assert.equal(validateKeyring(privateKeyring), false);
});

test('returns only a frozen publication eligibility result and does not mutate inputs', () => {
  const candidate = fixture();
  const before = canonicalPolicyApprovalJson({
    currentProgram: candidate.currentProgram,
    proposedProgram: candidate.proposedProgram,
    receipt: candidate.receipt,
    trustedKeyring: candidate.trustedKeyring,
  });
  const result = verifyPolicyApprovalPromotion(candidate, { now });
  assert.deepEqual(result, { eligibleForPublication: true });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.keys(result).join(','), 'eligibleForPublication');
  assert.equal(
    canonicalPolicyApprovalJson({
      currentProgram: candidate.currentProgram,
      proposedProgram: candidate.proposedProgram,
      receipt: candidate.receipt,
      trustedKeyring: candidate.trustedKeyring,
    }),
    before,
  );
});

test('enforces every policy-specific role quorum', () => {
  for (const id of [
    'data-residency',
    'managed-sla',
    'privacy-roles',
    'subprocessors',
    'version-lifecycle',
    'vulnerability-response',
  ]) {
    assert.deepEqual(verifyPolicyApprovalPromotion(fixture(id), { now }), {
      eligibleForPublication: true,
    });
  }
});

test('rejects signer reuse, missing roles, role substitution, and receipt-supplied trust', () => {
  const reused = fixture();
  reused.receipt.signatures[1].keyId = reused.receipt.signatures[0].keyId;
  resign(reused);
  assert.match(violations(reused).join('\n'), /unique signer keys|role does not match/u);

  const missing = fixture();
  missing.receipt.signatures.pop();
  resign(missing);
  assert.match(violations(missing).join('\n'), /exact role quorum/u);

  const substituted = fixture();
  substituted.receipt.signatures[0].role = 'operations';
  resign(substituted);
  assert.match(violations(substituted).join('\n'), /exact role quorum|role does not match/u);

  const untrusted = fixture();
  delete untrusted.trustedKeyring.keys[untrusted.receipt.signatures[0].keyId];
  assert.match(violations(untrusted).join('\n'), /not independently trusted/u);

  const aliasedMaterial = fixture();
  const [first, second] = aliasedMaterial.receipt.signatures;
  aliasedMaterial.trustedKeyring.keys[second.keyId].publicKeyPem =
    aliasedMaterial.trustedKeyring.keys[first.keyId].publicKeyPem;
  assert.match(violations(aliasedMaterial).join('\n'), /unique public key material/u);
});

test('requires key validity at decision and publication and fails closed on revocation', () => {
  const expired = fixture();
  expired.trustedKeyring.keys[expired.receipt.signatures[0].keyId].validUntil =
    '2026-07-20T17:58:30.000Z';
  assert.match(violations(expired).join('\n'), /outside its validity window/u);

  const expiredBeforePublication = fixture();
  expiredBeforePublication.trustedKeyring.keys[
    expiredBeforePublication.receipt.signatures[0].keyId
  ].validUntil = '2026-07-20T17:59:15.000Z';
  assert.match(violations(expiredBeforePublication).join('\n'), /outside its validity window/u);

  const expiredAfterPublication = fixture();
  expiredAfterPublication.trustedKeyring.keys[
    expiredAfterPublication.receipt.signatures[0].keyId
  ].validUntil = '2026-07-20T17:59:45.000Z';
  assert.deepEqual(verifyPolicyApprovalPromotion(expiredAfterPublication, { now }), {
    eligibleForPublication: true,
  });

  const future = fixture();
  future.trustedKeyring.keys[future.receipt.signatures[0].keyId].validFrom =
    '2026-07-20T17:59:30.000Z';
  assert.match(violations(future).join('\n'), /outside its validity window/u);

  const revoked = fixture();
  revoked.trustedKeyring.keys[revoked.receipt.signatures[0].keyId].revokedAt =
    '2026-07-20T17:59:30.000Z';
  assert.match(violations(revoked).join('\n'), /is revoked/u);
});

test('rejects superseded and revoked policy decisions', () => {
  const superseded = fixture();
  superseded.trustedKeyring.decisions['data-residency'].version = 2;
  assert.match(
    violations(superseded).join('\n'),
    /current independently trusted decision version/u,
  );

  const revoked = fixture();
  revoked.trustedKeyring.decisions['data-residency'].revokedAt = '2026-07-20T18:00:00.000Z';
  assert.match(violations(revoked).join('\n'), /approval decision is revoked/u);
});

test('binds exact canonical current and proposed records plus decision identity and time', () => {
  const currentHash = fixture();
  currentHash.currentProgram.records.find(
    ({ id }) => id === currentHash.receipt.policyRecordId,
  ).claim += ' tampered';
  assert.match(violations(currentHash).join('\n'), /current record hash/u);

  const proposedHash = fixture();
  proposedHash.proposedProgram.records.find(
    ({ id }) => id === proposedHash.receipt.policyRecordId,
  ).claim += ' tampered';
  assert.match(violations(proposedHash).join('\n'), /proposed record hash/u);

  const decision = fixture();
  decision.receipt.decision.version = 2;
  assert.match(violations(decision).join('\n'), /signature is invalid/u);

  const historical = fixture();
  historical.receipt.decision.decidedAt = '2020-01-02T03:04:05.000Z';
  historical.trustedKeyring.decisions['data-residency'].decidedAt =
    historical.receipt.decision.decidedAt;
  for (const key of Object.values(historical.trustedKeyring.keys)) {
    key.validFrom = '2019-01-01T00:00:00.000Z';
  }
  resign(historical);
  assert.deepEqual(verifyPolicyApprovalPromotion(historical, { now }), {
    eligibleForPublication: true,
  });

  const regressed = fixture();
  regressed.receipt.decision.publicationAt = '2020-01-02T03:05:00.000Z';
  regressed.trustedKeyring.decisions['data-residency'].publicationAt =
    regressed.receipt.decision.publicationAt;
  regressed.proposedProgram.asOf = '2020-01-02';
  const regressedRecord = regressed.proposedProgram.records.find(
    ({ id }) => id === regressed.receipt.policyRecordId,
  );
  regressedRecord.lastVerified = '2020-01-02';
  regressed.receipt.proposedRecordSha256 = policyApprovalSha256(regressedRecord);
  resign(regressed);
  assert.match(
    violations(regressed).join('\n'),
    /publication date must not regress the current trust-program snapshot/u,
  );
});

test('derives source commit and tree from authoritative HEAD with replacement objects disabled', () => {
  const commitSubstitution = fixture();
  commitSubstitution.receipt.source.commit = 'c'.repeat(40);
  resign(commitSubstitution);
  assert.match(
    violations(commitSubstitution).join('\n'),
    /does not match authoritative repository HEAD/u,
  );

  const substituted = fixture();
  substituted.receipt.source.tree = 'c'.repeat(40);
  resign(substituted);
  assert.match(violations(substituted).join('\n'), /does not match authoritative repository HEAD/u);

  const replaced = fixture();
  writeFileSync(resolve(replaced.root, 'replacement-marker'), 'attacker tree\n');
  git(replaced.root, ['add', 'replacement-marker']);
  const replacementTree = git(replaced.root, ['write-tree']);
  const replacementCommit = git(replaced.root, [
    '-c',
    'user.name=Tixkit Test',
    '-c',
    'user.email=test@tixkit.invalid',
    'commit-tree',
    replacementTree,
    '-p',
    replaced.receipt.source.commit,
    '-m',
    'replacement',
  ]);
  git(replaced.root, [
    'update-ref',
    `refs/replace/${replaced.receipt.source.commit}`,
    replacementCommit,
  ]);
  replaced.receipt.source.tree = replacementTree;
  resign(replaced);
  assert.match(violations(replaced).join('\n'), /does not match authoritative repository HEAD/u);

  const nested = fixture();
  nested.repositoryRoot = resolve(nested.root, 'docs/public');
  assert.match(violations(nested).join('\n'), /repository root must be the Git top level/u);

  const isolated = fixture();
  const inherited = Object.fromEntries(
    ['GIT_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_WORK_TREE', 'GIT_NO_REPLACE_OBJECTS', 'PATH'].map(
      (name) => [name, process.env[name]],
    ),
  );
  try {
    process.env.GIT_DIR = resolve(isolated.root, 'missing-git-dir');
    process.env.GIT_OBJECT_DIRECTORY = resolve(isolated.root, 'missing-objects');
    process.env.GIT_WORK_TREE = resolve(isolated.root, 'missing-worktree');
    process.env.GIT_NO_REPLACE_OBJECTS = '0';
    process.env.PATH = resolve(isolated.root, 'attacker-bin');
    assert.deepEqual(verifyPolicyApprovalPromotion(isolated, { now }), {
      eligibleForPublication: true,
    });
  } finally {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('allows no unrelated surface, record, root, or target-record drift', () => {
  const surface = fixture();
  surface.proposedProgram.surfaces[0].recordIds.push('managed-sla');
  assert.match(violations(surface).join('\n'), /forbidden trust-program field: surfaces/u);

  const record = fixture();
  record.proposedProgram.records[0].claim += ' changed';
  assert.match(violations(record).join('\n'), /changes unrelated record/u);

  const forgedBaseline = fixture();
  forgedBaseline.currentProgram.records[0].claim += ' changed before approval';
  forgedBaseline.proposedProgram.records[0].claim += ' changed before approval';
  assert.match(
    violations(forgedBaseline).join('\n'),
    /current trust program does not match authoritative repository HEAD/u,
  );

  const root = fixture();
  root.proposedProgram.documentation = 'docs/public/other.mdx';
  assert.match(violations(root).join('\n'), /documentation/u);

  const target = fixture();
  target.proposedProgram.records.find(({ id }) => id === target.receipt.policyRecordId).blocker =
    'still blocked';
  assert.match(violations(target).join('\n'), /exact published shape/u);
});

test('requires exact sorted artifact paths and secure digest-bound regular-file reads', () => {
  const digest = fixture();
  writeFileSync(resolve(digest.root, 'docs/public/policy.mdx'), '# substituted policy\n');
  assert.match(violations(digest).join('\n'), /artifact digest does not match/u);

  const symlink = fixture();
  const external = resolve(symlink.root, 'external.mdx');
  writeFileSync(external, '# Approved policy\n');
  const artifact = resolve(symlink.root, 'docs/public/policy.mdx');
  unlinkSync(artifact);
  symlinkSync(external, artifact);
  assert.match(violations(symlink).join('\n'), /non-symlink regular file/u);

  const mismatch = fixture();
  mismatch.receipt.artifacts[0].path = 'docs/other.mdx';
  resign(mismatch);
  assert.match(violations(mismatch).join('\n'), /do not exactly match/u);

  const privatePath = fixture();
  mkdirSync(resolve(privatePath.root, 'docs/internal'));
  const secret = Buffer.from('# Internal policy\n');
  writeFileSync(resolve(privatePath.root, 'docs/internal/secret.mdx'), secret);
  const proposedRecord = privatePath.proposedProgram.records.find(
    ({ id }) => id === privatePath.receipt.policyRecordId,
  );
  proposedRecord.publicArtifacts = ['docs/internal/secret.mdx'];
  privatePath.receipt.artifacts = [
    { path: 'docs/internal/secret.mdx', sha256: policyApprovalSha256(secret) },
  ];
  privatePath.receipt.proposedRecordSha256 = policyApprovalSha256(proposedRecord);
  resign(privatePath);
  assert.match(violations(privatePath).join('\n'), /not classified for public distribution/u);
});

test('rejects inherited/accessor JSON properties before schema or signature evaluation', () => {
  const inherited = fixture();
  Object.setPrototypeOf(inherited.receipt, { policyRecordId: 'data-residency' });
  assert.match(violations(inherited).join('\n'), /own-property plain JSON object/u);

  const accessor = fixture();
  Object.defineProperty(accessor.trustedKeyring.keys, 'attacker', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  assert.doesNotThrow(() => violations(accessor));
  assert.match(violations(accessor).join('\n'), /enumerable own data property/u);
});

test('CLI reads canonical bounded files without modifying or promoting them', () => {
  const candidate = fixture();
  const { argv, paths } = writeCliFiles(candidate);
  const before = Object.values(paths).map((path) => readFileSync(path));
  const result = validatePolicyPromotionCli(argv);
  assert.deepEqual(result, { eligibleForPublication: true });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(
    Object.values(paths).map((path) => readFileSync(path)),
    before,
  );
});

test('CLI rejects missing, duplicated, unsupported, and symlinked trust inputs', () => {
  const valid = writeCliFiles(fixture());
  assert.throws(
    () => validatePolicyPromotionCli(valid.argv.slice(0, -2)),
    /required exactly once/u,
  );
  assert.throws(
    () =>
      validatePolicyPromotionCli([...valid.argv.slice(0, -2), '--receipt', valid.paths.receipt]),
    /duplicated|unsupported/u,
  );
  assert.throws(
    () => validatePolicyPromotionCli([...valid.argv.slice(0, -2), '--unsupported', 'value']),
    /duplicated|unsupported/u,
  );

  for (const field of ['current', 'proposed', 'receipt', 'keyring']) {
    const candidate = fixture();
    const files = writeCliFiles(candidate);
    const target = `${files.paths[field]}.regular`;
    renameSync(files.paths[field], target);
    symlinkSync(target, files.paths[field]);
    assert.throws(() => validatePolicyPromotionCli(files.argv), /non-symlink regular file/u);
  }
});
