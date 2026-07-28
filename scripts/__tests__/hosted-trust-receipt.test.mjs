import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  canonicalHostedTrustJson,
  hostedTrustReceiptSigningBytes,
  hostedTrustReceiptViolations,
  loadAndVerifyHostedTrustReceipt,
  parseCanonicalHostedTrustJson,
  readBoundedRegularFile,
  sha256,
  verifyHostedTrustReceipt,
} from '../lib/hosted-trust-receipt.mjs';

const now = Date.UTC(2026, 6, 17, 12);
const repositoryRoot = resolve(import.meta.dirname, '../..');
const cli = resolve(repositoryRoot, 'scripts/validate-hosted-trust-receipt.mjs');
const receiptSchema = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'distribution/hosted-trust-receipt.schema.json'), 'utf8'),
);
const keyringSchema = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'distribution/hosted-trust-keyring.schema.json'), 'utf8'),
);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'epyc-trust-2026-07';
const artifactBytes = Buffer.from(
  `${canonicalHostedTrustJson({ schemaVersion: 1, status: 'passed', sampleCount: 30 })}\n`,
);

const keyring = {
  schemaVersion: 1,
  purpose: 'tixkit.hosted-trust-receipt',
  keys: {
    [keyId]: {
      algorithm: 'Ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  },
};

function unsignedReceipt() {
  return {
    $schema: 'https://tixkit.com/schemas/hosted-trust-receipt.schema.json',
    schemaVersion: 1,
    kind: 'tixkit.hosted-trust-receipt',
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    source: {
      repository: 'tixkithq/tixkit',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
    },
    workflow: {
      repository: 'tixkithq/tixkit',
      path: '.github/workflows/performance-capacity.yml',
      runId: '987654321',
      attempt: 1,
      url: 'https://github.com/tixkithq/tixkit/actions/runs/987654321',
    },
    artifact: {
      kind: 'performance-capacity',
      sizeBytes: artifactBytes.byteLength,
      sha256: sha256(artifactBytes),
    },
    validation: {
      validator: 'scripts/performance-capacity.mjs#validateCapacityEvidence',
      version: 1,
      outcome: 'passed',
    },
    observedAt: new Date(now - 60_000).toISOString(),
    signature: { algorithm: 'Ed25519', keyId, value: '' },
  };
}

function signedReceipt(mutate = () => undefined, signingKey = privateKey) {
  const receipt = unsignedReceipt();
  mutate(receipt);
  receipt.signature.value = sign(
    null,
    hostedTrustReceiptSigningBytes(receipt),
    signingKey,
  ).toString('base64');
  return receipt;
}

function violations(receipt, bytes = artifactBytes, trusted = keyring, options = { now }) {
  return hostedTrustReceiptViolations(receipt, bytes, trusted, options).join('\n');
}

function canonicalFile(path, value) {
  writeFileSync(path, `${canonicalHostedTrustJson(value)}\n`, { mode: 0o600 });
}

test('strict draft 2020-12 schema accepts only the closed v1 receipt', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(receiptSchema);
  assert.equal(validate(signedReceipt()), true, JSON.stringify(validate.errors));
  const candidate = signedReceipt();
  candidate.privateTopology = 'internal.example';
  assert.equal(validate(candidate), false);
});

test('strict draft 2020-12 keyring schema accepts only public Ed25519 trust material', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(keyringSchema);
  assert.equal(validate(keyring), true, JSON.stringify(validate.errors));

  for (const mutate of [
    (candidate) => (candidate.unreviewedTrust = true),
    (candidate) => (candidate.keys = {}),
    (candidate) =>
      (candidate.keys = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`key-${index}`, candidate.keys[keyId]]),
      )),
    (candidate) => (candidate.keys[keyId].algorithm = 'RSA'),
    (candidate) => (candidate.keys[keyId].privateKeyPem = 'forbidden'),
    (candidate) =>
      (candidate.keys[keyId].publicKeyPem = privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString()),
    (candidate) => (candidate.keys['invalid key id'] = candidate.keys[keyId]),
  ]) {
    const candidate = structuredClone(keyring);
    mutate(candidate);
    assert.equal(validate(candidate), false);
  }
});

test('verifies a signed receipt without mutating trust or evidence inputs', () => {
  const receipt = signedReceipt();
  const before = canonicalHostedTrustJson({ receipt, keyring });
  const result = verifyHostedTrustReceipt({ receipt, artifactBytes, keyring, options: { now } });

  assert.deepEqual(result, {
    verified: true,
    trustRecordId: 'performance-evidence',
    artifactKind: 'performance-capacity',
    artifactSha256: sha256(artifactBytes),
    sourceCommit: 'a'.repeat(40),
    workflowRunId: '987654321',
    observedAt: new Date(now - 60_000).toISOString(),
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(canonicalHostedTrustJson({ receipt, keyring }), before);
  assert.equal('state' in result, false);
});

test('binds supported-profile capacity to its distinct semantic validator tuple', () => {
  const profileReceipt = signedReceipt((receipt) => {
    receipt.workflow.path = '.github/workflows/performance-profile-capacity.yml';
    receipt.artifact.kind = 'performance-profile-capacity';
    receipt.validation.validator =
      'scripts/performance-profile-capacity.mjs#verifySupportedProfileCapacityEvidence';
  });
  assert.equal(violations(profileReceipt), '');
  assert.equal(
    verifyHostedTrustReceipt({
      receipt: profileReceipt,
      artifactBytes,
      keyring,
      options: { now },
    }).artifactKind,
    'performance-profile-capacity',
  );

  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.workflow.path = '.github/workflows/performance-profile-capacity.yml';
        receipt.artifact.kind = 'performance-profile-capacity';
      }),
    ),
    /disagree/u,
  );
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.workflow.path = '.github/workflows/performance-profile-capacity.yml';
        receipt.validation.validator =
          'scripts/performance-profile-capacity.mjs#verifySupportedProfileCapacityEvidence';
      }),
    ),
    /disagree/u,
  );
});

test('rejects altered source, signature, artifact bytes, digest, and size', () => {
  const alteredSource = signedReceipt();
  alteredSource.source.commit = 'c'.repeat(40);
  assert.match(violations(alteredSource), /signature is invalid/u);

  const alteredSignature = signedReceipt();
  const alteredSignatureBytes = Buffer.from(alteredSignature.signature.value, 'base64');
  alteredSignatureBytes[0] ^= 0x01;
  alteredSignature.signature.value = alteredSignatureBytes.toString('base64');
  assert.match(violations(alteredSignature), /signature is invalid/u);

  assert.match(violations(signedReceipt(), Buffer.from('{}\n')), /artifact (?:size|digest)/u);
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.artifact.sha256 = '0'.repeat(64);
      }),
    ),
    /artifact digest/u,
  );
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.artifact.sizeBytes += 1;
      }),
    ),
    /artifact size/u,
  );
});

test('rejects wrong record, scope, workflow, validator, repository, and run URL bindings', () => {
  for (const mutate of [
    (receipt) => (receipt.trustRecordId = 'dr-evidence'),
    (receipt) => (receipt.scope = 'self-hosted'),
    (receipt) => (receipt.workflow.path = '.github/workflows/performance-fault.yml'),
    (receipt) =>
      (receipt.validation.validator = 'scripts/performance-fault.mjs#validateFaultEvidence'),
    (receipt) => (receipt.workflow.repository = 'tixkithq/tixkit-cloud'),
    (receipt) => (receipt.workflow.url = 'https://github.com/tixkithq/tixkit/actions/runs/123'),
  ]) {
    assert.notEqual(violations(signedReceipt(mutate)), '');
  }
});

test('rejects production DR receipts until a dedicated semantic producer exists', () => {
  const candidate = signedReceipt((receipt) => {
    receipt.trustRecordId = 'dr-evidence';
    receipt.scope = 'self-hosted';
    receipt.workflow.path = '.github/workflows/trusted-release-dry-run.yml';
    receipt.artifact.kind = 'production-dr';
    receipt.validation.validator = 'scripts/verify-production-rehearsal.mjs#cli';
  });

  assert.match(violations(candidate), /must be one of/u);
});

test('rejects unsupported, unknown, private, and non-Ed25519 trust keys', () => {
  const unknown = signedReceipt((receipt) => {
    receipt.signature.keyId = 'unknown-key';
  });
  assert.match(violations(unknown), /signature key is not trusted/u);

  const wrongAlgorithm = structuredClone(keyring);
  wrongAlgorithm.keys[keyId].algorithm = 'RSA';
  assert.match(violations(signedReceipt(), artifactBytes, wrongAlgorithm), /algorithm/u);

  const privateMaterial = structuredClone(keyring);
  privateMaterial.keys[keyId].publicKeyPem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  assert.match(
    violations(signedReceipt(), artifactBytes, privateMaterial),
    /public key is invalid/u,
  );

  const { publicKey: rsaPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongType = structuredClone(keyring);
  wrongType.keys[keyId].publicKeyPem = rsaPublicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  assert.match(violations(signedReceipt(), artifactBytes, wrongType), /must contain an Ed25519/u);

  const trailingMaterial = structuredClone(keyring);
  trailingMaterial.keys[keyId].publicKeyPem += 'secret=private-topology\n';
  assert.match(
    violations(signedReceipt(), artifactBytes, trailingMaterial),
    /canonical SPKI PEM only/u,
  );
});

test('rejects inherited receipt fields and prototype-provided trust keys', () => {
  const inheritedRequired = signedReceipt();
  delete inheritedRequired.trustRecordId;
  Object.setPrototypeOf(inheritedRequired, { trustRecordId: 'performance-evidence' });
  assert.match(violations(inheritedRequired), /own-property plain JSON object/u);
  assert.throws(
    () => hostedTrustReceiptSigningBytes(inheritedRequired),
    /own-property plain JSON object/u,
  );

  const inheritedSemantic = signedReceipt();
  delete inheritedSemantic.artifact.kind;
  Object.setPrototypeOf(inheritedSemantic.artifact, { kind: 'performance-capacity' });
  assert.match(violations(inheritedSemantic), /own-property plain JSON object/u);

  const { privateKey: attackerPrivateKey, publicKey: attackerPublicKey } =
    generateKeyPairSync('ed25519');
  const attackerKeyId = 'attacker-inherited-key';
  const inheritedKeys = structuredClone(keyring);
  Object.setPrototypeOf(inheritedKeys.keys, {
    [attackerKeyId]: {
      algorithm: 'Ed25519',
      publicKeyPem: attackerPublicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  });
  const attackerReceipt = signedReceipt((receipt) => {
    receipt.signature.keyId = attackerKeyId;
  }, attackerPrivateKey);
  assert.match(
    violations(attackerReceipt, artifactBytes, inheritedKeys),
    /own-property plain JSON object/u,
  );

  // oxlint-disable-next-line no-extend-native -- Exercise fail-closed behavior under ambient prototype pollution.
  Object.defineProperty(Object.prototype, attackerKeyId, {
    configurable: true,
    enumerable: true,
    value: {
      algorithm: 'Ed25519',
      publicKeyPem: attackerPublicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  });
  try {
    assert.match(
      violations(attackerReceipt, artifactBytes, keyring),
      /signature key is not trusted/u,
    );
  } finally {
    delete Object.prototype[attackerKeyId];
  }
});

test('rejects missing own receipt fields supplied by ambient prototype pollution', () => {
  function signOmittingInheritedFields(receipt) {
    const { value: _value, ...signature } = receipt.signature;
    receipt.signature.value = sign(
      null,
      Buffer.from(canonicalHostedTrustJson({ ...receipt, signature }), 'utf8'),
      privateKey,
    ).toString('base64');
    return receipt;
  }

  const inheritedRoot = unsignedReceipt();
  delete inheritedRoot.trustRecordId;
  const inheritedNested = unsignedReceipt();
  delete inheritedNested.artifact.kind;
  const inheritedKeyringRoot = structuredClone(keyring);
  delete inheritedKeyringRoot.purpose;
  const inheritedKeyringEntry = structuredClone(keyring);
  delete inheritedKeyringEntry.keys[keyId].algorithm;

  // oxlint-disable-next-line no-extend-native -- Exercise fail-closed behavior under ambient prototype pollution.
  Object.defineProperties(Object.prototype, {
    trustRecordId: {
      configurable: true,
      enumerable: true,
      value: 'performance-evidence',
    },
    kind: {
      configurable: true,
      enumerable: true,
      value: 'performance-capacity',
    },
    purpose: {
      configurable: true,
      enumerable: true,
      value: 'tixkit.hosted-trust-receipt',
    },
    algorithm: {
      configurable: true,
      enumerable: true,
      value: 'Ed25519',
    },
  });
  try {
    signOmittingInheritedFields(inheritedRoot);
    signOmittingInheritedFields(inheritedNested);
    assert.match(
      violations(inheritedRoot),
      /hosted trust receipt\.trustRecordId must be an enumerable own data property/u,
    );
    assert.match(
      violations(inheritedNested),
      /hosted trust receipt\.artifact\.kind must be an enumerable own data property/u,
    );
    assert.throws(
      () => hostedTrustReceiptSigningBytes(inheritedRoot),
      /trustRecordId must be an enumerable own data property/u,
    );
    assert.match(
      violations(signedReceipt(), artifactBytes, inheritedKeyringRoot),
      /trusted keyring\.purpose must be an enumerable own data property/u,
    );
    assert.match(
      violations(signedReceipt(), artifactBytes, inheritedKeyringEntry),
      new RegExp(
        `trusted keyring\\.keys\\.${keyId}\\.algorithm must be an enumerable own data property`,
        'u',
      ),
    );
  } finally {
    delete Object.prototype.trustRecordId;
    delete Object.prototype.kind;
    delete Object.prototype.purpose;
    delete Object.prototype.algorithm;
  }
});

test('rejects future, stale, noncanonical, and excessive workflow time evidence', () => {
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.observedAt = new Date(now + 5 * 60_000 + 1).toISOString();
      }),
    ),
    /in the future/u,
  );
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.observedAt = new Date(now - 90 * 24 * 60 * 60_000 - 1).toISOString();
      }),
    ),
    /is stale/u,
  );
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.observedAt = '2026-07-17T11:59:00Z';
      }),
    ),
    /observedAt must match|canonical UTC timestamp/u,
  );
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.workflow.attempt = 101;
      }),
    ),
    /attempt must be between 1 and 100/u,
  );
});

test('closed schema rejects undeclared secret, topology, claim, and signature fields', () => {
  for (const [field, value] of [
    ['providerSecret', 'secret'],
    ['privateTopology', 'internal.example'],
    ['promotedTrustState', 'hosted-proven'],
  ]) {
    assert.match(
      violations(
        signedReceipt((receipt) => {
          receipt[field] = value;
        }),
      ),
      new RegExp(`\\$\\.${field} is not allowed`, 'u'),
    );
  }
  assert.match(
    violations(
      signedReceipt((receipt) => {
        receipt.signature.privateKey = 'forbidden';
      }),
    ),
    /signature\.privateKey is not allowed/u,
  );
});

test('canonical input parsing rejects duplicate, reordered, and padded JSON encodings', () => {
  const receipt = signedReceipt();
  const canonical = canonicalHostedTrustJson(receipt);
  assert.deepEqual(
    parseCanonicalHostedTrustJson(Buffer.from(`${canonical}\n`), 'receipt'),
    receipt,
  );
  assert.throws(
    () =>
      parseCanonicalHostedTrustJson(
        Buffer.from(`{"schemaVersion":1,"schemaVersion":1}`),
        'receipt',
      ),
    /canonical JSON with unique fields/u,
  );
  assert.throws(
    () => parseCanonicalHostedTrustJson(Buffer.from(JSON.stringify(receipt, null, 2)), 'receipt'),
    /canonical JSON with unique fields/u,
  );
  assert.throws(
    () => parseCanonicalHostedTrustJson(Buffer.from(` ${canonical}`), 'receipt'),
    /canonical JSON with unique fields/u,
  );
});

test('bounded input rejects directories, symbolic links, empty files, and oversized files', () => {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'tixkit-hosted-trust-files-')));
  try {
    const file = resolve(directory, 'input.json');
    const empty = resolve(directory, 'empty.json');
    const large = resolve(directory, 'large.json');
    const link = resolve(directory, 'input-link.json');
    writeFileSync(file, '{}');
    writeFileSync(empty, '');
    writeFileSync(large, '12345');
    symlinkSync(file, link);

    assert.equal(readBoundedRegularFile(file, 'input', 2).toString(), '{}');
    assert.throws(() => readBoundedRegularFile(directory, 'input', 10), /non-symlink/u);
    assert.throws(() => readBoundedRegularFile(link, 'input', 10), /non-symlink/u);
    assert.throws(() => readBoundedRegularFile(empty, 'input', 10), /contain 1-10 bytes/u);
    assert.throws(() => readBoundedRegularFile(large, 'input', 4), /contain 1-4 bytes/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file loader and CLI verify exact bytes without writing or promoting trust state', () => {
  const directory = realpathSync(mkdtempSync(resolve(tmpdir(), 'tixkit-hosted-trust-cli-')));
  try {
    const receiptPath = resolve(directory, 'receipt.json');
    const artifactPath = resolve(directory, 'artifact.json');
    const keyringPath = resolve(directory, 'keyring.json');
    const receipt = signedReceipt((candidate) => {
      candidate.observedAt = new Date().toISOString();
    });
    canonicalFile(receiptPath, receipt);
    writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
    canonicalFile(keyringPath, keyring);
    const before = [receiptPath, artifactPath, keyringPath].map((path) =>
      readBoundedRegularFile(path, 'fixture', 1024 * 1024),
    );

    assert.equal(
      loadAndVerifyHostedTrustReceipt({
        receiptPath,
        artifactPath,
        keyringPath,
      }).verified,
      true,
    );
    const result = spawnSync(
      process.execPath,
      [cli, '--receipt', receiptPath, '--artifact', artifactPath, '--trusted-keyring', keyringPath],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified hosted trust receipt performance-evidence/u);
    assert.deepEqual(
      [receiptPath, artifactPath, keyringPath].map((path) =>
        readBoundedRegularFile(path, 'fixture', 1024 * 1024),
      ),
      before,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI rejects missing, duplicate, and unsupported arguments', async () => {
  const { validateHostedTrustReceiptCli } = await import('../validate-hosted-trust-receipt.mjs');
  assert.throws(() => validateHostedTrustReceiptCli([]), /required exactly once/u);
  assert.throws(
    () =>
      validateHostedTrustReceiptCli([
        '--receipt',
        'one',
        '--receipt',
        'two',
        '--artifact',
        'artifact',
      ]),
    /missing, duplicated, or unsupported/u,
  );
  assert.throws(
    () =>
      validateHostedTrustReceiptCli([
        '--receipt',
        'receipt',
        '--artifact',
        'artifact',
        '--unknown',
        'keyring',
      ]),
    /missing, duplicated, or unsupported/u,
  );
});
