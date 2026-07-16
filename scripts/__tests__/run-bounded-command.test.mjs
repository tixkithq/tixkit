import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

const runner = resolve('scripts/run-bounded-command.mjs');
const nodeExecutable = process.env.TIXKIT_NODE_BINARY ?? 'node';
const temporaryDirectories = [];

function execute(arguments_, options = {}) {
  return new Promise((resolveExecution, reject) => {
    const child = spawn(nodeExecutable, [runner, ...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolveExecution({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function nodeCommand(source, runnerOptions = []) {
  return ['--timeout-ms', '3000', ...runnerOptions, '--', nodeExecutable, '-e', source];
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`process ${pid} remained alive after runner termination`);
}

async function waitForPidFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`PID file ${path} was not created`);
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true })));
});

test('forwards stdout and stderr and preserves successful exit', async () => {
  const result = await execute(
    nodeCommand("process.stdout.write('out'); process.stderr.write('err')"),
  );

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.toString('utf8'), 'out');
  assert.equal(result.stderr, 'err');
});

test('preserves ordinary child failures and maps reserved child exit 124', async () => {
  const ordinary = await execute(nodeCommand('process.exit(23)'));
  assert.equal(ordinary.code, 23);

  const reserved = await execute(nodeCommand('process.exit(124)'));
  assert.equal(reserved.code, 125);
  assert.match(reserved.stderr, /child exit 124 is reserved; mapped to 125/);
});

test('returns 124 only when the runner timeout expires', async () => {
  const result = await execute([
    '--timeout-ms',
    '100',
    '--kill-grace-ms',
    '50',
    '--',
    nodeExecutable,
    '-e',
    'setInterval(() => {}, 1000)',
  ]);

  assert.equal(result.code, 124);
  assert.match(result.stderr, /timed out after 100ms/);
});

test(
  'kills a TERM-resistant command and descendant process group after timeout',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tixkit-bounded-command-'));
    temporaryDirectories.push(directory);
    const parentPath = join(directory, 'parent.pid');
    const descendantPath = join(directory, 'descendant.pid');
    const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      writeFileSync(process.env.PARENT_PID_PATH, String(process.pid));
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));
      setInterval(() => {}, 1000);
    `;

    const result = await execute(
      ['--timeout-ms', '300', '--kill-grace-ms', '100', '--', nodeExecutable, '-e', source],
      {
        env: {
          ...process.env,
          PARENT_PID_PATH: parentPath,
          DESCENDANT_PID_PATH: descendantPath,
        },
      },
    );

    assert.equal(result.code, 124);
    const [parentPid, descendantPid] = await Promise.all([
      readFile(parentPath, 'utf8').then(Number),
      readFile(descendantPath, 'utf8').then(Number),
    ]);
    await Promise.all([waitForProcessExit(parentPid), waitForProcessExit(descendantPid)]);
  },
);

test(
  'cleans up background descendants after a successful leader exit',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tixkit-bounded-command-'));
    temporaryDirectories.push(directory);
    const descendantPath = join(directory, 'descendant.pid');
    const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));
      descendant.unref();
    `;

    const result = await execute(
      ['--timeout-ms', '3000', '--kill-grace-ms', '100', '--', nodeExecutable, '-e', source],
      { env: { ...process.env, DESCENDANT_PID_PATH: descendantPath } },
    );

    assert.equal(result.code, 0);
    const descendantPid = await waitForPidFile(descendantPath);
    await waitForProcessExit(descendantPid);
  },
);

test(
  'promotes descendant cleanup to timeout when the deadline expires first',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    const source = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      descendant.unref();
    `;
    const result = await execute([
      '--timeout-ms',
      '100',
      '--kill-grace-ms',
      '300',
      '--',
      nodeExecutable,
      '-e',
      source,
    ]);

    assert.equal(result.code, 124);
    assert.match(result.stderr, /timed out after 100ms/);
  },
);

test(
  'forwards runner SIGTERM, kills its process group, and re-raises SIGTERM',
  { skip: process.platform === 'win32', timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tixkit-bounded-command-'));
    temporaryDirectories.push(directory);
    const parentPath = join(directory, 'parent.pid');
    const descendantPath = join(directory, 'descendant.pid');
    const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      writeFileSync(process.env.PARENT_PID_PATH, String(process.pid));
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
      writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));
      setInterval(() => {}, 1000);
    `;
    const runnerProcess = spawn(
      nodeExecutable,
      [
        runner,
        '--timeout-ms',
        '5000',
        '--kill-grace-ms',
        '100',
        '--',
        nodeExecutable,
        '-e',
        source,
      ],
      {
        env: {
          ...process.env,
          PARENT_PID_PATH: parentPath,
          DESCENDANT_PID_PATH: descendantPath,
        },
        stdio: 'ignore',
      },
    );

    const [parentPid, descendantPid] = await Promise.all([
      waitForPidFile(parentPath),
      waitForPidFile(descendantPath),
    ]);
    const completion = new Promise((resolveCompletion, reject) => {
      runnerProcess.once('error', reject);
      runnerProcess.once('close', (code, signal) => resolveCompletion({ code, signal }));
    });
    runnerProcess.kill('SIGTERM');

    assert.deepEqual(await completion, { code: null, signal: 'SIGTERM' });
    await Promise.all([waitForProcessExit(parentPid), waitForProcessExit(descendantPid)]);
  },
);

test('fails closed and forwards no more than the configured child-output cap', async () => {
  const limit = 64;
  const result = await execute(
    nodeCommand(
      "process.stdout.write('x'.repeat(48)); process.stderr.write('y'.repeat(48)); setInterval(() => {}, 1000)",
      ['--max-output-bytes', String(limit), '--kill-grace-ms', '50'],
    ),
  );

  assert.equal(result.code, 126);
  const diagnostic = `run-bounded-command: child output exceeded the ${limit}-byte limit\n`;
  assert.ok(result.stderr.endsWith(diagnostic));
  const forwardedStderrBytes = Buffer.byteLength(result.stderr) - Buffer.byteLength(diagnostic);
  assert.ok(result.stdout.byteLength + forwardedStderrBytes <= limit);
});

test('rejects missing and non-positive timeout values', async () => {
  const missing = await execute(['--', nodeExecutable, '-e', 'process.exit(0)']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--timeout-ms is required/);

  const zero = await execute(['--timeout-ms', '0', '--', nodeExecutable, '-e', 'process.exit(0)']);
  assert.equal(zero.code, 2);
  assert.match(zero.stderr, /--timeout-ms must be a positive integer/);
});
