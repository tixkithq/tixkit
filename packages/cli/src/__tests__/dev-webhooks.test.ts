import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDevWebhooks, STRIPE_WEBHOOK_EVENTS } from '../dev-webhooks.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

async function makeEnvFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tixkit-cli-webhook-'));
  const path = join(dir, '.env.local');
  await writeFile(path, 'STRIPE_WEBHOOK_SECRET=\n', 'utf-8');
  return path;
}

async function makeEnvFileWithStripeKey(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tixkit-cli-webhook-'));
  const path = join(dir, '.env.local');
  await writeFile(
    path,
    ['STRIPE_SECRET_KEY=sk_test_from_env_file', 'STRIPE_WEBHOOK_SECRET='].join('\n'),
    'utf-8',
  );
  return path;
}

function mockExecFile(available: boolean, auth: boolean) {
  let calls = 0;
  (childProcess.execFile as any).mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls++;
      if (calls === 1) {
        callback(available ? null : new Error('not found'), '', '');
      } else {
        callback(auth ? null : new Error('not logged in'), '', '');
      }
    },
  );
}

function mockSpawn(secret: string | null, exitEarly = false) {
  (childProcess.spawn as any).mockImplementation(() => {
    const stdout = {
      on: (event: string, handler: (chunk: Buffer) => void) => {
        if (event === 'data' && secret) {
          setTimeout(
            () =>
              handler(
                Buffer.from(
                  `Ready! Your webhook signing secret is ${secret} (--forward-to ...)`,
                  'utf-8',
                ),
              ),
            10,
          );
        }
      },
    };
    const stderr = {
      on: vi.fn(),
    };
    const proc = {
      stdout,
      stderr,
      on: (event: string, handler: (code?: number) => void) => {
        if (event === 'exit' && exitEarly) {
          setTimeout(() => handler(1), 20);
        }
      },
      kill: vi.fn(),
    } as unknown as childProcess.ChildProcess;
    return proc;
  });
}

describe('runDevWebhooks', () => {
  const originalStripeApiKey = process.env.STRIPE_API_KEY;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.STRIPE_API_KEY;
    delete process.env.STRIPE_SECRET_KEY;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalStripeApiKey === undefined) {
      delete process.env.STRIPE_API_KEY;
    } else {
      process.env.STRIPE_API_KEY = originalStripeApiKey;
    }
    if (originalStripeSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    }
  });

  it('dry-run prints the planned forward set without spawning stripe listen', async () => {
    const envFile = await makeEnvFile();
    const result = await runDevWebhooks({
      apiUrl: 'http://localhost:4000',
      envFilePath: envFile,
      dryRun: true,
      writeSecret: false,
    });
    expect(result.ok).toBe(true);
    expect(result.stripeAvailable).toBe(false);
    expect(result.forwardUrl).toBe('http://localhost:4000/v1/webhooks/stripe');
    expect(result.events).toEqual(STRIPE_WEBHOOK_EVENTS);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('fails clearly when Stripe CLI is not installed', async () => {
    mockExecFile(false, false);
    const envFile = await makeEnvFile();
    const result = await runDevWebhooks({
      apiUrl: 'http://localhost:4000',
      envFilePath: envFile,
      dryRun: false,
      writeSecret: false,
    });
    expect(result.ok).toBe(false);
    expect(result.stripeAvailable).toBe(false);
    expect(result.message).toContain('Stripe CLI is not installed');
  });

  it('fails clearly when Stripe CLI is installed but not authenticated', async () => {
    mockExecFile(true, false);
    const envFile = await makeEnvFile();
    const result = await runDevWebhooks({
      apiUrl: 'http://localhost:4000',
      envFilePath: envFile,
      dryRun: false,
      writeSecret: false,
    });
    expect(result.ok).toBe(false);
    expect(result.stripeAvailable).toBe(true);
    expect(result.message).toContain('not authenticated');
  });

  it('captures the webhook secret and writes it to the env file', async () => {
    mockExecFile(true, true);
    mockSpawn('whsec_test_secret_123');
    const envFile = await makeEnvFile();
    const result = await runDevWebhooks({
      apiUrl: 'http://localhost:4000',
      envFilePath: envFile,
      dryRun: false,
      writeSecret: true,
    });
    expect(result.ok).toBe(true);
    expect(result.secret).toBe('whsec_test_secret_123');
    expect(result.envUpdated).toBe(true);
  });

  it('resolves the default env file from the monorepo root when run from a package cwd', async () => {
    mockExecFile(true, true);
    mockSpawn('whsec_root_secret_789');
    const root = await mkdtemp(join(tmpdir(), 'tixkit-cli-webhook-root-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'tixkit', workspaces: ['packages/*', 'apps/*'] }),
      'utf-8',
    );
    await writeFile(join(root, '.env.local'), 'STRIPE_WEBHOOK_SECRET=\n', 'utf-8');
    await mkdir(join(root, 'packages', 'cli'), { recursive: true });

    const originalCwd = process.cwd();
    try {
      process.chdir(join(root, 'packages', 'cli'));
      const result = await runDevWebhooks({
        apiUrl: 'http://localhost:4000',
        envFilePath: '.env.local',
        dryRun: false,
        writeSecret: true,
      });

      expect(result.ok).toBe(true);
      expect(result.envUpdated).toBe(true);
      expect(await readFile(join(root, '.env.local'), 'utf-8')).toContain(
        'STRIPE_WEBHOOK_SECRET=whsec_root_secret_789',
      );
      expect(result.message).toContain(join(root, '.env.local'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('uses a Stripe API key from the env file instead of requiring stripe login', async () => {
    mockExecFile(true, false);
    mockSpawn('whsec_test_secret_456');
    const envFile = await makeEnvFileWithStripeKey();
    const result = await runDevWebhooks({
      apiUrl: 'http://localhost:4000',
      envFilePath: envFile,
      dryRun: false,
      writeSecret: false,
    });

    expect(result.ok).toBe(true);
    expect(result.authSource).toBe('api_key');
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    expect(childProcess.spawn).toHaveBeenCalledWith(
      'stripe',
      [
        'listen',
        '--forward-to',
        'http://localhost:4000/v1/webhooks/stripe',
        '--events',
        STRIPE_WEBHOOK_EVENTS.join(','),
      ],
      {
        env: expect.objectContaining({ STRIPE_API_KEY: 'sk_test_from_env_file' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect((childProcess.spawn as any).mock.calls[0][1]).not.toContain('sk_test_from_env_file');
    expect(result.message).not.toContain('sk_test_from_env_file');
  });

  it('reports failure when stripe listen exits before emitting a secret', async () => {
    mockExecFile(true, true);
    mockSpawn(null, true);
    const envFile = await makeEnvFile();
    const result = await runDevWebhooks({
      apiUrl: 'http://localhost:4000',
      envFilePath: envFile,
      dryRun: false,
      writeSecret: false,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited unexpectedly');
  });
});
