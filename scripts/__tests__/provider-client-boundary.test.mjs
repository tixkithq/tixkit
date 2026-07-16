import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { providerClientBoundaryViolations as inspectProviderClientBoundary } from '../lib/provider-client-boundary.mjs';
import { loadProviderIntegrationRegistry } from '../lib/provider-integration-registry.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const registry = loadProviderIntegrationRegistry(repositoryRoot);

function providerClientBoundaryViolations(root, options = {}) {
  return inspectProviderClientBoundary(root, { registry, ...options });
}

function fixture(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-provider-boundary-'));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = resolve(root, path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

test('accepts provider-owned clients with webhook verification behind the boundary', () => {
  const root = fixture({
    'packages/provider-clients/src/stripe.ts':
      "import Stripe from 'stripe';\nnew Stripe('test');\n",
    'packages/provider-clients/src/resend.ts':
      "export const endpoint = 'https://api.resend.com/emails';\n",
    'packages/api/src/routes/modules/stripe-webhooks.ts':
      "import { verifyStripeWebhookEvent } from '@tixkit/provider-clients';\nverifyStripeWebhookEvent({ rawBody: 'body', signature: 'signature', webhookSecret: 'secret' });\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unclassified provider hosts and registry-owned hosts outside their owner', () => {
  const root = fixture({
    'packages/api/src/services/mystery-alias-join.ts':
      "const parts = ['https://api.', 'mystery-alias-join.invalid/v1/messages']; fetch(parts.join(''));\n",
    'packages/api/src/services/mystery-alias-object.ts':
      "const endpoint = String('https://api.mystery-alias-object.invalid/v1/messages'); const options = { url: endpoint, method: 'POST' }; client.request(options);\n",
    'packages/api/src/services/mystery-join.ts':
      "fetch(['https://api.', 'mystery-join.invalid/v1/messages'].join(''));\n",
    'packages/api/src/services/mystery-object.ts':
      "client.request({ url: 'https://api.mystery-object.invalid/v1/messages', method: 'POST' });\n",
    'packages/api/src/services/mystery-string.ts':
      "fetch(String('https://api.mystery-string.invalid/v1/messages'));\n",
    'packages/api/src/services/mystery.ts':
      "fetch('https://api.mystery-provider.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-destructured.ts':
      "const { fetch: send } = globalThis; send('https://api.mystery-destructured.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-object-alias.ts':
      "const transport = { send: fetch }; transport.send('https://api.mystery-object-alias.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-reflect.ts':
      "Reflect.apply(fetch, globalThis, ['https://api.mystery-reflect.invalid/v1/messages']);\n",
    'packages/api/src/services/mystery-call.ts':
      "fetch.call(globalThis, 'https://api.mystery-call.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-bind.ts':
      "const send = fetch.bind(globalThis); send('https://api.mystery-bind.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-wrapper.ts':
      "const send = (...args) => fetch(...args); send('https://api.mystery-wrapper.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-destructured-assignment.ts':
      "let send; ({ fetch: send } = globalThis); send('https://api.mystery-destructured-assignment.invalid/v1/messages');\n",
    'packages/api/src/services/resend.ts': "fetch('https://api.resend.com/emails');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/api/src/services/mystery-alias-join.ts: outbound host is not classified in the provider registry: api.mystery-alias-join.invalid',
      'packages/api/src/services/mystery-alias-object.ts: outbound host is not classified in the provider registry: api.mystery-alias-object.invalid',
      'packages/api/src/services/mystery-bind.ts: outbound host is not classified in the provider registry: api.mystery-bind.invalid',
      'packages/api/src/services/mystery-call.ts: outbound host is not classified in the provider registry: api.mystery-call.invalid',
      'packages/api/src/services/mystery-destructured-assignment.ts: outbound host is not classified in the provider registry: api.mystery-destructured-assignment.invalid',
      'packages/api/src/services/mystery-destructured.ts: outbound host is not classified in the provider registry: api.mystery-destructured.invalid',
      'packages/api/src/services/mystery-join.ts: outbound host is not classified in the provider registry: api.mystery-join.invalid',
      'packages/api/src/services/mystery-object-alias.ts: outbound host is not classified in the provider registry: api.mystery-object-alias.invalid',
      'packages/api/src/services/mystery-object.ts: outbound host is not classified in the provider registry: api.mystery-object.invalid',
      'packages/api/src/services/mystery-reflect.ts: outbound host is not classified in the provider registry: api.mystery-reflect.invalid',
      'packages/api/src/services/mystery-string.ts: outbound host is not classified in the provider registry: api.mystery-string.invalid',
      'packages/api/src/services/mystery-wrapper.ts: outbound host is not classified in the provider registry: api.mystery-wrapper.invalid',
      'packages/api/src/services/mystery.ts: outbound host is not classified in the provider registry: api.mystery-provider.invalid',
      'packages/api/src/services/resend.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects every direct Stripe SDK execution in the webhook owner', () => {
  const webhookPath = 'packages/api/src/routes/modules/stripe-webhooks.ts';
  const violation = `${webhookPath}: server-side Stripe SDK execution must cross @tixkit/provider-clients`;
  const rejected = [
    "import Stripe from 'stripe'; const stripe = new Stripe('test'); stripe.paymentIntents.create({});",
    "import Stripe from 'stripe'; const stripe = new Stripe('test'); stripe.refunds.create({});",
    "import Stripe from 'stripe'; const stripe = new Stripe('test'); stripe.accounts.retrieve('acct');",
    "import Stripe from 'stripe'; const stripe = new Stripe('test'); stripe.accountLinks.create({});",
    "import Stripe from 'stripe'; new Stripe('test');",
    "import Stripe from 'stripe'; const stripe = new Stripe('test'); const execute = stripe.paymentIntents.create; execute({});",
    "const vendor = 'stripe'; const Stripe = (await import(vendor)).default; const stripe = new Stripe('test'); stripe.webhooks.constructEvent('body', 'signature', 'secret');",
    "import Stripe from 'stripe'; class WrappedStripe extends Stripe {} const stripe = new WrappedStripe('test'); stripe.refunds.create({});",
    "import Stripe from 'stripe'; const namespace = { Stripe }; const stripe = new namespace.Stripe('test'); stripe.paymentIntents.create({});",
    "import Stripe from 'stripe'; const stripe = Reflect.construct(Stripe, ['test']); stripe.accounts.retrieve('acct');",
    "import Stripe from 'stripe'; function createStripe() { return Reflect.construct(Stripe, ['test']); } const stripe = createStripe(); stripe.refunds.create({});",
    "const Vendor = (await import(String('stripe'))).default; const stripe = new Vendor('test'); stripe.refunds.create({});",
    "const Vendor = (await import(['str', 'ipe'].join(''))).default; const stripe = new Vendor('test'); stripe.accounts.retrieve('acct');",
    "import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); const Vendor = load('stripe'); const stripe = new Vendor('test'); stripe.paymentIntents.create({});",
    "const load = require; const Vendor = load(String('stripe')); new Vendor('test');",
    "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); const load = req; const Vendor = load('stripe'); new Vendor('test');",
    "import * as moduleApi from 'node:module'; const load = moduleApi.createRequire(import.meta.url); const Vendor = load('stripe'); new Vendor('test');",
    "import { createRequire } from 'node:module'; const factory = createRequire; const load = factory(import.meta.url); const Vendor = load('stripe'); new Vendor('test');",
    "import moduleApi from 'node:module'; const load = moduleApi.createRequire(import.meta.url); const Vendor = load('stripe'); new Vendor('test');",
    "import { loadStripe } from '@stripe/stripe-js'; loadStripe('pk_test');",
    `eval("import('stripe')");`,
  ];

  for (const source of rejected) {
    const root = fixture({ [webhookPath]: source });
    try {
      assert.deepEqual(providerClientBoundaryViolations(root), [violation], source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects direct runtime Stripe and migrated messaging provider execution', () => {
  const root = fixture({
    'packages/api/src/routes/checkout.ts':
      "const vendor = 'str' + 'ipe';\nconst Stripe = (await import(vendor)).default;\nnew Stripe('test');\n",
    'packages/api/src/routes/refunds.ts':
      "const host = 'https://api.' + 'stripe.com';\nfetch(host + '/v1/refunds', { method: 'POST' });\n",
    'packages/email-transport/src/send.ts':
      "const host = 'https://api.';\nconst endpoint = new URL(host + 'twilio.com/2010-04-01/Accounts/example/Messages.json');\nglobalThis.fetch(endpoint);\n",
    'packages/api/src/routes/dynamic.cts': "require('str' + 'ipe');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/api/src/routes/checkout.ts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/dynamic.cts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/refunds.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
      'packages/email-transport/src/send.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('permits the browser Stripe CSP origin without permitting server-side REST execution', () => {
  const root = fixture({
    'apps/checkout/src/lib/checkout-security-headers.ts':
      'export function checkoutContentSecurityPolicy() { return ["connect-src \'self\' https://api.stripe.com"]; }\n',
    'packages/provider-clients/src/stripe-rest.ts':
      "fetch('https://api.stripe.com/v1/payment_intents');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drives non-executing host allowances from registry metadata', () => {
  const path = 'apps/checkout/src/lib/checkout-security-headers.ts';
  const root = fixture({
    [path]:
      'export function checkoutContentSecurityPolicy() { return ["connect-src https://api.stripe.com https://r.stripe.com"]; }\n',
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
    const deniedRegistry = structuredClone(registry);
    for (const integration of deniedRegistry.integrations) {
      integration.allowedNonExecutionHostPaths = [];
    }
    assert.deepEqual(providerClientBoundaryViolations(root, { registry: deniedRegistry }), [
      `${path}: r.stripe.com execution must cross its registry owner (stripe-browser-runtime)`,
      `${path}: server-side Stripe REST execution must cross @tixkit/provider-clients`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('permits the Stripe.js browser SDK only in the checkout application', () => {
  const root = fixture({
    'apps/checkout/src/lib/stripe.ts':
      "import { loadStripe } from '@stripe/stripe-js';\nexport const stripe = loadStripe('pk_test');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects executable Stripe REST even inside the browser CSP owner file', () => {
  const root = fixture({
    'apps/checkout/src/lib/checkout-security-headers.ts':
      "export const connectSource = 'https://api.stripe.com';\nfetch(connectSource + '/v1/tokens');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'apps/checkout/src/lib/checkout-security-headers.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects provider endpoints through aliases, request objects, assignments, and shadowing', () => {
  const root = fixture({
    'packages/api/src/routes/aliases.ts': [
      "const endpoint = 'https://api.' + 'stripe.com/v1/refunds';",
      'const send = globalThis.fetch; send(endpoint);',
      "globalThis['fetch'](new Request(endpoint));",
      'fetch(new URL(endpoint).href);',
      "client.request({ url: endpoint, method: 'POST' });",
      'function unrelated() { const endpoint = process.env.URL; return endpoint; }',
    ].join('\n'),
    'packages/api/src/routes/reassigned.ts': [
      "let endpoint = 'https://safe.example';",
      "endpoint = 'https://api.stripe.com/v1/refunds';",
      'fetch(endpoint);',
    ].join('\n'),
    'packages/api/src/routes/import-alias.ts': [
      "const vendor = 'stripe';",
      "function unrelated() { const vendor = 'safe'; return vendor; }",
      'await import(vendor);',
      'const load = require;',
      "load('stripe');",
      "module.require('stripe');",
    ].join('\n'),
    'packages/email-transport/src/computed.cts':
      "globalThis['fetch']('https://api.' + 'twilio.com/v1/messages');\n",
    'packages/api/src/routes/arbitrary-split.ts': [
      "const a = 'st'; const b = 'ri'; const c = 'pe';",
      'await import(a + b + c);',
      "fetch('HTTPS://api.' + a + b + c + '.com/v1/refunds');",
    ].join('\n'),
    'packages/api/src/routes/escaped.ts':
      "const vendor = '\\x73tripe'; await import(vendor); fetch('http://api.' + vendor + '.com/v1/refunds');\n",
    'packages/email-transport/src/split.ts':
      "const vendor = 'twi' + 'lio.com'; fetch('https://api.' + vendor + '/v1/messages');\n",
  });
  try {
    const fixtureRegistry = structuredClone(registry);
    fixtureRegistry.nonProviderHostAllowances.push({
      host: 'safe.example',
      allowedExecutionPaths: ['packages/api/src/routes/reassigned.ts'],
      rationale: 'Synthetic non-provider control host used by this hostile fixture.',
    });
    assert.deepEqual(providerClientBoundaryViolations(root, { registry: fixtureRegistry }), [
      'packages/api/src/routes/aliases.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/arbitrary-split.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/arbitrary-split.ts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/escaped.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/escaped.ts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/import-alias.ts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/api/src/routes/reassigned.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
      'packages/email-transport/src/computed.cts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
      'packages/email-transport/src/split.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects executing a value derived from the otherwise inert checkout CSP owner', () => {
  const root = fixture({
    'apps/checkout/src/lib/checkout-security-headers.ts': [
      'export function checkoutContentSecurityPolicy() { return ["connect-src \'self\' https://api.stripe.com"]; }',
      "const endpoint = checkoutContentSecurityPolicy()[0].split(' ')[2];",
      "const send = globalThis.fetch; send(endpoint + '/v1/tokens');",
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'apps/checkout/src/lib/checkout-security-headers.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not treat provider integration tests as production execution', () => {
  const root = fixture({
    'packages/api/src/__tests__/stripe-provider.integration.test.ts':
      "import Stripe from 'stripe';\nnew Stripe('test');\n",
    'packages/email-transport/src/send.test.ts': "fetch('https://api.resend.com/emails');\n",
    'apps/admin-dashboard/.next/server/chunk.js':
      "fetch('https://api.stripe.com/v1/payment_intents');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
