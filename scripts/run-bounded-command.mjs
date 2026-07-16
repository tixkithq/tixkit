#!/usr/bin/env node

import { constants as osConstants } from 'node:os';
import process from 'node:process';
import { spawn } from 'node:child_process';

const TIMEOUT_EXIT_CODE = 124;
const CHILD_TIMEOUT_EXIT_CODE = 125;
const OUTPUT_LIMIT_EXIT_CODE = 126;
const SPAWN_FAILURE_EXIT_CODE = 127;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;

function usage(message) {
  if (message) process.stderr.write(`run-bounded-command: ${message}\n`);
  process.stderr.write(
    'usage: run-bounded-command.mjs --timeout-ms <positive integer> ' +
      '[--max-output-bytes <positive integer>] [--kill-grace-ms <positive integer>] ' +
      '-- <command> [args...]\n',
  );
  process.exitCode = 2;
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds the maximum safe integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error('a command must follow --');
  }

  const options = {
    timeoutMs: undefined,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
  };
  const optionArguments = argv.slice(0, separator);
  for (let index = 0; index < optionArguments.length; index += 2) {
    const name = optionArguments[index];
    const value = optionArguments[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);

    if (name === '--timeout-ms') {
      options.timeoutMs = parsePositiveInteger(value, name);
    } else if (name === '--max-output-bytes') {
      options.maxOutputBytes = parsePositiveInteger(value, name);
    } else if (name === '--kill-grace-ms') {
      options.killGraceMs = parsePositiveInteger(value, name);
    } else {
      throw new Error(`unknown option: ${name}`);
    }
  }

  if (options.timeoutMs === undefined) throw new Error('--timeout-ms is required');
  return {
    ...options,
    command: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
}

function signalProcessTree(child, signal) {
  if (!child.pid) return false;

  try {
    if (process.platform === 'win32') return child.kill(signal);
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function processGroupExists(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return signalNumber ? 128 + signalNumber : 1;
}

async function run({ command, args, timeoutMs, maxOutputBytes, killGraceMs }) {
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let forwardedBytes = 0;
  let terminationReason;
  let terminationStarted = false;
  let childClosed = false;
  let childCode = null;
  let childSignal = null;
  let spawnError;
  let escalationComplete = false;
  let interruptionSignal;
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });

  const maybeSettle = () => {
    if (childClosed && (!terminationStarted || escalationComplete)) settle();
  };

  let graceTimer;
  const terminate = (reason) => {
    if (terminationStarted) {
      if (reason === 'timeout' && terminationReason === 'descendant-cleanup') {
        terminationReason = 'timeout';
      }
      return;
    }
    terminationStarted = true;
    terminationReason = reason;
    signalProcessTree(child, 'SIGTERM');
    graceTimer = setTimeout(() => {
      signalProcessTree(child, 'SIGKILL');
      escalationComplete = true;
      maybeSettle();
    }, killGraceMs);
  };

  const handledSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  const signalHandlers = new Map(
    handledSignals.map((signal) => [
      signal,
      () => {
        interruptionSignal ??= signal;
        terminate(`signal:${signal}`);
      },
    ]),
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  const forward = (destination, chunk) => {
    if (terminationReason === 'output-limit') return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxOutputBytes - forwardedBytes;
    if (remaining > 0) {
      const forwarded = buffer.subarray(0, remaining);
      forwardedBytes += forwarded.byteLength;
      destination.write(forwarded);
    }
    if (buffer.byteLength > remaining) terminate('output-limit');
  };

  child.stdout.on('data', (chunk) => forward(process.stdout, chunk));
  child.stderr.on('data', (chunk) => forward(process.stderr, chunk));
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('close', (code, signal) => {
    childClosed = true;
    childCode = code;
    childSignal = signal;
    if (!terminationStarted && processGroupExists(child.pid)) {
      terminate('descendant-cleanup');
    }
    maybeSettle();
  });

  const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
  timeoutTimer.unref();
  await settled;
  clearTimeout(timeoutTimer);
  if (graceTimer) clearTimeout(graceTimer);
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }

  if (interruptionSignal) {
    process.kill(process.pid, interruptionSignal);
    await new Promise(() => {});
  }

  if (terminationReason === 'timeout') {
    process.stderr.write(`run-bounded-command: command timed out after ${timeoutMs}ms\n`);
    return TIMEOUT_EXIT_CODE;
  }
  if (terminationReason === 'output-limit') {
    process.stderr.write(
      `run-bounded-command: child output exceeded the ${maxOutputBytes}-byte limit\n`,
    );
    return OUTPUT_LIMIT_EXIT_CODE;
  }
  if (spawnError) {
    process.stderr.write(
      `run-bounded-command: failed to start ${JSON.stringify(command)}: ${spawnError.message}\n`,
    );
    return SPAWN_FAILURE_EXIT_CODE;
  }
  if (childSignal) {
    process.stderr.write(`run-bounded-command: command terminated by ${childSignal}\n`);
    return signalExitCode(childSignal);
  }
  if (childCode === TIMEOUT_EXIT_CODE) {
    process.stderr.write(
      `run-bounded-command: child exit ${TIMEOUT_EXIT_CODE} is reserved; mapped to ${CHILD_TIMEOUT_EXIT_CODE}\n`,
    );
    return CHILD_TIMEOUT_EXIT_CODE;
  }
  return childCode ?? SPAWN_FAILURE_EXIT_CODE;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  usage(error.message);
}

if (options) {
  try {
    process.exitCode = await run(options);
  } catch (error) {
    process.stderr.write(`run-bounded-command: ${error.stack ?? error.message}\n`);
    process.exitCode = 70;
  }
}
