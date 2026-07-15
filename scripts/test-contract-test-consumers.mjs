import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'tixkit-contract-consumer-'));
const tarballs = [];
const pack = (workspace) => {
  const output = execFileSync('bun', ['pm', 'pack', '--destination', temp, '--quiet'], {
    cwd: resolve(root, workspace),
    encoding: 'utf8',
  });
  const path = resolve(temp, output.trim().split('\n').at(-1));
  tarballs.push(path);
  return path;
};

try {
  const embedTar = pack('packages/embed-core');
  const agentProtocolTar = pack('packages/agent-protocol');
  const contractsTar = pack('packages/contract-tests');
  execFileSync('bun', ['run', 'build'], {
    cwd: resolve(root, 'packages/sdk-js'),
    stdio: 'inherit',
  });
  const sdkTar = pack('packages/sdk-js');
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: {
        '@tixkit/embed-core': `file:${embedTar}`,
        '@tixkit/agent-protocol': `file:${agentProtocolTar}`,
        '@tixkit/contract-tests': `file:${contractsTar}`,
        '@tixkit/js': `file:${sdkTar}`,
      },
      overrides: {
        '@tixkit/embed-core': `file:${embedTar}`,
        '@tixkit/agent-protocol': `file:${agentProtocolTar}`,
      },
    }),
  );
  execFileSync('bun', ['install'], { cwd: temp, stdio: 'inherit' });
  const artifact = Buffer.from('external widget artifact');
  const sri = `sha384-${createHash('sha384').update(artifact).digest('base64')}`;
  const names = [
    'loading',
    'ready',
    'opened',
    'closed',
    'checkout-started',
    'checkout-session-created',
    'order-completed',
    'recoverable-error',
    'fatal-error',
  ];
  await writeFile(
    join(temp, 'embed.json'),
    JSON.stringify({
      html: `<script src="https://cdn.example/v1.2.3/widget.js" integrity="${sri}" crossorigin="anonymous"></script><a href="https://checkout.example/event" aria-label="Open secure checkout">Checkout</a>`,
      csp: "default-src 'none'; script-src https://cdn.example; connect-src https://checkout.example; frame-src https://checkout.example",
      expectedOrigin: 'https://checkout.example',
      lifecycleEvents: names.map((name) => `tixkit:v1:${name}`),
      lifecycleDetails: names.map((name) => ({
        contractVersion: '1.0',
        name,
        widgetId: 'widget_1',
        eventId: 'evt_1',
        mode: 'inline',
        timestamp: '2026-07-10T12:00:00.000Z',
        ...(name === 'closed' ? { reason: 'buyer' } : {}),
        ...(name === 'checkout-session-created' ? { sessionId: 'cs_1' } : {}),
        ...(name === 'order-completed' ? { orderId: 'ord_1' } : {}),
        ...(name.includes('error')
          ? { errorCode: 'internal-error', message: 'Safe', retryable: true }
          : {}),
      })),
      artifact: [...artifact],
      sri,
      fallbackAccessibleName: 'Open secure checkout',
      messageEvents: [
        {
          sourceKey: 'checkout',
          sourceMatches: true,
          valid: true,
          event: {
            origin: 'https://checkout.example',
            data: {
              source: 'tixkit-checkout',
              type: 'checkout:ready',
              contractVersion: '1.0',
              widgetId: 'widget_1',
              eventId: 'evt_1',
              nonce: '0123456789abcdef0123456789abcdef',
            },
          },
          expectation: {
            origin: 'https://checkout.example',
            widgetId: 'widget_1',
            eventId: 'evt_1',
            nonce: '0123456789abcdef0123456789abcdef',
          },
        },
      ],
    }),
  );
  const timestamp = 200;
  const body = JSON.stringify({ type: 'test.ping', test: true });
  const secret = 'whsec_external_fixture';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  await writeFile(
    join(temp, 'webhook.json'),
    JSON.stringify({
      secret,
      deliveries: [
        {
          headers: {
            'X-Tixkit-Signature': `t=${timestamp},v1=${signature}`,
            'X-Tixkit-Delivery': 'd_1',
          },
          body,
          receivedAtMs: 200000,
        },
      ],
    }),
  );
  await writeFile(
    join(temp, 'sdk.json'),
    JSON.stringify({
      apiVersion: '2026-01-01',
      expectedApiVersion: '2026-01-01',
      operationIds: ['postWebhookEndpointsByEndpointIdTest'],
      requiredOperationIds: ['postWebhookEndpointsByEndpointIdTest'],
      errorSamples: [{ error: { code: 'NOT_FOUND', message: 'Not found' } }],
    }),
  );
  const bin = join(temp, 'node_modules', '.bin', 'tixkit-contract-tests');
  for (const [profile, fixture] of [
    ['embed-host', 'embed.json'],
    ['webhook-consumer', 'webhook.json'],
    ['sdk-consumer', 'sdk.json'],
  ]) {
    const output = execFileSync(bin, [profile, join(temp, fixture)], {
      cwd: temp,
      encoding: 'utf8',
    });
    if (JSON.parse(output).ok !== true) throw new Error(`${profile} external profile failed`);
  }
  await writeFile(
    join(temp, 'agent-platform-invalid.json'),
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:9',
      apiVersion: 'latest',
      sponsorAccessTokenEnv: 'TIXKIT_TEST_SPONSOR_TOKEN',
      agentClientId: 'agent_client',
      agentClientSecretEnv: 'TIXKIT_TEST_AGENT_SECRET',
      delegationGrantId: 'delegation_primary',
      resourceId: 'event_primary',
      planId: '../invalid',
      idempotencyPrefix: 'short',
    }),
  );
  const invalidAgent = spawnSync(
    bin,
    ['agent-platform', join(temp, 'agent-platform-invalid.json')],
    {
      cwd: temp,
      encoding: 'utf8',
      env: {
        ...process.env,
        TIXKIT_TEST_SPONSOR_TOKEN: 'sponsor_secret_must_not_leak',
        TIXKIT_TEST_AGENT_SECRET: 'agent_secret_must_not_leak',
      },
    },
  );
  const invalidAgentOutput = JSON.parse(invalidAgent.stdout);
  if (
    invalidAgent.status !== 1 ||
    invalidAgentOutput.ok !== false ||
    invalidAgentOutput.findings?.[0]?.code !== 'AGENT_PLATFORM_INPUT'
  )
    throw new Error('Packed agent-platform fail-closed profile did not reject invalid input');
  if (/secret_must_not_leak/u.test(`${invalidAgent.stdout}${invalidAgent.stderr}`))
    throw new Error('Packed agent-platform profile leaked a credential');
  await writeFile(
    join(temp, 'agent-platform-remote-http.json'),
    JSON.stringify({
      baseUrl: 'http://api.example.test',
      apiVersion: '2026-07-29',
      sponsorAccessTokenEnv: 'TIXKIT_TEST_SPONSOR_TOKEN',
      agentClientId: 'agent_client',
      agentClientSecretEnv: 'TIXKIT_TEST_AGENT_SECRET',
      delegationGrantId: 'delegation_primary',
      resourceId: 'event_primary',
      planId: 'plan_remote_http_rejected',
      idempotencyPrefix: 'agent.conformance.remote-http',
    }),
  );
  const remoteHttpAgent = spawnSync(
    bin,
    ['agent-platform', join(temp, 'agent-platform-remote-http.json')],
    {
      cwd: temp,
      encoding: 'utf8',
      env: {
        ...process.env,
        TIXKIT_TEST_SPONSOR_TOKEN: 'sponsor_secret_must_not_leak',
        TIXKIT_TEST_AGENT_SECRET: 'agent_secret_must_not_leak',
      },
    },
  );
  if (
    remoteHttpAgent.status === 0 ||
    !remoteHttpAgent.stderr.includes('HTTPS, or HTTP on loopback only')
  )
    throw new Error('Packed agent-platform profile did not reject remote plaintext HTTP');
  if (/secret_must_not_leak/u.test(`${remoteHttpAgent.stdout}${remoteHttpAgent.stderr}`))
    throw new Error('Packed agent-platform remote HTTP rejection leaked a credential');
  await writeFile(
    join(temp, 'sdk-wire.mjs'),
    `import { TixkitClient } from '@tixkit/js';
let captured;
globalThis.fetch = async (url, init) => {
  captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)) };
  return new Response(JSON.stringify({ queued: true, test: true, eventId: 'whe_1', endpointId: 'wh_1' }), { status: 202, headers: { 'content-type': 'application/json' } });
};
const client = new TixkitClient({ apiKey: 'tk_sandbox', apiVersion: '2026-01-01', apiBaseUrl: 'https://api.example.test', maxRetries: 0 });
const result = await client.webhookEndpoints.sendTest('wh_1');
if (!result.test || result.endpointId !== 'wh_1') throw new Error('Packed SDK result mismatch');
if (captured.url !== 'https://api.example.test/v1/webhook-endpoints/wh_1/test') throw new Error('Packed SDK URL mismatch');
if (captured.headers['x-tixkit-version'] !== '2026-01-01') throw new Error('Packed SDK version header mismatch');
if (captured.headers.authorization !== 'Bearer tk_sandbox') throw new Error('Packed SDK authorization mismatch');
`,
  );
  execFileSync('bun', ['run', 'sdk-wire.mjs'], { cwd: temp, stdio: 'inherit' });
  const installed = JSON.parse(
    await readFile(join(temp, 'node_modules/@tixkit/contract-tests/package.json'), 'utf8'),
  );
  if (installed.version !== '0.1.0') throw new Error('Unexpected installed contract-tests version');
  console.log(
    'Built and executed 4 packed contract profiles, including agent fail-closed credential handling, and the packed SDK wire contract.',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
  await Promise.all(tarballs.map((path) => rm(path, { force: true })));
}
