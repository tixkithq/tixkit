import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { prepareProductionDrWorkflow } from '../prepare-production-dr-workflow.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/production-dr.yml');
const workflowText = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowText);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tixkit-production-dr-workflow-')));
  const reviewedRoot = join(directory, 'reviewed');
  const drillId = 'dependency-postgres-20260720';
  const bundle = join(reviewedRoot, drillId);
  const runnerTemp = join(directory, 'runner-temp');
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  mkdirSync(runnerTemp, { mode: 0o700 });
  chmodSync(reviewedRoot, 0o700);
  chmodSync(bundle, 0o700);
  const file = (name, contents, mode = 0o600) => {
    const path = join(bundle, name);
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode);
    return path;
  };
  file('before-release.json', '{}\n');
  for (const adapter of ['baseline', 'inject', 'during', 'recover', 'recovered']) {
    file(`${adapter}.sh`, '#!/usr/bin/env bash\nexit 0\n', 0o500);
  }
  const config = {
    schemaVersion: 'tixkit-production-rehearsal-config-v1',
    drillId,
    kind: 'dependency-loss',
    dependency: 'postgres',
    acknowledgement: 'I authorize production dependency-loss fault injection and recovery',
    expectedContext: 'production',
    namespace: 'tixkit',
    release: 'tixkit',
    beforeReleaseManifest: 'before-release.json',
    thresholds: {
      adapterTimeoutSeconds: 60,
      maxOutageSeconds: 60,
      maxRecoverySeconds: 120,
    },
    adapters: {
      baselineProbe: 'baseline.sh',
      inject: 'inject.sh',
      duringProbe: 'during.sh',
      recover: 'recover.sh',
      recoveredProbe: 'recovered.sh',
    },
  };
  const configPath = file('config.json', `${JSON.stringify(config)}\n`);
  const expectationsPath = file('expectations.json', '{"reviewed":true}\n');
  const proofKeys = generateKeyPairSync('ed25519');
  const otherKeys = generateKeyPairSync('ed25519');
  const privateKeyPath = join(directory, 'proof-private.pem');
  const publicKeyPath = join(directory, 'proof-public.pem');
  const otherPublicKeyPath = join(directory, 'other-public.pem');
  writeFileSync(privateKeyPath, proofKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o400,
  });
  writeFileSync(publicKeyPath, proofKeys.publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: 0o400,
  });
  writeFileSync(otherPublicKeyPath, otherKeys.publicKey.export({ type: 'spki', format: 'pem' }), {
    mode: 0o400,
  });
  const githubEnvironment = join(directory, 'github-env');
  writeFileSync(githubEnvironment, '', { mode: 0o600 });
  const environment = {
    TIXKIT_DR_DRILL_ID: drillId,
    TIXKIT_DR_KIND: 'dependency-loss',
    TIXKIT_DR_DEPENDENCY: 'postgres',
    TIXKIT_DR_CONFIG_SHA256: sha256(readFileSync(configPath)),
    TIXKIT_DR_EXPECTATIONS_SHA256: sha256(readFileSync(expectationsPath)),
    TIXKIT_DR_PUBLIC_KEY_SHA256: sha256(readFileSync(publicKeyPath)),
    TIXKIT_PRODUCTION_DR_REVIEWED_ROOT: reviewedRoot,
    TIXKIT_PRODUCTION_DR_PROOF_PRIVATE_KEY_PATH: privateKeyPath,
    TIXKIT_PRODUCTION_DR_PROOF_PUBLIC_KEY_PATH: publicKeyPath,
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: githubEnvironment,
  };
  return {
    directory,
    bundle,
    config,
    configPath,
    publicKeyPath,
    otherPublicKeyPath,
    githubEnvironment,
    runnerTemp,
    environment,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('prepares only an exact reviewed owner-only drill bundle', () => {
  const value = fixture();
  try {
    const result = prepareProductionDrWorkflow(value.environment);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.drillId, value.environment.TIXKIT_DR_DRILL_ID);
    const exported = Object.fromEntries(
      readFileSync(value.githubEnvironment, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split(/=(.*)/su).slice(0, 2)),
    );
    assert.equal(exported.TIXKIT_DR_CONFIG_PATH, value.configPath);
    assert.equal(exported.TIXKIT_DR_PUBLIC_KEY_PATH, value.publicKeyPath);
    assert.equal(lstatSync(exported.TIXKIT_DR_EVIDENCE_DIR).mode & 0o777, 0o700);
    assert.equal(resolve(exported.TIXKIT_DR_EVIDENCE_DIR).startsWith(`${value.runnerTemp}/`), true);
  } finally {
    value.cleanup();
  }
});

test('rejects digest drift, key substitution, and inconsistent dependency before output', () => {
  for (const mutate of [
    (value) => {
      value.environment.TIXKIT_DR_CONFIG_SHA256 = '0'.repeat(64);
    },
    (value) => {
      value.environment.TIXKIT_PRODUCTION_DR_PROOF_PUBLIC_KEY_PATH = value.otherPublicKeyPath;
      value.environment.TIXKIT_DR_PUBLIC_KEY_SHA256 = sha256(
        readFileSync(value.otherPublicKeyPath),
      );
    },
    (value) => {
      value.environment.TIXKIT_DR_DEPENDENCY = 'none';
    },
  ]) {
    const value = fixture();
    try {
      mutate(value);
      assert.throws(() => prepareProductionDrWorkflow(value.environment));
      assert.equal(readFileSync(value.githubEnvironment, 'utf8'), '');
      assert.deepEqual(readdirSync(value.runnerTemp), []);
    } finally {
      value.cleanup();
    }
  }
});

test('rejects path escape, symlink, hard-link, and permission drift', () => {
  for (const mutate of [
    (value) => {
      value.config.adapters.inject = '../outside.sh';
      writeFileSync(value.configPath, `${JSON.stringify(value.config)}\n`);
      value.environment.TIXKIT_DR_CONFIG_SHA256 = sha256(readFileSync(value.configPath));
    },
    (value) => {
      rmSync(join(value.bundle, 'inject.sh'));
      symlinkSync('baseline.sh', join(value.bundle, 'inject.sh'));
    },
    (value) => {
      linkSync(join(value.bundle, 'baseline.sh'), join(value.bundle, 'extra-link.sh'));
    },
    (value) => {
      chmodSync(join(value.bundle, 'inject.sh'), 0o550);
    },
  ]) {
    const value = fixture();
    try {
      mutate(value);
      assert.throws(() => prepareProductionDrWorkflow(value.environment));
      assert.equal(readFileSync(value.githubEnvironment, 'utf8'), '');
    } finally {
      value.cleanup();
    }
  }
});

test('workflow separates destructive rehearsal and hosted receipt key custody', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, {
    actions: 'read',
    attestations: 'read',
    contents: 'read',
  });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.jobs.rehearse['runs-on'], ['self-hosted', 'tixkit-production-dr']);
  assert.equal(workflow.jobs.rehearse.environment, 'production-dr');
  assert.equal(workflow.jobs['sign-receipt']['runs-on'], 'ubuntu-24.04');
  assert.equal(workflow.jobs['sign-receipt'].environment, 'production-dr-receipt-signing');
  assert.equal(workflow.jobs['sign-receipt'].needs, 'rehearse');
  const rehearse = JSON.stringify(workflow.jobs.rehearse);
  const signing = JSON.stringify(workflow.jobs['sign-receipt']);
  assert.doesNotMatch(rehearse, /RECEIPT_PRIVATE_KEY_BASE64|TRUSTED_KEYRING_BASE64/u);
  assert.doesNotMatch(signing, /TIXKIT_PRODUCTION_DR_PROOF_PRIVATE_KEY_PATH/u);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (typeof step.run === 'string') assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./u);
    }
  }
});

test('workflow binds an attested release, intermediate artifact identity, and verification ordering', () => {
  assert.equal((workflowText.match(/gh attestation verify/gu) ?? []).length, 2);
  assert.equal((workflowText.match(/--deny-self-hosted-runners/gu) ?? []).length, 2);
  assert.equal((workflowText.match(/ref: \$\{\{ inputs\.release_tag \}\}/gu) ?? []).length, 2);
  assert.match(
    workflowText,
    /artifact_digest: \$\{\{ steps\.upload-proof\.outputs\.artifact-digest \}\}/u,
  );
  assert.match(workflowText, /gh api "\/repos\/\$\{GITHUB_REPOSITORY\}\/actions\/artifacts/u);
  assert.match(
    workflowText,
    /test "\$\(jq -er '\.digest' <<<"\$\{artifact_json\}"\)" = "sha256:\$\{TIXKIT_DR_ARTIFACT_DIGEST\}"/u,
  );
  assert.match(workflowText, /'\.workflow_run\.id'/u);
  assert.match(workflowText, /'\.workflow_run\.head_sha'/u);
  const prepare = workflowText.indexOf(
    'Validate the pre-reviewed invocation before fault injection',
  );
  const execute = workflowText.indexOf('Execute the authorized production rehearsal');
  const verify = workflowText.indexOf('Verify exact proof semantics before retention');
  const intermediateUpload = workflowText.indexOf(
    'Upload private checksum-bound proof for independent receipt signing',
  );
  const signerRebind = workflowText.indexOf(
    'Re-verify the closed bundle against approved dispatch inputs',
  );
  const createReceipt = workflowText.indexOf(
    'Create and independently verify the exact hosted receipt',
  );
  const finalUpload = workflowText.indexOf(
    'Upload receipt-bound bundle for external retention and review',
  );
  assert.ok(prepare > 0 && prepare < execute && execute < verify && verify < intermediateUpload);
  assert.ok(signerRebind > intermediateUpload && signerRebind < createReceipt);
  assert.ok(createReceipt < finalUpload);
  assert.match(workflowText, /scripts\/verify-production-rehearsal\.mjs/u);
  assert.match(workflowText, /scripts\/create-hosted-production-dr-receipt\.mjs/u);
  assert.match(workflowText, /hosted-receipt\.json/u);
  assert.match(workflowText, /bundle\.sha256/u);
  assert.match(workflowText, /path: \$\{\{ env\.TIXKIT_DR_INTERMEDIATE_DIR \}\}/u);
  assert.match(workflowText, /path: \$\{\{ env\.TIXKIT_DR_VERIFIED_BUNDLE \}\}/u);
  assert.match(workflowText, /production DR bundle cardinality drifted/u);
  for (const name of [
    'TIXKIT_DR_CONFIG_SHA256',
    'TIXKIT_DR_EXPECTATIONS_SHA256',
    'TIXKIT_DR_PUBLIC_KEY_SHA256',
    'TIXKIT_DR_KIND',
    'TIXKIT_DR_DEPENDENCY',
  ]) {
    assert.match(JSON.stringify(workflow.jobs['sign-receipt'].env), new RegExp(name, 'u'));
  }
});

test('workflow actions are immutable and producer sources are explicitly owned and protected', () => {
  for (const match of workflowText.matchAll(/uses:\s+([^\s#]+)/gu)) {
    const action = match[1];
    if (action.startsWith('./')) continue;
    assert.match(action, /@[a-f0-9]{40}$/u);
  }
  const codeowners = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8');
  for (const path of [
    '/scripts/__tests__/production-dr-workflow.test.mjs',
    '/scripts/create-hosted-production-dr-receipt.mjs',
    '/scripts/prepare-production-dr-workflow.mjs',
    '/scripts/stage-production-dr-bundle.mjs',
  ]) {
    assert.match(codeowners, new RegExp(`^${path.replaceAll('/', '\\/')} `, 'mu'));
  }
  const verifier = readFileSync(resolve(root, 'scripts/verify-hosted-production-dr.mjs'), 'utf8');
  for (const path of [
    '.github/workflows/production-dr.yml',
    'scripts/create-hosted-production-dr-receipt.mjs',
    'scripts/prepare-production-dr-workflow.mjs',
    'scripts/stage-production-dr-bundle.mjs',
  ]) {
    assert.match(verifier, new RegExp(`'${path.replaceAll('.', '\\.')}'`, 'u'));
  }
});
