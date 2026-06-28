import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnvFile, updateEnvValue } from './env.js';

export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.refund.updated',
  'account.updated',
];

export type WebhookOptions = {
  apiUrl: string;
  envFilePath: string;
  dryRun: boolean;
  writeSecret: boolean;
};

export type WebhookResult = {
  ok: boolean;
  message: string;
  stripeAvailable: boolean;
  forwardUrl?: string;
  events?: string[];
  secret?: string;
  envUpdated?: boolean;
};

function detectStripeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('stripe', ['--version'], { timeout: 5000 }, (error) => {
      resolve(error === null);
    });
  });
}

function detectStripeAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('stripe', ['config', '--list'], { timeout: 5000 }, (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Run `stripe listen` and capture the webhook signing secret printed on startup.
 * The child process is left running so forwarding continues; the secret is
 * returned as soon as it is emitted.
 */
function startStripeListen(options: WebhookOptions): Promise<WebhookResult> {
  const forwardUrl = `${options.apiUrl}/v1/stripe/webhooks`;
  const events = [...STRIPE_WEBHOOK_EVENTS];
  const eventsArg = events.join(',');

  return new Promise((resolve) => {
    const proc = spawn('stripe', ['listen', '--forward-to', forwardUrl, '--events', eventsArg], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          ok: false,
          stripeAvailable: true,
          message: 'Timed out waiting for Stripe CLI to emit a webhook signing secret.',
        });
      }
    }, 15000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
      const match = stdout.match(/whsec_[A-Za-z0-9_]+/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          ok: true,
          stripeAvailable: true,
          forwardUrl,
          events,
          secret: match[0],
          message: `Stripe CLI is forwarding ${events.length} events to ${forwardUrl}.`,
        });
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          stripeAvailable: true,
          message: `Failed to start stripe listen: ${error.message}`,
        });
      }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          stripeAvailable: true,
          message: `stripe listen exited unexpectedly (code ${code}). ${stderr}`,
        });
      }
    });
  });
}

export async function runDevWebhooks(options: WebhookOptions): Promise<WebhookResult> {
  const stripeAvailable = await detectStripeCli();
  if (!stripeAvailable) {
    return {
      ok: false,
      stripeAvailable: false,
      message: [
        'Stripe CLI is not installed or not on PATH.',
        'Install it from https://docs.stripe.com/stripe-cli and run `stripe login`.',
      ].join(' '),
    };
  }

  const authOk = await detectStripeAuth();
  if (!authOk) {
    return {
      ok: false,
      stripeAvailable: true,
      message: [
        'Stripe CLI is installed but not authenticated.',
        'Run `stripe login` in your terminal, then retry `bun run dev:webhooks`.',
      ].join(' '),
    };
  }

  const forwardUrl = `${options.apiUrl}/v1/stripe/webhooks`;
  const events = [...STRIPE_WEBHOOK_EVENTS];

  if (options.dryRun) {
    return {
      ok: true,
      stripeAvailable: true,
      forwardUrl,
      events,
      message: `Dry run: would forward ${events.length} Stripe events to ${forwardUrl}.`,
    };
  }

  const result = await startStripeListen(options);
  if (!result.ok || !result.secret) {
    return result;
  }

  let envUpdated = false;
  if (options.writeSecret) {
    try {
      const content = await readFile(options.envFilePath, 'utf-8');
      const parsed = parseEnvFile(content);
      const updated = updateEnvValue(parsed, 'STRIPE_WEBHOOK_SECRET', result.secret);
      await writeFile(
        options.envFilePath,
        updated.lines.map((line) => line.raw).join('\n'),
        'utf-8',
      );
      envUpdated = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ...result,
        envUpdated: false,
        message: `${result.message} Captured secret ${result.secret.slice(0, 8)}... but failed to write it to ${options.envFilePath}: ${detail}`,
      };
    }
  }

  return {
    ...result,
    envUpdated,
    message: `${result.message} Captured webhook secret ${result.secret.slice(0, 8)}...${envUpdated ? ` and wrote it to ${options.envFilePath}.` : '.'}`,
  };
}

export function formatWebhookResult(result: WebhookResult): string {
  const lines = [result.message];
  if (result.forwardUrl && result.events) {
    lines.push(`  Forwarding ${result.events.length} events to ${result.forwardUrl}`);
    for (const event of result.events) {
      lines.push(`    - ${event}`);
    }
  }
  if (result.secret) {
    lines.push(`  Webhook secret: ${result.secret.slice(0, 8)}...`);
  }
  return lines.join('\n');
}
