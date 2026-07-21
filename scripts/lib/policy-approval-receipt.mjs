import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const POLICY_APPROVAL_RECEIPT_SCHEMA =
  'https://tixkit.com/schemas/policy-approval-receipt.schema.json';
export const POLICY_APPROVAL_RECEIPT_MAX_BYTES = 128 * 1024;
export const POLICY_APPROVAL_KEYRING_MAX_BYTES = 256 * 1024;
export const POLICY_APPROVAL_PROGRAM_MAX_BYTES = 2 * 1024 * 1024;
export const POLICY_APPROVAL_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const POLICY_APPROVAL_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const gitExecutable = '/usr/bin/git';
const publicDistributionPath = 'distribution/public-distribution.json';

const receiptSchema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../distribution/policy-approval-receipt.schema.json', import.meta.url),
    ),
    'utf8',
  ),
);
const keyringSchema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../distribution/policy-approval-keyring.schema.json', import.meta.url),
    ),
    'utf8',
  ),
);
const trustProgramSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../distribution/trust-program.schema.json', import.meta.url)),
    'utf8',
  ),
);
const publicDistributionSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../distribution/public-distribution.schema.json', import.meta.url)),
    'utf8',
  ),
);
const ajv = new Ajv2020({ allErrors: true, ownProperties: true, strict: true });
const validateReceiptSchema = ajv.compile(receiptSchema);
const validateKeyringSchema = ajv.compile(keyringSchema);
const validateTrustProgramSchema = ajv.compile(trustProgramSchema);
const validatePublicDistributionSchema = ajv.compile(publicDistributionSchema);

const REQUIRED_ROLES = Object.freeze({
  'data-residency': Object.freeze(['legal', 'privacy', 'product']),
  'managed-sla': Object.freeze(['legal', 'operations', 'product']),
  'privacy-roles': Object.freeze(['legal', 'privacy', 'product']),
  subprocessors: Object.freeze(['legal', 'privacy', 'product']),
  'version-lifecycle': Object.freeze(['product', 'release', 'security']),
  'vulnerability-response': Object.freeze(['maintainer', 'security']),
});

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Canonical JSON accepts only plain JSON values');
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
    .join(',')}}`;
}

export function canonicalPolicyApprovalJson(value) {
  return canonicalValue(value);
}

export function policyApprovalSha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalPolicyApprovalJson(value));
  return createHash('sha256').update(bytes).digest('hex');
}

function plainJsonDataViolations(value, label) {
  const violations = [];
  const seen = new WeakSet();

  function visit(candidate, path) {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) violations.push(`${path} must contain a finite number`);
      return;
    }
    if (typeof candidate !== 'object') {
      violations.push(`${path} must contain only JSON data`);
      return;
    }
    if (seen.has(candidate)) {
      violations.push(`${path} must not contain cyclic references`);
      return;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        violations.push(`${path} must be an own-property plain JSON array`);
        return;
      }
      const keys = Reflect.ownKeys(candidate).filter((key) => key !== 'length');
      if (
        keys.length !== candidate.length ||
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= candidate.length,
        )
      ) {
        violations.push(`${path} must be a dense JSON array without extra properties`);
        return;
      }
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          violations.push(`${path}[${index}] must be an enumerable own data property`);
        } else {
          visit(descriptor.value, `${path}[${index}]`);
        }
      }
      return;
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype) {
      violations.push(`${path} must be an own-property plain JSON object`);
      return;
    }
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string') {
        violations.push(`${path} must not contain symbol properties`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        violations.push(`${path}.${key} must be an enumerable own data property`);
      } else {
        visit(descriptor.value, `${path}.${key}`);
      }
    }
  }

  visit(value, label);
  return violations;
}

function schemaViolations(validate, value, label) {
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) => `${label} schema ${error.instancePath || '$'} ${error.message ?? 'is invalid'}`,
  );
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export function readPolicyApprovalRegularFile(path, label, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Policy approval input byte limit must be a positive safe integer');
  }
  const absolute = resolve(path);
  const before = lstatSync(absolute, { throwIfNoEntry: false });
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if (before.size < 1 || before.size > maxBytes) {
    throw new Error(`${label} must contain 1-${maxBytes} bytes`);
  }
  const canonicalPath = realpathSync(absolute);
  if (canonicalPath !== absolute) {
    throw new Error(`${label} path must be canonical and contain no symbolic-link indirection`);
  }
  const bytes = readFileSync(absolute);
  const after = lstatSync(absolute);
  if (
    bytes.byteLength !== before.size ||
    !sameFile(before, after) ||
    realpathSync(absolute) !== canonicalPath
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
  return bytes;
}

export function parsePolicyApprovalJson(bytes, label, { canonical = true } = {}) {
  let value;
  const text = bytes.toString('utf8');
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  const violations = plainJsonDataViolations(value, label);
  if (violations.length > 0) throw new Error(violations.join('\n'));
  if (canonical) {
    const expected = canonicalPolicyApprovalJson(value);
    if (text !== expected && text !== `${expected}\n`) {
      throw new Error(`${label} must use canonical JSON with unique fields`);
    }
  }
  return value;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength === 64 && bytes.toString('base64') === value ? bytes : undefined;
}

function canonicalPublicKey(candidate, keyId, violations) {
  if (
    typeof candidate.publicKeyPem !== 'string' ||
    candidate.publicKeyPem.length > 1_024 ||
    /PRIVATE KEY/u.test(candidate.publicKeyPem)
  ) {
    violations.push(`trusted policy key public material is invalid: ${keyId}`);
    return undefined;
  }
  try {
    const key = createPublicKey(candidate.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') {
      violations.push(`trusted policy key must be Ed25519: ${keyId}`);
      return undefined;
    }
    if (String(key.export({ type: 'spki', format: 'pem' })) !== candidate.publicKeyPem) {
      violations.push(`trusted policy key must use canonical SPKI PEM: ${keyId}`);
      return undefined;
    }
    return key;
  } catch {
    violations.push(`trusted policy key public material is invalid: ${keyId}`);
    return undefined;
  }
}

export function policyApprovalReceiptSigningBytes(receipt) {
  const violations = plainJsonDataViolations(receipt, 'policy approval receipt');
  if (violations.length > 0) throw new TypeError(violations.join('\n'));
  if (!Array.isArray(receipt.signatures)) {
    throw new TypeError('Policy approval receipt signatures are required');
  }
  const signatures = receipt.signatures.map(({ algorithm, keyId, role }) => ({
    algorithm,
    keyId,
    role,
  }));
  return Buffer.from(canonicalPolicyApprovalJson({ ...receipt, signatures }), 'utf8');
}

function programPromotionViolations(currentProgram, proposedProgram, receipt) {
  const violations = [
    ...schemaViolations(validateTrustProgramSchema, currentProgram, 'current trust program'),
    ...schemaViolations(validateTrustProgramSchema, proposedProgram, 'proposed trust program'),
  ];
  if (violations.length > 0) return violations;
  const currentIndex = currentProgram.records.findIndex(({ id }) => id === receipt.policyRecordId);
  const proposedIndex = proposedProgram.records.findIndex(
    ({ id }) => id === receipt.policyRecordId,
  );
  if (currentIndex < 0 || proposedIndex !== currentIndex) {
    return ['policy approval candidate must retain the exact target record identity and position'];
  }
  for (const key of Object.keys(currentProgram)) {
    if (key === 'asOf' || key === 'records') continue;
    if (
      canonicalPolicyApprovalJson(currentProgram[key]) !==
      canonicalPolicyApprovalJson(proposedProgram[key])
    ) {
      violations.push(`policy approval candidate changes forbidden trust-program field: ${key}`);
    }
  }
  if (
    Object.keys(currentProgram).sort().join(',') !== Object.keys(proposedProgram).sort().join(',')
  ) {
    violations.push('policy approval candidate changes the trust-program root shape');
  }
  if (currentProgram.records.length !== proposedProgram.records.length) {
    violations.push('policy approval candidate changes the trust-program record count');
  } else {
    for (let index = 0; index < currentProgram.records.length; index += 1) {
      if (index === currentIndex) continue;
      if (
        canonicalPolicyApprovalJson(currentProgram.records[index]) !==
        canonicalPolicyApprovalJson(proposedProgram.records[index])
      ) {
        violations.push(`policy approval candidate changes unrelated record at index ${index}`);
      }
    }
  }
  const current = currentProgram.records[currentIndex];
  const proposed = proposedProgram.records[proposedIndex];
  const currentKeys = Object.keys(current).sort().join(',');
  const proposedKeys = Object.keys(proposed).sort().join(',');
  if (currentKeys !== 'blocker,claim,id,kind,lastVerified,publicArtifacts,scope,state') {
    violations.push('current policy record must have the exact pending-policy-decision shape');
  }
  if (proposedKeys !== 'claim,id,kind,lastVerified,publicArtifacts,scope,state') {
    violations.push('proposed policy record must have the exact published shape');
  }
  if (
    current.kind !== 'policy' ||
    current.state !== 'pending-policy-decision' ||
    current.publicArtifacts.length !== 0 ||
    proposed.id !== current.id ||
    proposed.kind !== current.kind ||
    proposed.scope !== current.scope ||
    proposed.state !== 'published'
  ) {
    violations.push('candidate must promote exactly one pending policy record to published');
  }
  if (
    proposed.claim === current.claim ||
    typeof proposed.claim !== 'string' ||
    proposed.claim.trim() === ''
  ) {
    violations.push('published policy claim must be nonempty and replace the pending claim');
  }
  const publicationDate = receipt.decision.publicationAt.slice(0, 10);
  if (publicationDate < currentProgram.asOf) {
    violations.push('policy publication date must not regress the current trust-program snapshot');
  }
  if (proposed.lastVerified !== publicationDate || proposedProgram.asOf !== publicationDate) {
    violations.push(
      'candidate asOf and policy lastVerified must equal the signed publication date',
    );
  }
  const paths = proposed.publicArtifacts;
  if (
    paths.length < 1 ||
    new Set(paths).size !== paths.length ||
    canonicalPolicyApprovalJson(paths) !== canonicalPolicyApprovalJson([...paths].sort())
  ) {
    violations.push('proposed policy publicArtifacts must be nonempty, unique, and sorted');
  }
  if (receipt.currentRecordSha256 !== policyApprovalSha256(current)) {
    violations.push(
      'receipt current record hash does not match the exact canonical current record',
    );
  }
  if (receipt.proposedRecordSha256 !== policyApprovalSha256(proposed)) {
    violations.push(
      'receipt proposed record hash does not match the exact canonical proposed record',
    );
  }
  if (
    canonicalPolicyApprovalJson(receipt.artifacts.map(({ path }) => path)) !==
    canonicalPolicyApprovalJson(paths)
  ) {
    violations.push('receipt artifacts do not exactly match proposed policy publicArtifacts');
  }
  return violations;
}

function artifactViolations(receipt, repositoryRoot, sourceCommit) {
  const violations = [];
  const root = realpathSync(resolve(repositoryRoot));
  let distribution;
  try {
    const bytes = execFileSync(
      gitExecutable,
      ['show', `${sourceCommit}:${publicDistributionPath}`],
      gitOptions(root, 2 * 1024 * 1024),
    );
    distribution = parsePolicyApprovalJson(bytes, 'committed public distribution', {
      canonical: false,
    });
    const distributionSchemaViolations = schemaViolations(
      validatePublicDistributionSchema,
      distribution,
      'committed public distribution',
    );
    violations.push(...distributionSchemaViolations);
    if (distributionSchemaViolations.length > 0) {
      distribution = undefined;
    } else if (distribution.authority.publicRepository !== 'tixkit/tixkit') {
      violations.push('committed public distribution does not declare tixkit/tixkit authority');
    }
  } catch (error) {
    violations.push(
      `committed public distribution cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedPaths = receipt.artifacts.map(({ path }) => path);
  if (
    new Set(expectedPaths).size !== expectedPaths.length ||
    canonicalPolicyApprovalJson(expectedPaths) !==
      canonicalPolicyApprovalJson([...expectedPaths].sort())
  ) {
    violations.push('receipt artifacts must be unique and sorted by path');
    return violations;
  }
  for (const artifact of receipt.artifacts) {
    const absolute = resolve(root, artifact.path);
    const relativePath = relative(root, absolute);
    if (
      isAbsolute(artifact.path) ||
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath !== artifact.path
    ) {
      violations.push(
        `policy artifact path is not canonical and repository-contained: ${artifact.path}`,
      );
      continue;
    }
    if (distribution && !isPublicDistributionPath(distribution, artifact.path)) {
      violations.push(
        `policy artifact is not classified for public distribution: ${artifact.path}`,
      );
      continue;
    }
    try {
      const bytes = readPolicyApprovalRegularFile(
        absolute,
        `policy artifact ${artifact.path}`,
        POLICY_APPROVAL_ARTIFACT_MAX_BYTES,
      );
      if (policyApprovalSha256(bytes) !== artifact.sha256) {
        violations.push(`policy artifact digest does not match: ${artifact.path}`);
      }
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
    }
  }
  return violations;
}

function gitOptions(root, maxBuffer = 1024 * 1024) {
  return {
    cwd: root,
    encoding: null,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      HOME: process.env.HOME ?? '/tmp',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function gitIdentity(repositoryRoot) {
  const root = realpathSync(resolve(repositoryRoot));
  const topLevel = realpathSync(
    execFileSync(gitExecutable, ['rev-parse', '--show-toplevel'], gitOptions(root))
      .toString('utf8')
      .trim(),
  );
  if (topLevel !== root) {
    throw new Error('policy approval repository root must be the Git top level');
  }
  const commit = execFileSync(gitExecutable, ['rev-parse', '--verify', 'HEAD'], gitOptions(root))
    .toString('utf8')
    .trim();
  const tree = execFileSync(
    gitExecutable,
    ['rev-parse', '--verify', `${commit}^{tree}`],
    gitOptions(root),
  )
    .toString('utf8')
    .trim();
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new Error('authoritative repository HEAD identity is not canonical SHA-1');
  }
  return { commit, root, tree };
}

function belongsTo(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function isPublicDistributionPath(manifest, path) {
  const topLevel = manifest?.classification?.topLevel;
  const docs = manifest?.classification?.docs;
  if (!topLevel || !docs) return false;
  if (path.startsWith('docs/')) {
    return (
      Array.isArray(docs.public) &&
      docs.public.some((root) => belongsTo(path, root)) &&
      !Object.entries(docs)
        .filter(([classification]) => classification !== 'public')
        .flatMap(([, roots]) => roots)
        .some((root) => belongsTo(path, root))
    );
  }
  return (
    Array.isArray(topLevel.public) &&
    topLevel.public.some((root) => belongsTo(path, root)) &&
    !Object.entries(topLevel)
      .filter(([classification]) => classification !== 'public' && classification !== 'mixed')
      .flatMap(([, roots]) => roots)
      .some((root) => belongsTo(path, root))
  );
}

export function policyApprovalPromotionViolations(
  { currentProgram, proposedProgram, receipt, trustedKeyring, repositoryRoot },
  { now = Date.now() } = {},
) {
  const violations = [
    ...plainJsonDataViolations(currentProgram, 'current trust program'),
    ...plainJsonDataViolations(proposedProgram, 'proposed trust program'),
    ...plainJsonDataViolations(receipt, 'policy approval receipt'),
    ...plainJsonDataViolations(trustedKeyring, 'trusted policy keyring'),
  ];
  if (violations.length > 0) return [...new Set(violations)].sort();
  violations.push(
    ...schemaViolations(validateReceiptSchema, receipt, 'policy approval receipt'),
    ...schemaViolations(validateKeyringSchema, trustedKeyring, 'trusted policy keyring'),
  );
  if (violations.length > 0) return [...new Set(violations)].sort();
  if (!Number.isSafeInteger(now)) violations.push('verification clock must be a safe integer');
  const decidedAt = timestamp(receipt.decision.decidedAt);
  const publicationAt = timestamp(receipt.decision.publicationAt);
  if (decidedAt === undefined) {
    violations.push('policy decision time must be a canonical UTC timestamp');
  } else if (Number.isSafeInteger(now)) {
    if (decidedAt > now + POLICY_APPROVAL_CLOCK_SKEW_MS) {
      violations.push('policy decision time is in the future');
    }
  }
  if (publicationAt === undefined) {
    violations.push('policy publication time must be a canonical UTC timestamp');
  } else if (Number.isSafeInteger(now)) {
    if (publicationAt > now) violations.push('policy publication date is in the future');
    if (decidedAt !== undefined && publicationAt < decidedAt) {
      violations.push('policy publication date must not precede the approval decision');
    }
  }
  const trustedDecision = trustedKeyring.decisions[receipt.policyRecordId];
  if (
    !trustedDecision ||
    trustedDecision.id !== receipt.decision.id ||
    trustedDecision.version !== receipt.decision.version ||
    trustedDecision.decidedAt !== receipt.decision.decidedAt ||
    trustedDecision.publicationAt !== receipt.decision.publicationAt
  ) {
    violations.push('policy receipt is not the current independently trusted decision version');
  } else if (trustedDecision.revokedAt !== null) {
    violations.push('policy approval decision is revoked');
  }
  let sourceIdentity;
  try {
    sourceIdentity = gitIdentity(repositoryRoot);
    if (
      receipt.source.commit !== sourceIdentity.commit ||
      receipt.source.tree !== sourceIdentity.tree
    ) {
      violations.push(
        'policy approval receipt source does not match authoritative repository HEAD',
      );
    }
    const committedProgram = parsePolicyApprovalJson(
      execFileSync(
        gitExecutable,
        ['show', `${sourceIdentity.commit}:distribution/trust-program.json`],
        gitOptions(sourceIdentity.root, POLICY_APPROVAL_PROGRAM_MAX_BYTES),
      ),
      'committed trust program',
      { canonical: false },
    );
    if (
      canonicalPolicyApprovalJson(currentProgram) !== canonicalPolicyApprovalJson(committedProgram)
    ) {
      violations.push('current trust program does not match authoritative repository HEAD');
    }
  } catch (error) {
    violations.push(
      `authoritative repository source cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  violations.push(...programPromotionViolations(currentProgram, proposedProgram, receipt));
  try {
    violations.push(...artifactViolations(receipt, repositoryRoot, sourceIdentity?.commit));
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error));
  }

  const requiredRoles = REQUIRED_ROLES[receipt.policyRecordId];
  const actualRoles = receipt.signatures.map(({ role }) => role);
  const keyIds = receipt.signatures.map(({ keyId }) => keyId);
  if (canonicalPolicyApprovalJson(actualRoles) !== canonicalPolicyApprovalJson(requiredRoles)) {
    violations.push(
      `policy signatures must satisfy the exact role quorum: ${requiredRoles.join(', ')}`,
    );
  }
  if (new Set(actualRoles).size !== actualRoles.length || new Set(keyIds).size !== keyIds.length) {
    violations.push('policy signatures must use unique roles and unique signer keys');
  }
  const publicKeyOwners = new Map();
  for (const [keyId, candidate] of Object.entries(trustedKeyring.keys)) {
    const existingKeyId = publicKeyOwners.get(candidate.publicKeyPem);
    if (existingKeyId) {
      violations.push(
        `trusted policy keys must use unique public key material: ${existingKeyId}, ${keyId}`,
      );
    } else {
      publicKeyOwners.set(candidate.publicKeyPem, keyId);
    }
  }
  const signingBytes = policyApprovalReceiptSigningBytes(receipt);
  for (const signature of receipt.signatures) {
    if (!Object.hasOwn(trustedKeyring.keys, signature.keyId)) {
      violations.push(`policy signature key is not independently trusted: ${signature.keyId}`);
      continue;
    }
    const candidate = trustedKeyring.keys[signature.keyId];
    if (candidate.role !== signature.role) {
      violations.push(`policy signature role does not match trusted key role: ${signature.keyId}`);
    }
    const validFrom = timestamp(candidate.validFrom);
    const validUntil = timestamp(candidate.validUntil);
    if (
      validFrom === undefined ||
      validUntil === undefined ||
      validFrom > validUntil ||
      decidedAt === undefined ||
      decidedAt < validFrom ||
      decidedAt > validUntil ||
      publicationAt === undefined ||
      publicationAt < validFrom ||
      publicationAt > validUntil
    ) {
      violations.push(`policy signature key is outside its validity window: ${signature.keyId}`);
    }
    if (candidate.revokedAt !== null) {
      violations.push(`policy signature key is revoked: ${signature.keyId}`);
    }
    const publicKey = canonicalPublicKey(candidate, signature.keyId, violations);
    const bytes = signatureBytes(signature.value);
    if (!bytes) {
      violations.push(`policy signature encoding is invalid: ${signature.keyId}`);
    } else if (publicKey && !verify(null, signingBytes, publicKey, bytes)) {
      violations.push(`policy signature is invalid: ${signature.keyId}`);
    }
  }
  if (sourceIdentity) {
    try {
      const finalIdentity = gitIdentity(repositoryRoot);
      if (
        finalIdentity.commit !== sourceIdentity.commit ||
        finalIdentity.tree !== sourceIdentity.tree
      ) {
        violations.push('authoritative repository HEAD changed during policy verification');
      }
    } catch (error) {
      violations.push(
        `authoritative repository final identity cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return [...new Set(violations)].sort();
}

export function verifyPolicyApprovalPromotion(input, options) {
  const violations = policyApprovalPromotionViolations(input, options);
  if (violations.length > 0) {
    throw new Error(`Policy approval promotion validation failed:\n${violations.join('\n')}`);
  }
  return Object.freeze({ eligibleForPublication: true });
}

export function loadAndVerifyPolicyApprovalPromotion({
  currentProgramPath,
  proposedProgramPath,
  receiptPath,
  trustedKeyringPath,
  repositoryRoot,
  options,
}) {
  const currentProgram = parsePolicyApprovalJson(
    readPolicyApprovalRegularFile(
      currentProgramPath,
      'current trust program',
      POLICY_APPROVAL_PROGRAM_MAX_BYTES,
    ),
    'current trust program',
    { canonical: false },
  );
  const proposedProgram = parsePolicyApprovalJson(
    readPolicyApprovalRegularFile(
      proposedProgramPath,
      'proposed trust program',
      POLICY_APPROVAL_PROGRAM_MAX_BYTES,
    ),
    'proposed trust program',
    { canonical: false },
  );
  const receipt = parsePolicyApprovalJson(
    readPolicyApprovalRegularFile(
      receiptPath,
      'policy approval receipt',
      POLICY_APPROVAL_RECEIPT_MAX_BYTES,
    ),
    'policy approval receipt',
  );
  const trustedKeyring = parsePolicyApprovalJson(
    readPolicyApprovalRegularFile(
      trustedKeyringPath,
      'trusted policy keyring',
      POLICY_APPROVAL_KEYRING_MAX_BYTES,
    ),
    'trusted policy keyring',
  );
  return verifyPolicyApprovalPromotion(
    { currentProgram, proposedProgram, receipt, trustedKeyring, repositoryRoot },
    options,
  );
}
