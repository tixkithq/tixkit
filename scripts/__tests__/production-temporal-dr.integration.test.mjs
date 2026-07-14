import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const enabled = process.env.TIXKIT_RUN_PRODUCTION_DR_INTEGRATION === '1';
const postgresImage =
  'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const temporalImage =
  'temporalio/auto-setup:1.24@sha256:98cdb6b5e02d64cb933864a9ba91cb66065eb320623a0dafdf44beba535bca88';
const postgresPassword = 'production-temporal-dr-password';
const providerKey = 'production-temporal-dr-provider-key';

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    ...options,
  });
}

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function waitFor(name, command, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < deadline) {
    const result = spawnSync('docker', ['exec', name, ...command], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) return result.stdout;
    lastError = result.stderr || result.stdout;
    const state = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', name], {
      cwd: root,
      encoding: 'utf8',
    });
    if (state.status === 0 && ['dead', 'exited'].includes(state.stdout.trim())) {
      const logs = spawnSync('docker', ['logs', name], {
        cwd: root,
        encoding: 'utf8',
      });
      throw new Error(
        `Container ${name} exited before readiness:\n${logs.stderr || logs.stdout || lastError}`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  throw new Error(`Container ${name} did not become ready: ${lastError}`);
}

function temporal(name, args, options = {}) {
  return docker(['exec', name, 'temporal', ...args], options).trim();
}

function startPostgres(name, hostname, network, snapshotDirectory) {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    hostname,
    '--network',
    network,
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=768m',
    '-e',
    'POSTGRES_USER=temporal',
    '-e',
    `POSTGRES_PASSWORD=${postgresPassword}`,
    '-v',
    `${snapshotDirectory}:/snapshots`,
    postgresImage,
  ]);
  waitFor(name, ['pg_isready', '-U', 'temporal']);
}

function createTemporal(name, hostname, network, postgresHostname) {
  docker([
    'create',
    '--name',
    name,
    '--hostname',
    hostname,
    '--network',
    network,
    '-e',
    'DB=postgres12',
    '-e',
    'DB_PORT=5432',
    '-e',
    'POSTGRES_USER=temporal',
    '-e',
    `POSTGRES_PWD=${postgresPassword}`,
    '-e',
    `POSTGRES_SEEDS=${postgresHostname}`,
    temporalImage,
  ]);
}

function startTemporal(name) {
  docker(['start', name]);
  waitFor(name, ['temporal', 'operator', 'cluster', 'health', '--address', `${name}:7233`]);
}

function assertPrivate(path) {
  assert.equal(statSync(path).mode & 0o777, 0o600);
}

function workflowRunId(description) {
  return description.execution?.runId ?? description.workflowExecutionInfo?.execution?.runId;
}

function runProcess(command, env) {
  return new Promise((resolveResult) => {
    const child = spawn(command, [], { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}

function historyNodeIdentity(postgresContainer) {
  const rows = docker([
    'exec',
    postgresContainer,
    'psql',
    '-U',
    'temporal',
    '-d',
    'temporal',
    '-Atq',
    '-c',
    'COPY (SELECT row_to_json(t)::text FROM history_node t ORDER BY row_to_json(t)::text) TO STDOUT',
  ]);
  const count = Number(
    docker([
      'exec',
      postgresContainer,
      'psql',
      '-U',
      'temporal',
      '-d',
      'temporal',
      '-Atq',
      '-c',
      'SELECT count(*) FROM history_node',
    ]).trim(),
  );
  return { count, sha256: createHash('sha256').update(rows).digest('hex') };
}

test(
  'Production Temporal checkpoint restores durable workflow state into an isolated service',
  { skip: !enabled, timeout: 420_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tixkit-production-temporal-dr-'));
    chmodSync(directory, 0o700);
    const snapshots = join(directory, 'snapshots');
    const adapters = join(directory, 'adapters');
    mkdirSync(snapshots, { mode: 0o777 });
    mkdirSync(adapters, { mode: 0o700 });
    const suffix = randomBytes(5).toString('hex');
    const network = `tixkit-temporal-dr-${suffix}`;
    const sourcePostgres = `tixkit-temporal-pg-source-${suffix}`;
    const sourceTemporal = `tixkit-temporal-source-${suffix}`;
    const targetPostgres = `tixkit-temporal-pg-target-${suffix}`;
    const targetTemporal = `tixkit-temporal-target-${suffix}`;
    const containers = [sourceTemporal, targetTemporal, sourcePostgres, targetPostgres];
    const checkpoint = join(directory, 'temporal-checkpoint.json');
    const evidence = join(directory, 'temporal-evidence.json');
    const providerReceipt = join(directory, 'temporal-target-receipt.json');
    const workflowId = `production-dr-proof-${suffix}`;
    const namespace = `tixkit-dr-${suffix}`;
    const recoveryPointAt = '2026-07-13T19:00:00Z';

    try {
      docker(['network', 'create', network]);
      startPostgres(sourcePostgres, 'temporal-pg-source', network, snapshots);
      createTemporal(sourceTemporal, 'temporal-source', network, 'temporal-pg-source');
      startTemporal(sourceTemporal);
      temporal(sourceTemporal, [
        'operator',
        'namespace',
        'create',
        '--address',
        `${sourceTemporal}:7233`,
        '--namespace',
        namespace,
        '--retention',
        '24h',
      ]);
      const started = JSON.parse(
        temporal(sourceTemporal, [
          'workflow',
          'start',
          '--address',
          `${sourceTemporal}:7233`,
          '--namespace',
          namespace,
          '--workflow-id',
          workflowId,
          '--type',
          'productionDrProofWorkflow',
          '--task-queue',
          'intentionally-unavailable-during-dr-proof',
          '--input',
          JSON.stringify({ proof: 'durable-temporal-history' }),
          '--output',
          'json',
        ]),
      );
      assert.match(started.runId, /^[0-9a-f-]{36}$/u);
      const sourceDescription = JSON.parse(
        temporal(sourceTemporal, [
          'workflow',
          'describe',
          '--address',
          `${sourceTemporal}:7233`,
          '--namespace',
          namespace,
          '--workflow-id',
          workflowId,
          '--output',
          'json',
        ]),
      );
      assert.equal(workflowRunId(sourceDescription), started.runId);
      startPostgres(targetPostgres, 'temporal-pg-target', network, snapshots);
      createTemporal(targetTemporal, 'temporal-target', network, 'temporal-pg-target');
      const targetSystemId = docker([
        'exec',
        targetPostgres,
        'pg_controldata',
        '/var/lib/postgresql/data',
      ]).match(/Database system identifier:\s+(\d+)/u)?.[1];
      assert.match(targetSystemId, /^\d{10,}$/u);
      docker([
        'exec',
        targetPostgres,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'temporal',
        '-d',
        'temporal',
        '-c',
        'CREATE DATABASE temporal_restore_control',
      ]);
      docker([
        'exec',
        targetPostgres,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'temporal',
        '-d',
        'temporal_restore_control',
        '-c',
        'CREATE TABLE claims (immutable_id char(64) NOT NULL, target_identity varchar(64) NOT NULL, provisioning_nonce varchar(64) NOT NULL UNIQUE, claimed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (immutable_id, target_identity))',
      ]);
      const quiesce = join(adapters, 'quiesce');
      const resume = join(adapters, 'resume');
      const checkpointCommand = join(adapters, 'checkpoint');
      const checkpointVerifier = join(adapters, 'verify-checkpoint');
      const restoreCommand = join(adapters, 'restore');
      const evidenceVerifier = join(adapters, 'verify-evidence');
      const persistenceVerifier = join(adapters, 'verify-persistence');
      executable(
        quiesce,
        `#!/usr/bin/env bash\nset -euo pipefail\ndocker stop ${sourceTemporal} >/dev/null\n`,
      );
      executable(
        resume,
        `#!/usr/bin/env bash\nset -euo pipefail\ndocker start ${sourceTemporal} >/dev/null\n`,
      );
      executable(
        checkpointCommand,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
	test "$(docker inspect --format '{{.State.Running}}' ${sourceTemporal})" = false
	rm -f ${snapshots}/temporal.dump ${snapshots}/temporal_visibility.dump
	docker exec ${sourcePostgres} pg_dump -U temporal -Fc -d temporal -f /snapshots/temporal.dump
	docker exec ${sourcePostgres} pg_dump -U temporal -Fc -d temporal_visibility -f /snapshots/temporal_visibility.dump
	chmod 600 ${snapshots}/temporal.dump ${snapshots}/temporal_visibility.dump
	workflow_state_sha="$(docker exec ${sourcePostgres} psql -U temporal -d temporal -Atq -c \"COPY (SELECT kind,row_value FROM (SELECT 'current_executions' AS kind,row_to_json(t)::text AS row_value FROM current_executions t UNION ALL SELECT 'executions',row_to_json(t)::text FROM executions t UNION ALL SELECT 'history_node',row_to_json(t)::text FROM history_node t) state ORDER BY kind,row_value) TO STDOUT\" | shasum -a 256 | awk '{print $1}')"
	history_node_sha="$(docker exec ${sourcePostgres} psql -U temporal -d temporal -Atq -c 'COPY (SELECT row_to_json(t)::text FROM history_node t ORDER BY row_to_json(t)::text) TO STDOUT' | shasum -a 256 | awk '{print $1}')"
	history_node_count="$(docker exec ${sourcePostgres} psql -U temporal -d temporal -Atq -c 'SELECT count(*) FROM history_node')"
	test "$history_node_count" -gt 0
	SNAPSHOT_DIR=${JSON.stringify(snapshots)} PROVIDER_KEY=${JSON.stringify(providerKey)} NAMESPACE=${JSON.stringify(namespace)} WORKFLOW_ID=${JSON.stringify(workflowId)} RUN_ID=${JSON.stringify(started.runId)} WORKFLOW_STATE_SHA="$workflow_state_sha" HISTORY_NODE_SHA="$history_node_sha" HISTORY_NODE_COUNT="$history_node_count" node - <<'NODE'
const {createHash,createHmac}=require('node:crypto');
const {readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const files=['temporal.dump','temporal_visibility.dump'].map(name=>({name,sha256:createHash('sha256').update(readFileSync(join(process.env.SNAPSHOT_DIR,name))).digest('hex')}));
const immutableId=createHash('sha256').update(files.map(file=>file.sha256).join(':')).digest('hex');
	const payload={schemaVersion:1,immutableId,namespace:process.env.NAMESPACE,workflowId:process.env.WORKFLOW_ID,runId:process.env.RUN_ID,recoveryPointAt:process.env.DR_RECOVERY_POINT_AT,verified:true,files,persistence:{workflowStateSha256:process.env.WORKFLOW_STATE_SHA,historyNodeSha256:process.env.HISTORY_NODE_SHA,historyNodeCount:Number(process.env.HISTORY_NODE_COUNT)}};
const providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex');
writeFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE,JSON.stringify({...payload,providerSignature}),{flag:'wx',mode:0o600});
NODE
`,
      );
      executable(
        checkpointVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
SNAPSHOT_DIR=${JSON.stringify(snapshots)} PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHash,createHmac,timingSafeEqual}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const checkpoint=JSON.parse(readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const {providerSignature,...payload}=checkpoint;
const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) throw new Error('Temporal checkpoint provider signature mismatch');
for(const file of payload.files){const actualSha=createHash('sha256').update(readFileSync(join(process.env.SNAPSHOT_DIR,file.name))).digest('hex'); if(actualSha!==file.sha256) throw new Error('Temporal snapshot checksum mismatch');}
const immutableId=createHash('sha256').update(payload.files.map(file=>file.sha256).join(':')).digest('hex'); if(immutableId!==payload.immutableId) throw new Error('Temporal immutable ID mismatch');
NODE
`,
      );
      executable(
        restoreCommand,
        `#!/usr/bin/env bash
	set -euo pipefail
	test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
	DR_TEMPORAL_CHECKPOINT_FILE="$DR_TEMPORAL_CHECKPOINT_FILE" ${checkpointVerifier}
	claim_file="$DR_TEMPORAL_RESTORE_EVIDENCE.claim"
	CHECKPOINT="$DR_TEMPORAL_CHECKPOINT_FILE" CLAIM_FILE="$claim_file" RECEIPT="$DR_TEMPORAL_TARGET_RECEIPT" PROVIDER_KEY=${JSON.stringify(providerKey)} EXPECTED_SYSTEM_ID=${JSON.stringify(targetSystemId)} EXPECTED_SERVICE=${JSON.stringify(targetTemporal)} node - <<-'NODE'
	const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const checkpoint=JSON.parse(readFileSync(process.env.CHECKPOINT)); const receipt=JSON.parse(readFileSync(process.env.RECEIPT)); const {providerSignature,...payload}=receipt;
	const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex'); const expiresAtEpoch=Date.parse(payload.expiresAt); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||payload.schemaVersion!==1||!Number.isFinite(expiresAtEpoch)||expiresAtEpoch<=Date.now()||!/^[a-f0-9]{64}$/.test(payload.provisioningNonce)||payload.targetSystemId!==process.env.EXPECTED_SYSTEM_ID||payload.targetService!==process.env.EXPECTED_SERVICE||payload.immutableId!==checkpoint.immutableId||payload.recoveryPointAt!==checkpoint.recoveryPointAt||payload.namespace!==checkpoint.namespace||payload.runId!==checkpoint.runId) throw new Error('Temporal target provisioning receipt is invalid');
	writeFileSync(process.env.CLAIM_FILE,[checkpoint.immutableId,payload.targetSystemId,payload.provisioningNonce].join('|')+'\\n',{flag:'wx',mode:0o600});
	NODE
	IFS='|' read -r immutable_id target_identity provisioning_nonce <"$claim_file"
	rm -f "$claim_file"
	test "$(docker exec ${targetPostgres} pg_controldata /var/lib/postgresql/data | sed -n 's/^Database system identifier:[[:space:]]*//p')" = "$target_identity"
	docker exec ${targetPostgres} psql -v ON_ERROR_STOP=1 -U temporal -d temporal_restore_control -c "INSERT INTO claims (immutable_id,target_identity,provisioning_nonce) VALUES ('$immutable_id','$target_identity','$provisioning_nonce')" >/dev/null
	docker exec ${targetPostgres} psql -v ON_ERROR_STOP=1 -U temporal -d temporal -c 'CREATE DATABASE temporal_visibility' >/dev/null
	docker exec ${targetPostgres} pg_restore --exit-on-error --clean --if-exists -U temporal -d temporal /snapshots/temporal.dump >/dev/null
	docker exec ${targetPostgres} pg_restore --exit-on-error --clean --if-exists -U temporal -d temporal_visibility /snapshots/temporal_visibility.dump >/dev/null
	checkpoint_persistence="$DR_TEMPORAL_RESTORE_EVIDENCE.persistence"
	CHECKPOINT="$DR_TEMPORAL_CHECKPOINT_FILE" OUTPUT="$checkpoint_persistence" node - <<-'NODE'
	const {readFileSync,writeFileSync}=require('node:fs'); const checkpoint=JSON.parse(readFileSync(process.env.CHECKPOINT)); const p=checkpoint.persistence; if(!p||!p.workflowStateSha256||!p.historyNodeSha256||!Number.isInteger(p.historyNodeCount)) throw new Error('Temporal persistence reconciliation metadata is incomplete'); writeFileSync(process.env.OUTPUT,[p.workflowStateSha256,p.historyNodeSha256,p.historyNodeCount].join('|')+'\\n',{flag:'wx',mode:0o600});
	NODE
	IFS='|' read -r expected_workflow_state_sha expected_history_sha expected_history_count <"$checkpoint_persistence"
	rm -f "$checkpoint_persistence"
	workflow_state_sha="$(docker exec ${targetPostgres} psql -U temporal -d temporal -Atq -c \"COPY (SELECT kind,row_value FROM (SELECT 'current_executions' AS kind,row_to_json(t)::text AS row_value FROM current_executions t UNION ALL SELECT 'executions',row_to_json(t)::text FROM executions t UNION ALL SELECT 'history_node',row_to_json(t)::text FROM history_node t) state ORDER BY kind,row_value) TO STDOUT\" | shasum -a 256 | awk '{print $1}')"
	history_node_sha="$(docker exec ${targetPostgres} psql -U temporal -d temporal -Atq -c 'COPY (SELECT row_to_json(t)::text FROM history_node t ORDER BY row_to_json(t)::text) TO STDOUT' | shasum -a 256 | awk '{print $1}')"
	history_node_count="$(docker exec ${targetPostgres} psql -U temporal -d temporal -Atq -c 'SELECT count(*) FROM history_node')"
	test "$workflow_state_sha" = "$expected_workflow_state_sha" || { echo "Temporal workflow-state digest mismatch: expected $expected_workflow_state_sha, got $workflow_state_sha" >&2; exit 1; }
	test "$history_node_sha" = "$expected_history_sha" || { echo "Temporal history digest mismatch: expected $expected_history_sha, got $history_node_sha" >&2; exit 1; }
	test "$history_node_count" = "$expected_history_count" || { echo "Temporal history count mismatch: expected $expected_history_count, got $history_node_count" >&2; exit 1; }
	docker start ${targetTemporal} >/dev/null
for _ in $(seq 1 300); do
  if docker exec ${targetTemporal} temporal operator cluster health --address ${targetTemporal}:7233 >/dev/null 2>&1; then break; fi
  test "$(docker inspect --format '{{.State.Running}}' ${targetTemporal})" = true
  sleep 0.2
done
docker exec ${targetTemporal} temporal operator cluster health --address ${targetTemporal}:7233 >/dev/null
description="$(docker exec ${targetTemporal} temporal workflow describe --address ${targetTemporal}:7233 --namespace ${namespace} --workflow-id ${workflowId} --output json)"
history="$(docker exec ${targetTemporal} temporal workflow show --address ${targetTemporal}:7233 --namespace ${namespace} --workflow-id ${workflowId} --output json)"
DESCRIPTION="$description" HISTORY="$history" PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
	const {createHmac}=require('node:crypto'); const {writeFileSync}=require('node:fs'); const checkpoint=JSON.parse(require('node:fs').readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const description=JSON.parse(process.env.DESCRIPTION);
	const runId=description.execution?.runId??description.workflowExecutionInfo?.execution?.runId; if(runId!==checkpoint.runId) throw new Error('Restored Temporal run ID mismatch');
	const workflowType=description.workflowExecutionInfo?.type?.name??description.type?.name; if(workflowType!=='productionDrProofWorkflow') throw new Error('Restored Temporal workflow type mismatch');
	const history=JSON.parse(process.env.HISTORY); if(!Array.isArray(history.events)||history.events.length===0) throw new Error('Restored Temporal history is empty');
	const historySha256=require('node:crypto').createHash('sha256').update(process.env.HISTORY).digest('hex');
const payload={schemaVersion:1,verified:true,immutableId:checkpoint.immutableId,namespace:checkpoint.namespace,workflowId:checkpoint.workflowId,runId:checkpoint.runId,historySha256,recoveryPointAt:checkpoint.recoveryPointAt,targetService:${JSON.stringify(targetTemporal)}};
const providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); writeFileSync(process.env.DR_TEMPORAL_RESTORE_EVIDENCE,JSON.stringify({...payload,providerSignature}),{flag:'wx',mode:0o600});
NODE
`,
      );
      executable(
        evidenceVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
	history_file="$DR_TEMPORAL_EVIDENCE_FILE.history-sha"
	HISTORY_FILE="$history_file" PROVIDER_KEY=${JSON.stringify(providerKey)} EXPECTED_TARGET=${JSON.stringify(targetTemporal)} node - <<-'NODE'
	const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const evidence=JSON.parse(readFileSync(process.env.DR_TEMPORAL_EVIDENCE_FILE)); const {providerSignature,...payload}=evidence;
	const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex'); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||payload.targetService!==process.env.EXPECTED_TARGET) throw new Error('Temporal restore evidence authentication failed');
	writeFileSync(process.env.HISTORY_FILE,payload.historySha256,{flag:'wx',mode:0o600});
	NODE
	expected_history_sha="$(cat "$history_file")"
	rm -f "$history_file"
	docker exec ${targetTemporal} temporal operator namespace describe --address ${targetTemporal}:7233 --namespace ${namespace} >/dev/null
	test "$(docker exec ${targetTemporal} temporal workflow describe --address ${targetTemporal}:7233 --namespace ${namespace} --workflow-id ${workflowId} --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.stdout.write(v.execution?.runId??v.workflowExecutionInfo?.execution?.runId??"")})')" = ${started.runId}
	test "$(docker exec ${targetTemporal} temporal workflow show --address ${targetTemporal}:7233 --namespace ${namespace} --workflow-id ${workflowId} --output json | node -e 'const c=require("node:crypto");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(c.createHash("sha256").update(s.trim()).digest("hex")))')" = "$expected_history_sha"
`,
      );
      executable(
        persistenceVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
expected="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1])).persistence; process.stdout.write(p.historyNodeSha256+"|"+p.historyNodeCount)' "$DR_TEMPORAL_CHECKPOINT_FILE")"
IFS='|' read -r expected_sha expected_count <<<"$expected"
actual_sha="$(docker exec ${targetPostgres} psql -U temporal -d temporal -Atq -c 'COPY (SELECT row_to_json(t)::text FROM history_node t ORDER BY row_to_json(t)::text) TO STDOUT' | shasum -a 256 | awk '{print $1}')"
actual_count="$(docker exec ${targetPostgres} psql -U temporal -d temporal -Atq -c 'SELECT count(*) FROM history_node')"
test "$actual_sha" = "$expected_sha"
test "$actual_count" = "$expected_count"
`,
      );

      const isolatedEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        DR_RECOVERY_POINT_AT: recoveryPointAt,
        DR_TEMPORAL_CHECKPOINT_FILE: checkpoint,
        DR_TEMPORAL_TARGET_RECEIPT: providerReceipt,
        DR_TEMPORAL_RESTORE_EVIDENCE: evidence,
        DR_TEMPORAL_EVIDENCE_FILE: evidence,
      };
      execFileSync(quiesce, { cwd: root, env: isolatedEnv });
      execFileSync(checkpointCommand, { cwd: root, env: isolatedEnv });
      execFileSync(checkpointVerifier, { cwd: root, env: isolatedEnv });
      const checkpointPayload = JSON.parse(readFileSync(checkpoint, 'utf8'));
      const writeReceipt = (path, overrides = {}, sign = true) => {
        const receiptPayload = {
          schemaVersion: 1,
          targetSystemId,
          targetService: targetTemporal,
          provisioningNonce: randomBytes(32).toString('hex'),
          immutableId: checkpointPayload.immutableId,
          recoveryPointAt: checkpointPayload.recoveryPointAt,
          namespace: checkpointPayload.namespace,
          runId: checkpointPayload.runId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          ...overrides,
        };
        writeFileSync(
          path,
          JSON.stringify({
            ...receiptPayload,
            providerSignature: sign
              ? createHmac('sha256', providerKey)
                  .update(JSON.stringify(receiptPayload))
                  .digest('hex')
              : '0'.repeat(64),
          }),
          { mode: 0o600 },
        );
      };
      writeReceipt(providerReceipt);
      execFileSync(resume, { cwd: root, env: isolatedEnv });
      waitFor(sourceTemporal, [
        'temporal',
        'operator',
        'cluster',
        'health',
        '--address',
        `${sourceTemporal}:7233`,
      ]);
      assert.equal(
        workflowRunId(
          JSON.parse(
            temporal(sourceTemporal, [
              'workflow',
              'describe',
              '--address',
              `${sourceTemporal}:7233`,
              '--namespace',
              namespace,
              '--workflow-id',
              workflowId,
              '--output',
              'json',
            ]),
          ),
        ),
        started.runId,
      );

      for (const [name, overrides, sign] of [
        ['signature', {}, false],
        ['expired', { expiresAt: new Date(Date.now() - 60_000).toISOString() }, true],
        ['missing-expiry', { expiresAt: undefined }, true],
        ['invalid-expiry', { expiresAt: 'not-a-timestamp' }, true],
        ['schema', { schemaVersion: 2 }, true],
        ['nonce', { provisioningNonce: 'short' }, true],
        ['system', { targetSystemId: `${targetSystemId}0` }, true],
        ['service', { targetService: `${targetTemporal}-other` }, true],
      ]) {
        const path = join(directory, `invalid-receipt-${name}.json`);
        writeReceipt(path, overrides, sign);
        const denial = spawnSync(restoreCommand, {
          cwd: root,
          env: {
            ...isolatedEnv,
            DR_TEMPORAL_TARGET_RECEIPT: path,
            DR_TEMPORAL_RESTORE_EVIDENCE: join(directory, `denied-${name}.json`),
          },
          encoding: 'utf8',
        });
        assert.notEqual(denial.status, 0);
        assert.match(denial.stderr, /provisioning receipt is invalid/u);
      }
      const alternateCheckpoint = join(directory, 'alternate-checkpoint.json');
      const alternatePayload = { ...checkpointPayload };
      delete alternatePayload.providerSignature;
      alternatePayload.files = [...alternatePayload.files].reverse();
      alternatePayload.immutableId = createHash('sha256')
        .update(alternatePayload.files.map((file) => file.sha256).join(':'))
        .digest('hex');
      writeFileSync(
        alternateCheckpoint,
        JSON.stringify({
          ...alternatePayload,
          providerSignature: createHmac('sha256', providerKey)
            .update(JSON.stringify(alternatePayload))
            .digest('hex'),
        }),
        { mode: 0o600 },
      );
      execFileSync(checkpointVerifier, {
        cwd: root,
        env: {
          ...isolatedEnv,
          DR_TEMPORAL_CHECKPOINT_FILE: alternateCheckpoint,
        },
      });
      const substitutedCheckpoint = spawnSync(restoreCommand, {
        cwd: root,
        env: {
          ...isolatedEnv,
          DR_TEMPORAL_CHECKPOINT_FILE: alternateCheckpoint,
          DR_TEMPORAL_TARGET_RECEIPT: providerReceipt,
          DR_TEMPORAL_RESTORE_EVIDENCE: join(directory, 'denied-checkpoint.json'),
        },
        encoding: 'utf8',
      });
      assert.notEqual(substitutedCheckpoint.status, 0);
      assert.match(substitutedCheckpoint.stderr, /provisioning receipt is invalid/u);
      assert.equal(
        docker([
          'exec',
          targetPostgres,
          'psql',
          '-U',
          'temporal',
          '-d',
          'temporal_restore_control',
          '-Atc',
          'SELECT count(*) FROM claims',
        ]).trim(),
        '0',
      );

      for (const dumpName of ['temporal.dump', 'temporal_visibility.dump']) {
        const dumpPath = join(snapshots, dumpName);
        const pristinePath = join(directory, `${dumpName}.pristine`);
        copyFileSync(dumpPath, pristinePath);
        writeFileSync(dumpPath, 'tamper', { flag: 'a' });
        const dumpTamper = spawnSync(checkpointVerifier, {
          cwd: root,
          env: isolatedEnv,
          encoding: 'utf8',
        });
        assert.notEqual(dumpTamper.status, 0);
        assert.match(dumpTamper.stderr, /snapshot checksum mismatch/u);
        copyFileSync(pristinePath, dumpPath);
        chmodSync(dumpPath, 0o600);
        execFileSync(checkpointVerifier, { cwd: root, env: isolatedEnv });
      }

      const competingEvidence = join(directory, 'temporal-evidence-competing.json');
      const attemptEnvironments = [evidence, competingEvidence].map((evidencePath) => ({
        ...isolatedEnv,
        DR_TEMPORAL_TARGET_RECEIPT: providerReceipt,
        DR_TEMPORAL_RESTORE_EVIDENCE: evidencePath,
        DR_TEMPORAL_EVIDENCE_FILE: evidencePath,
      }));
      const attempts = await Promise.all(
        attemptEnvironments.map((attemptEnv) => runProcess(restoreCommand, attemptEnv)),
      );
      assert.equal(
        attempts.filter((attempt) => attempt.status === 0).length,
        1,
        JSON.stringify(attempts),
      );
      const winner = attempts.findIndex((attempt) => attempt.status === 0);
      const loser = attempts[1 - winner];
      assert.match(loser.stderr, /duplicate key value violates unique constraint/u);
      const successfulEnv = attemptEnvironments[winner];
      const successfulEvidence = successfulEnv.DR_TEMPORAL_RESTORE_EVIDENCE;
      execFileSync(evidenceVerifier, { cwd: root, env: successfulEnv });
      assertPrivate(checkpoint);
      assertPrivate(join(snapshots, 'temporal.dump'));
      assertPrivate(join(snapshots, 'temporal_visibility.dump'));
      assertPrivate(providerReceipt);
      assertPrivate(successfulEvidence);
      for (const secret of [postgresPassword, providerKey]) {
        assert.equal(readFileSync(checkpoint, 'utf8').includes(secret), false);
        assert.equal(readFileSync(successfulEvidence, 'utf8').includes(secret), false);
      }
      assert.equal(
        docker([
          'exec',
          targetPostgres,
          'psql',
          '-U',
          'temporal',
          '-d',
          'temporal_restore_control',
          '-Atc',
          'SELECT count(*) FROM claims',
        ]).trim(),
        '1',
      );

      const tamperedCheckpoint = join(directory, 'tampered-checkpoint.json');
      copyFileSync(checkpoint, tamperedCheckpoint);
      const tampered = JSON.parse(readFileSync(tamperedCheckpoint, 'utf8'));
      tampered.runId = randomBytes(16).toString('hex');
      writeFileSync(tamperedCheckpoint, JSON.stringify(tampered), {
        mode: 0o600,
      });
      const tamperResult = spawnSync(checkpointVerifier, {
        cwd: root,
        env: {
          ...isolatedEnv,
          DR_TEMPORAL_CHECKPOINT_FILE: tamperedCheckpoint,
        },
        encoding: 'utf8',
      });
      assert.notEqual(tamperResult.status, 0);
      assert.match(tamperResult.stderr, /signature mismatch/u);

      for (const mutation of ['payload', 'signature']) {
        const tamperedEvidence = join(directory, `tampered-evidence-${mutation}.json`);
        const value = JSON.parse(readFileSync(successfulEvidence, 'utf8'));
        if (mutation === 'payload') value.historySha256 = '0'.repeat(64);
        else value.providerSignature = '0'.repeat(64);
        writeFileSync(tamperedEvidence, JSON.stringify(value), { mode: 0o600 });
        const evidenceTamper = spawnSync(evidenceVerifier, {
          cwd: root,
          env: {
            ...successfulEnv,
            DR_TEMPORAL_EVIDENCE_FILE: tamperedEvidence,
          },
          encoding: 'utf8',
        });
        assert.notEqual(evidenceTamper.status, 0);
        assert.match(evidenceTamper.stderr, /authentication failed/u);
      }

      const replayResult = spawnSync(restoreCommand, {
        cwd: root,
        env: {
          ...isolatedEnv,
          DR_TEMPORAL_RESTORE_EVIDENCE: join(directory, 'replay.json'),
        },
        encoding: 'utf8',
      });
      assert.notEqual(replayResult.status, 0);
      assert.match(replayResult.stderr, /duplicate key value violates unique constraint/u);
      assert.equal(existsSync(join(directory, 'replay.json')), false);

      docker(['stop', targetTemporal]);
      for (const [database, dump] of [
        ['temporal', '/snapshots/temporal.dump'],
        ['temporal_visibility', '/snapshots/temporal_visibility.dump'],
      ]) {
        docker([
          'exec',
          targetPostgres,
          'pg_restore',
          '--exit-on-error',
          '--clean',
          '--if-exists',
          '-U',
          'temporal',
          '-d',
          database,
          dump,
        ]);
      }
      execFileSync(persistenceVerifier, { cwd: root, env: successfulEnv });
      assert.deepEqual(historyNodeIdentity(targetPostgres), {
        count: checkpointPayload.persistence.historyNodeCount,
        sha256: checkpointPayload.persistence.historyNodeSha256,
      });
      docker([
        'exec',
        targetPostgres,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'temporal',
        '-d',
        'temporal',
        '-c',
        'DELETE FROM history_node WHERE ctid IN (SELECT ctid FROM history_node LIMIT 1)',
      ]);
      const incompleteHistory = historyNodeIdentity(targetPostgres);
      assert.equal(incompleteHistory.count, checkpointPayload.persistence.historyNodeCount - 1);
      assert.notEqual(incompleteHistory.sha256, checkpointPayload.persistence.historyNodeSha256);
      const incompleteReconciliation = spawnSync(persistenceVerifier, {
        cwd: root,
        env: successfulEnv,
        encoding: 'utf8',
      });
      assert.notEqual(incompleteReconciliation.status, 0);
    } finally {
      for (const container of containers)
        spawnSync('docker', ['rm', '-f', container], {
          cwd: root,
          stdio: 'ignore',
        });
      spawnSync('docker', ['network', 'rm', network], {
        cwd: root,
        stdio: 'ignore',
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
