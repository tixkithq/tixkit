import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { providerClientBoundaryViolations } from '../lib/provider-client-boundary.mjs';

function fixture(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-provider-boundary-'));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = resolve(root, path);
    mkdirSync(resolve(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

test('accepts provider-owned clients and the retained webhook verification boundary', () => {
  const root = fixture({
    'packages/provider-clients/src/stripe.ts':
      "import Stripe from 'stripe';\nnew Stripe('test');\n",
    'packages/provider-clients/src/resend.ts':
      "export const endpoint = 'https://api.resend.com/emails';\n",
    'packages/api/src/routes/modules/stripe-webhooks.ts':
      "import Stripe from 'stripe';\nnew Stripe('test');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    assert.deepEqual(providerClientBoundaryViolations(root), [
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
