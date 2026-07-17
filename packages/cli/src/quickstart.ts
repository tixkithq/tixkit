import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { findRepoRoot } from './env.js';
import { seedSampleData } from './seed-sample-data.js';

export type QuickstartOptions = {
  open: boolean;
  seed: boolean;
};

export type QuickstartResult = {
  ok: boolean;
  message: string;
};

const REQUIRED_PORTS = [5432, 3306, 6379, 7233, 9000, 9001, 4000, 3000, 3001, 3002];
const INFRA_COMMAND = ['docker', 'compose', '-f', 'infra/docker-compose.yml', 'up', '-d'];
const MIGRATE_COMMAND = ['bun', 'run', '--env-file=.env.local', 'db:migrate'];
const DEV_ALL_COMMAND = ['bun', 'run', '--env-file=.env.local', 'dev:all'];
const HEALTH_URLS = {
  api: 'http://localhost:4000/health',
  admin: 'http://localhost:3001',
  checkout: 'http://localhost:3000',
  docs: 'http://localhost:3002/health',
};

export type QuickstartService = keyof typeof HEALTH_URLS;

export function issueQuickstartHealthUrl(service: QuickstartService): string {
  const value = HEALTH_URLS[service];
  if (!value) throw new Error('Unknown quickstart service health target.');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', '::1', 'localhost'].includes(url.hostname)
  ) {
    throw new Error('Quickstart health targets must use credential-free loopback HTTP URLs.');
  }
  return url.toString();
}

export function waitForHealth(
  service: QuickstartService,
  attempts = 30,
  delayMs = 1000,
  request: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  return new Promise((resolve) => {
    let attempt = 0;

    async function check() {
      attempt++;
      try {
        const response = await request(issueQuickstartHealthUrl(service), {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          resolve(true);
          return;
        }
      } catch {
        // ignore network errors and retry
      }

      if (attempt >= attempts) {
        resolve(false);
        return;
      }

      setTimeout(check, delayMs);
    }

    check();
  });
}

function checkDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { timeout: 5000 }, (error) => {
      resolve(error === null);
    });
  });
}

function checkPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function runCommand(
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });

    proc.on('error', (error) => {
      resolve({ ok: false, message: `Failed to run ${command.join(' ')}: ${error.message}` });
    });

    proc.on('exit', (code) => {
      resolve({
        ok: code === 0,
        message: `${command.join(' ')} exited with code ${code ?? 'unknown'}.`,
      });
    });
  });
}

function startDevAll(cwd: string): ChildProcess {
  const proc = spawn(DEV_ALL_COMMAND[0], DEV_ALL_COMMAND.slice(1), {
    cwd,
    stdio: 'inherit',
    detached: false,
  });
  return proc;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  execFile(command, [url], () => {
    // ignore errors; browser open is best-effort
  });
}

export async function runQuickstart(options: QuickstartOptions): Promise<QuickstartResult> {
  let cwd: string;
  try {
    cwd = await findRepoRoot(process.cwd());
  } catch {
    return {
      ok: false,
      message:
        'quickstart runs from a Tixkit source checkout because it starts the repository Docker and application stack. Clone the OSS repository, run bun install, then run tixkit quickstart from that checkout. Use tixkit init from any directory for a headless integration.',
    };
  }

  const dockerOk = await checkDocker();
  if (!dockerOk) {
    return {
      ok: false,
      message: [
        'Docker is not available or not running.',
        'Start Docker Desktop (macOS/Windows) or the Docker daemon (Linux), then retry.',
      ].join(' '),
    };
  }

  const portChecks = await Promise.all(
    REQUIRED_PORTS.map(async (port) => ({ port, free: await checkPortFree(port) })),
  );
  const occupied = portChecks.filter((check) => !check.free).map((check) => check.port);
  if (occupied.length > 0) {
    return {
      ok: false,
      message: `Required ports are already occupied: ${occupied.join(', ')}. Stop existing services or free these ports before running quickstart.`,
    };
  }

  console.log('Starting local infrastructure (Postgres, MySQL, Redis, Temporal, MinIO)...');
  const infraResult = await runCommand(INFRA_COMMAND, { cwd });
  if (!infraResult.ok) {
    return infraResult;
  }

  console.log('Running database migrations...');
  const migrateResult = await runCommand(MIGRATE_COMMAND, { cwd });
  if (!migrateResult.ok) {
    return migrateResult;
  }

  console.log('Starting API, worker, checkout, admin, and documentation...');
  const devProc = startDevAll(cwd);

  // Forward Ctrl+C to the dev process group so all services stop together.
  const cleanup = () => {
    devProc.kill('SIGTERM');
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  createInterface({ input: process.stdin, output: process.stdout }).on('close', cleanup);

  console.log('Waiting for services to become healthy...');
  const [apiHealthy, adminHealthy, checkoutHealthy, docsHealthy] = await Promise.all([
    waitForHealth('api'),
    waitForHealth('admin'),
    waitForHealth('checkout'),
    waitForHealth('docs'),
  ]);

  if (!apiHealthy || !adminHealthy || !checkoutHealthy || !docsHealthy) {
    cleanup();
    return {
      ok: false,
      message: [
        'Services did not become healthy in time.',
        `API healthy: ${apiHealthy}`,
        `Admin healthy: ${adminHealthy}`,
        `Checkout healthy: ${checkoutHealthy}`,
        `Docs healthy: ${docsHealthy}`,
        'Check logs above for startup errors.',
      ].join('\n'),
    };
  }

  if (options.seed) {
    console.log('Seeding sample data...');
    const seedResult = await seedSampleData();
    if (!seedResult.ok) {
      cleanup();
      return { ok: false, message: seedResult.message };
    }
    console.log(seedResult.message);
  }

  const urls = [
    'Tixkit is running locally:',
    `  API:      ${HEALTH_URLS.api}`,
    `  Admin:    ${HEALTH_URLS.admin}`,
    `  Checkout: ${HEALTH_URLS.checkout}`,
    `  Docs:     http://localhost:3002`,
    `  Temporal UI: http://localhost:8080`,
  ];

  if (options.open) {
    openBrowser(HEALTH_URLS.admin);
  }

  // The dev process keeps quickstart alive; if it exits unexpectedly, report it.
  devProc.on('exit', (code) => {
    console.log(`\nDev services exited (code ${code ?? 'unknown'}).`);
  });

  return {
    ok: true,
    message: urls.join('\n'),
  };
}
