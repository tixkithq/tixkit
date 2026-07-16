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
    'packages/api/src/routes/checkout.ts': "import Stripe from 'stripe';\nnew Stripe('test');\n",
    'packages/email-transport/src/send.ts':
      "fetch('https://api.twilio.com/2010-04-01/Accounts/example/Messages.json');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/api/src/routes/checkout.ts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/email-transport/src/send.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
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
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
