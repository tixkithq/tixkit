import { createHash, createHmac } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const domainTar = pack('packages/domain');
  const contentCoreTar = pack('packages/content-core');
  const eventPageTar = pack('packages/content-event-page');
  const portabilityTar = pack('packages/portability');
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
        '@tixkit/domain': `file:${domainTar}`,
        '@tixkit/content-core': `file:${contentCoreTar}`,
        '@tixkit/content-event-page': `file:${eventPageTar}`,
        '@tixkit/portability': `file:${portabilityTar}`,
        '@tixkit/js': `file:${sdkTar}`,
        ajv: '^8.20.0',
        'ajv-formats': '^3.0.1',
      },
      overrides: {
        '@tixkit/embed-core': `file:${embedTar}`,
        '@tixkit/agent-protocol': `file:${agentProtocolTar}`,
        '@tixkit/domain': `file:${domainTar}`,
        '@tixkit/content-core': `file:${contentCoreTar}`,
        '@tixkit/content-event-page': `file:${eventPageTar}`,
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
      campaignEmailTemplateKey: 'event-announcement',
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
      apiVersion: '2026-08-13',
      sponsorAccessTokenEnv: 'TIXKIT_TEST_SPONSOR_TOKEN',
      agentClientId: 'agent_client',
      agentClientSecretEnv: 'TIXKIT_TEST_AGENT_SECRET',
      delegationGrantId: 'delegation_primary',
      resourceId: 'event_primary',
      campaignEmailTemplateKey: 'event-announcement',
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
  await copyFile(
    join(root, 'scripts/fixtures/packed-agent-platform-consumer.mjs'),
    join(temp, 'packed-agent-platform-consumer.mjs'),
  );
  for (const mutation of [
    'none',
    'projection',
    'untrusted_paths',
    'result_digest',
    'replay',
    'prepare_preview',
    'prepare_untrusted_paths',
    'prepare_result_digest',
    'prepare_replay',
    'content_action_digest',
    'content_content',
    'content_preview',
    'content_validation',
    'content_untrusted_paths',
    'content_result_digest',
    'content_replay',
    'campaign_action_digest',
    'campaign_compliance',
    'campaign_result_digest',
    'campaign_replay',
    'update_action_digest',
    'update_preview',
    'update_preview_digest',
    'update_extra',
    'update_replay',
    'update_authorization_shape',
    'update_authorization_digest',
    'update_authorization_time',
    'update_authorization_after_approval',
    'update_preparation_time',
    'update_approval',
    'update_approval_extra',
    'update_execution_envelope',
    'update_result',
    'update_execution_extra',
    'update_execution_time',
    'update_execution_at_expiry',
    'update_execution_replay',
  ]) {
    const packedOutput = JSON.parse(
      execFileSync('bun', ['run', 'packed-agent-platform-consumer.mjs', mutation], {
        cwd: temp,
        encoding: 'utf8',
      }),
    );
    if (packedOutput.eventCalls !== 2)
      throw new Error(`Packed agent-platform ${mutation} did not prove exact event-read replay`);
    if (
      (mutation === 'none' || mutation.startsWith('prepare_')) &&
      packedOutput.eventPrepareCalls !== 2
    )
      throw new Error(`Packed agent-platform ${mutation} did not prove exact event-prepare replay`);
    if (
      (mutation === 'none' || mutation.startsWith('content_')) &&
      packedOutput.contentPrepareCalls !== 2
    )
      throw new Error(
        `Packed agent-platform ${mutation} did not prove exact content-prepare replay`,
      );
    if (
      (mutation === 'none' || mutation.startsWith('campaign_')) &&
      packedOutput.campaignPrepareCalls !== 2
    )
      throw new Error(
        `Packed agent-platform ${mutation} did not prove exact campaign-prepare replay`,
      );
    if (
      (mutation === 'none' || mutation.startsWith('update_')) &&
      packedOutput.eventUpdateCalls !== 2
    )
      throw new Error(`Packed agent-platform ${mutation} did not prove exact event-update replay`);
    if (
      (mutation === 'none' || mutation.startsWith('update_execution')) &&
      packedOutput.eventUpdateExecutionCalls !== 2
    )
      throw new Error(
        `Packed agent-platform ${mutation} did not prove exact event-update execution replay`,
      );
    if (mutation === 'none') {
      if (packedOutput.result.ok !== true)
        throw new Error(
          `Packed agent-platform happy path failed: ${JSON.stringify(packedOutput.result)}`,
        );
    } else if (
      packedOutput.result.ok !== false ||
      !packedOutput.result.findings.some((finding) =>
        [
          'AGENT_PLATFORM_EVENT_READ_SCHEMA',
          'AGENT_PLATFORM_EVENT_READ_REPLAY',
          'AGENT_PLATFORM_EVENT_PREPARE_SCHEMA',
          'AGENT_PLATFORM_CONTENT_PREPARE_SCHEMA',
          'AGENT_PLATFORM_CAMPAIGN_PREPARE_SCHEMA',
          'AGENT_PLATFORM_EVENT_UPDATE_SCHEMA',
          'AGENT_PLATFORM_EVENT_UPDATE_APPROVAL_SCHEMA',
          'AGENT_PLATFORM_EVENT_UPDATE_EXECUTION_SCHEMA',
        ].includes(finding.code),
      )
    )
      throw new Error(`Packed agent-platform ${mutation} did not fail closed`);
  }
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
  await writeFile(
    join(temp, 'portable-event-page.mjs'),
    `import { validatePortableContentDocument } from '@tixkit/portability';
const base = {
  schemaVersion: 2,
  editor: { provider: '@puckeditor/core', data: { root: { props: {} }, content: [{ type: 'Media', props: { id: 'poster', imageUrl: 'tixkit:event-media:poster', imageAlt: 'Poster' } }] } },
  settings: { locale: 'en', discovery: { summary: 'Portable event', tags: [] } },
};
if (!validatePortableContentDocument('event_page', base)) throw new Error('Packed portable event-page validation rejected the public contract');
const unsafe = structuredClone(base);
unsafe.editor.data.content = [{ type: 'Button', props: { id: 'unsafe', label: 'Unsafe', url: 'javascript:alert(1)' } }];
if (validatePortableContentDocument('event_page', unsafe)) throw new Error('Packed portable event-page validation diverged from the canonical validator');
`,
  );
  execFileSync('bun', ['run', 'portable-event-page.mjs'], { cwd: temp, stdio: 'inherit' });
  const npmConsumer = await mkdtemp(join(tmpdir(), 'tixkit-npm-portability-consumer-'));
  try {
    await writeFile(
      join(npmConsumer, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    execFileSync(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        domainTar,
        contentCoreTar,
        eventPageTar,
        portabilityTar,
      ],
      { cwd: npmConsumer, stdio: 'inherit' },
    );
    await copyFile(
      join(temp, 'portable-event-page.mjs'),
      join(npmConsumer, 'portable-event-page.mjs'),
    );
    execFileSync('node', ['portable-event-page.mjs'], {
      cwd: npmConsumer,
      stdio: 'inherit',
    });
  } finally {
    await rm(npmConsumer, { recursive: true, force: true });
  }
  const installed = JSON.parse(
    await readFile(join(temp, 'node_modules/@tixkit/contract-tests/package.json'), 'utf8'),
  );
  if (installed.version !== '0.1.0') throw new Error('Unexpected installed contract-tests version');
  console.log(
    'Built and executed 5 packed contract profiles, including agent event-read/report-read/event-prepare/content-prepare/campaign-prepare replay, approval-bound event-update execution replay, fail-closed credential handling, the packed SDK wire contract, and canonical portable event-page validation through clean Bun and npm installs.',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
  await Promise.all(tarballs.map((path) => rm(path, { force: true })));
}
