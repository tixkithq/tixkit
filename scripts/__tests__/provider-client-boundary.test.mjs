import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { providerClientBoundaryViolations as inspectProviderClientBoundary } from '../lib/provider-client-boundary.mjs';
import {
  loadProviderIntegrationRegistry,
  sourceSha256,
} from '../lib/provider-integration-registry.mjs';

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

function registryWithFixtureDigests(files) {
  const candidate = structuredClone(registry);
  for (const authority of candidate.networkTargetAuthorities) {
    if (authority.issuer.type === 'workspace-export' && files[authority.issuer.path]) {
      authority.issuer.sha256 = sourceSha256(files[authority.issuer.path]);
    }
  }
  for (const receiver of candidate.nonNetworkReceiverTypes) {
    if (files[receiver.path]) receiver.sha256 = sourceSha256(files[receiver.path]);
  }
  return candidate;
}

test('accepts provider-owned clients with webhook verification behind the boundary', () => {
  const root = fixture({
    'packages/provider-clients/src/stripe.ts':
      "import Stripe from 'stripe';\nnew Stripe('test');\n",
    'packages/provider-clients/src/index.ts':
      "export async function executeProviderHttp() { return fetch('https://api.resend.com/emails'); }\n",
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
    'packages/api/src/services/mystery-delete.ts':
      "client.delete('https://api.mystery-delete.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-get.ts':
      "client.get('https://api.mystery-get.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-patch.ts':
      "client.patch('https://api.mystery-patch.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-post.ts':
      "client.post('https://api.mystery-post.invalid/v1/messages');\n",
    'packages/api/src/services/mystery-put.ts':
      "client.put('https://api.mystery-put.invalid/v1/messages');\n",
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
      'packages/api/src/services/mystery-delete.ts: outbound host is not classified in the provider registry: api.mystery-delete.invalid',
      'packages/api/src/services/mystery-destructured-assignment.ts: outbound host is not classified in the provider registry: api.mystery-destructured-assignment.invalid',
      'packages/api/src/services/mystery-destructured.ts: outbound host is not classified in the provider registry: api.mystery-destructured.invalid',
      'packages/api/src/services/mystery-get.ts: outbound host is not classified in the provider registry: api.mystery-get.invalid',
      'packages/api/src/services/mystery-join.ts: outbound host is not classified in the provider registry: api.mystery-join.invalid',
      'packages/api/src/services/mystery-object-alias.ts: outbound host is not classified in the provider registry: api.mystery-object-alias.invalid',
      'packages/api/src/services/mystery-object.ts: outbound host is not classified in the provider registry: api.mystery-object.invalid',
      'packages/api/src/services/mystery-patch.ts: outbound host is not classified in the provider registry: api.mystery-patch.invalid',
      'packages/api/src/services/mystery-post.ts: outbound host is not classified in the provider registry: api.mystery-post.invalid',
      'packages/api/src/services/mystery-put.ts: outbound host is not classified in the provider registry: api.mystery-put.invalid',
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

test('rejects runtime-configured provider HTTP outside the exact approved transport export', () => {
  const root = fixture({
    'packages/api/src/services/environment-provider.ts':
      "await fetch(process.env.ROGUE_PROVIDER_URL + '/charge');\n",
    'packages/api/src/services/environment-alias.ts':
      'const endpoint = process.env.ROGUE_PROVIDER_URL; const send = fetch; await send(endpoint);\n',
    'packages/api/src/services/url-provider.ts':
      "const endpoint = new URL('/charge', process.env.ROGUE_PROVIDER_URL); await fetch(endpoint);\n",
    'packages/api/src/services/request-provider.ts':
      'export async function escape(request) { return fetch(request.url); }\n',
    'packages/api/src/services/relative-api.ts': "await fetch('/v1/internal-status');\n",
    'packages/provider-clients/src/index.ts':
      'export async function executeProviderHttp() { return undefined; } export async function hiddenTransport(request) { return fetch(request.url); }\n',
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/api/src/services/environment-alias.ts: runtime-configured provider HTTP execution must use a registry-approved transport executor',
      'packages/api/src/services/environment-provider.ts: runtime-configured provider HTTP execution must use a registry-approved transport executor',
      'packages/api/src/services/request-provider.ts: runtime-configured provider HTTP execution must use a registry-approved transport executor',
      'packages/api/src/services/url-provider.ts: runtime-configured provider HTTP execution must use a registry-approved transport executor',
      'packages/provider-clients/src/index.ts: runtime-configured provider HTTP execution must use a registry-approved transport executor',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('permits runtime-configured provider HTTP only inside the exact approved transport export', () => {
  const files = {
    'packages/provider-clients/src/index.ts':
      'export function providerBaseUrl(value) { return value; }\nexport async function executeProviderHttp(request) { return fetch(providerBaseUrl(request.url)); }\n',
  };
  const root = fixture(files);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root, { registry: registryWithFixtureDigests(files) }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('confines the raw provider transport executor to exact typed-operation callers', () => {
  const cases = {
    'packages/api/src/services/raw-provider.ts':
      "import { executeProviderHttp } from '@tixkit/provider-clients'; executeProviderHttp({ url: 'https://api.resend.com/emails' });\n",
    'packages/provider-clients/src/rogue.ts':
      "import { executeProviderHttp } from './index.js'; executeProviderHttp({ url: process.env.ROGUE_PROVIDER_URL });\n",
    'packages/provider-clients/src/index.ts':
      'export async function executeProviderHttp() {} function hidden() { executeProviderHttp({ url: process.env.ROGUE_PROVIDER_URL }); }\n',
    'packages/api/src/services/raw-provider-call.ts':
      "import { executeProviderHttp } from '@tixkit/provider-clients'; executeProviderHttp.call(null, { url: 'https://api.resend.com/emails' });\n",
    'packages/api/src/services/raw-provider-reflect.ts':
      "import { executeProviderHttp } from '@tixkit/provider-clients'; Reflect.apply(executeProviderHttp, null, [{ url: 'https://api.resend.com/emails' }]);\n",
    'packages/api/src/services/raw-provider-object.ts':
      "import { executeProviderHttp } from '@tixkit/provider-clients'; ({ run: executeProviderHttp }).run({ url: 'https://api.resend.com/emails' });\n",
    'packages/api/src/services/raw-provider-array.ts':
      "import { executeProviderHttp } from '@tixkit/provider-clients'; [executeProviderHttp][0]({ url: 'https://api.resend.com/emails' });\n",
    'packages/api/src/services/raw-provider-callback.ts':
      "import { executeProviderHttp } from '@tixkit/provider-clients'; requests.map(executeProviderHttp);\n",
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/api/src/services/raw-provider-array.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
      'packages/api/src/services/raw-provider-array.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/api/src/services/raw-provider-call.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
      'packages/api/src/services/raw-provider-call.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/api/src/services/raw-provider-callback.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/api/src/services/raw-provider-object.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
      'packages/api/src/services/raw-provider-object.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/api/src/services/raw-provider-reflect.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
      'packages/api/src/services/raw-provider-reflect.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/api/src/services/raw-provider.ts: migrated messaging provider endpoints must be owned by @tixkit/provider-clients',
      'packages/api/src/services/raw-provider.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/provider-clients/src/index.ts: provider transport executor use is outside its exact typed-operation boundary',
      'packages/provider-clients/src/rogue.ts: provider transport executor use is outside its exact typed-operation boundary',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires every raw executor destination alternative to be approved', () => {
  const path = 'packages/provider-clients/src/index.ts';
  const root = fixture({
    [path]: [
      'export async function executeProviderHttp() {}',
      'function providerBaseUrl(value) { return value; }',
      "executeProviderHttp({ url: approved ? providerBaseUrl('https://api.resend.com') : opaqueDestination });",
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      `${path}: provider transport executor use is outside its exact typed-operation boundary`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects mixed raw executor provenance within one compound target', () => {
  const path = 'packages/provider-clients/src/index.ts';
  const rejected = [
    "providerBaseUrl('https://api.resend.com') + rogueUrl",
    "[rogueUrl, providerBaseUrl('https://api.resend.com')][0]",
  ];
  for (const target of rejected) {
    const root = fixture({
      [path]: [
        'export async function executeProviderHttp() {}',
        'function providerBaseUrl(value) { return value; }',
        `executeProviderHttp({ url: ${target} });`,
      ].join('\n'),
    });
    try {
      assert.deepEqual(providerClientBoundaryViolations(root), [
        `${path}: provider transport executor use is outside its exact typed-operation boundary`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects aliased and generic network primitives with unresolved destinations', () => {
  const cases = {
    'packages/api/src/services/sequence-fetch.ts':
      'void (0, fetch)(process.env.ROGUE_PROVIDER_URL);\n',
    'packages/api/src/services/computed-fetch.ts':
      "void globalThis['fe' + 'tch'](process.env.ROGUE_PROVIDER_URL);\n",
    'packages/api/src/services/http-request.ts':
      "import * as http from 'node:http'; http.request(new URL(process.env.ROGUE_PROVIDER_URL));\n",
    'packages/api/src/services/https-get.ts':
      "import { get as send } from 'node:https'; send(process.env.ROGUE_PROVIDER_URL);\n",
    'packages/api/src/services/generic-request.ts':
      'client.request({ url: process.env.ROGUE_PROVIDER_URL });\n',
    'packages/api/src/services/imported-fetch.ts':
      "import { fetch as send } from 'undici'; send(process.env.ROGUE_PROVIDER_URL);\n",
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map(
          (path) =>
            `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binds non-provider allowances to destinations rather than blanket client files', () => {
  const allowedPath = 'apps/admin-dashboard/src/lib/api-http.ts';
  const files = {
    [allowedPath]: [
      "export function resolveAdminApiUrl(path) { return new URL(path, 'https://admin.invalid').toString(); }",
      "const configuredTixkitOrigin = resolveAdminApiUrl('/v1/events');",
      'fetch(configuredTixkitOrigin);',
      "fetch('/v1/health');",
    ].join('\n'),
  };
  const root = fixture(files);
  try {
    const trustedRegistry = registryWithFixtureDigests(files);
    assert.deepEqual(providerClientBoundaryViolations(root, { registry: trustedRegistry }), []);
    const uploadOnlyRegistry = structuredClone(trustedRegistry);
    const allowance = uploadOnlyRegistry.nonProviderDynamicNetworkAllowances.find(
      ({ path }) => path === allowedPath,
    );
    allowance.allowedAuthorityIds = ['prometheus-pushgateway-client'];
    assert.deepEqual(providerClientBoundaryViolations(root, { registry: uploadOnlyRegistry }), [
      `${allowedPath}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const rogueRoot = fixture({
    [allowedPath]: [
      "fetch(process.env.ROGUE_PROVIDER_URL + '/v1/events');",
      'fetch(opaqueDestination);',
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(rogueRoot), [
      `${allowedPath}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
    ]);
  } finally {
    rmSync(rogueRoot, { recursive: true, force: true });
  }

  const mixedRoot = fixture({
    [allowedPath]: "fetch(useConfigured ? resolveAdminApiUrl('/v1/events') : opaqueDestination);\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(mixedRoot), [
      `${allowedPath}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
    ]);
  } finally {
    rmSync(mixedRoot, { recursive: true, force: true });
  }
});

test('rejects generic client methods with unresolved destinations', () => {
  const methods = ['delete', 'get', 'patch', 'post', 'put'];
  const files = Object.fromEntries(
    methods.map((method) => [
      `packages/api/src/services/client-${method}.ts`,
      method === 'get'
        ? `const gateway = { get: (url) => fetch(url) }; gateway.get(process.env.ROGUE_PROVIDER_URL);\n`
        : `gateway.${method}(process.env.ROGUE_PROVIDER_URL);\n`,
    ]),
  );
  const root = fixture(files);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      methods.map(
        (method) =>
          `packages/api/src/services/client-${method}.ts: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects receiver-independent GET HEAD and OPTIONS URL targets without flagging Map.get', () => {
  const cases = {
    'packages/api/src/services/axios-get.ts': 'axios.get(destination);\n',
    'packages/api/src/services/got-head.ts': 'got.head(target);\n',
    'packages/api/src/services/ky-options.ts': 'ky.options(address);\n',
    'packages/api/src/services/shadowed-map.ts':
      'const Map = AxiosClient; new Map().get(destination);\n',
    'packages/api/src/services/shadowed-weak-map.ts':
      'function WeakMap() { return got; } new WeakMap().get(target);\n',
    'packages/api/src/services/shadowed-global-this.ts':
      'const globalThis = { Map: AxiosClient }; new globalThis.Map().get(destination);\n',
    'packages/api/src/services/catch-global-this.ts':
      'try { throw { Map: AxiosClient }; } catch (globalThis) { new globalThis.Map().get(destination); }\n',
    'packages/api/src/services/catch-map.ts':
      'try { throw AxiosClient; } catch (Map) { new Map().get(destination); }\n',
    'packages/api/src/services/catch-weak-map.ts':
      'try { throw GotClient; } catch (WeakMap) { new WeakMap().get(target); }\n',
    'packages/api/src/services/catch-destructured-map.ts':
      'try { throw { Map: AxiosClient }; } catch ({ Map }) { new Map().get(destination); }\n',
    'packages/api/src/services/runtime-get.ts':
      "whatever['g' + 'et'](process.env.ROGUE_PROVIDER_URL);\n",
    'packages/api/src/services/runtime-head.ts':
      'axios.head(new URL(process.env.ROGUE_PROVIDER_URL));\n',
    'packages/api/src/services/runtime-options.ts': "transport['options'](rogueEndpoint);\n",
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map(
          (path) =>
            `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const mapRoot = fixture({
    'packages/api/src/services/cache.ts': [
      'async function loadCache(): Promise<Map<string, string>> { const result = new Map<string, string>(); return result; }',
      'const cache = new Map(); const weak = new WeakMap(); const values = new Set(); const globalCache = new globalThis.Map(); const globalWeak = new globalThis.WeakMap();',
      'const loaded = await loadCache(); const value = cache.get(cacheKey); const loadedValue = loaded.get(cacheKey); const other = weak.get(objectKey); const deleted = values.delete(cacheKey); const globalValue = globalCache.get(cacheKey); const globalOther = globalWeak.get(objectKey); void value; void loadedValue; void other; void deleted; void globalValue; void globalOther;',
      ...Array.from(
        { length: 300 },
        (_, index) =>
          `function unrelated${index}(request) { const cacheKey = request.params.id; return cacheKey; }`,
      ),
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(mapRoot), []);
  } finally {
    rmSync(mapRoot, { recursive: true, force: true });
  }
});

test('resolves same-name receivers within their lexical function scopes', () => {
  const path = 'packages/api/src/services/scoped-receivers.ts';
  const root = fixture({
    [path]: [
      'function cached(cacheKey) { const gateway = new Map(); return gateway.get(cacheKey); }',
      'function outbound(destination) { const gateway = { get: (url) => fetch(url) }; return gateway.get(destination); }',
      'void cached; void outbound;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('distinguishes optional typed storage reads from typed HTTP clients', () => {
  const safePath = 'packages/api/src/services/storage-reader.ts';
  const unsafePath = 'packages/api/src/services/http-reader.ts';
  const disguisedPath = 'packages/api/src/services/disguised-http-reader.ts';
  const root = fixture({
    [safePath]: [
      'interface CheckoutStorage {',
      '  get(key: string): string | null | Promise<string | null>;',
      '  set(key: string, value: string): void | Promise<void>;',
      '  remove(key: string): void | Promise<void>;',
      '}',
      'async function read(storage: CheckoutStorage | undefined, key: string) {',
      '  return storage?.get(key);',
      '}',
      'void read;',
    ].join('\n'),
    [unsafePath]: [
      'interface HttpClient {',
      '  get(url: string): Promise<Response>;',
      '  post(url: string): Promise<Response>;',
      '}',
      'function request(client: HttpClient, destination: string) {',
      '  return client.get(destination);',
      '}',
      'void request;',
    ].join('\n'),
    [disguisedPath]: [
      'interface CacheLikeHttpClient {',
      '  get(url: string): Promise<Response>;',
      '  set(key: string, value: string): void;',
      '  request(url: string): Promise<Response>;',
      '}',
      'function request(client: CacheLikeHttpClient, destination: string) {',
      '  return client.get(destination);',
      '}',
      'void request;',
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      `${disguisedPath}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      `${unsafePath}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      `${safePath}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires exact issuer bytes and collision-free module resolution', () => {
  const cases = [
    {
      files: {
        'apps/admin-dashboard/src/lib/api.ts': [
          'export function issueAdminUploadUrl(candidate) { return candidate; }',
          "fetch(issueAdminUploadUrl(candidate), { method: 'PUT' });",
        ].join('\n'),
      },
      path: 'apps/admin-dashboard/src/lib/api.ts',
    },
    {
      files: {
        'apps/admin-dashboard/src/lib/api.ts': [
          "import { issueAdminUploadUrl } from './api/index.js';",
          "fetch(issueAdminUploadUrl(candidate), { method: 'PUT' });",
        ].join('\n'),
        'apps/admin-dashboard/src/lib/api/index.ts':
          'export function issueAdminUploadUrl(candidate) { return candidate; }',
      },
      path: 'apps/admin-dashboard/src/lib/api.ts',
    },
    {
      files: {
        'apps/admin-dashboard/src/lib/api.ts': [
          "import { issueAdminUploadUrl } from './api.js';",
          "fetch(issueAdminUploadUrl(candidate), { method: 'PUT' });",
        ].join('\n'),
        'apps/admin-dashboard/src/lib/api.js':
          'export function issueAdminUploadUrl(candidate) { return candidate; }',
      },
      path: 'apps/admin-dashboard/src/lib/api.ts',
    },
  ];
  for (const { files, path } of cases) {
    const root = fixture(files);
    try {
      assert.deepEqual(providerClientBoundaryViolations(root), [
        `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rejects dynamic methods even for an exact issued target', () => {
  const path = 'apps/admin-dashboard/src/lib/export-jobs.ts';
  const files = {
    'apps/admin-dashboard/src/lib/api-http.ts':
      "export function resolveAdminApiUrl(path) { return new URL(path, 'https://admin.invalid').toString(); }",
    [path]: [
      "import { resolveAdminApiUrl } from './api-http.js';",
      "fetch(resolveAdminApiUrl('/v1/exports'), { method });",
    ].join('\n'),
  };
  const root = fixture(files);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root, { registry: registryWithFixtureDigests(files) }),
      [
        `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects network callables forwarded through wrappers and callbacks', () => {
  const cases = {
    'packages/api/src/services/callback-map.ts': 'urls.map(fetch);',
    'packages/api/src/services/callback-then.ts': 'Promise.resolve(url).then(fetch);',
    'packages/api/src/services/default-transport.ts':
      'function go(url, send = fetch) { return send(url); } void go;',
    'packages/api/src/services/destructured-transport.ts':
      'function dispatch({ send }, url) { return send(url); } dispatch({ send: fetch }, url);',
    'packages/api/src/services/forwarded-transport.ts':
      'function dispatch(send, url) { return send(url); } dispatch(fetch, url);',
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map(
          (path) =>
            `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unclassified browser outbound transports', () => {
  const cases = {
    'apps/checkout/src/lib/event-source.ts': 'new EventSource(url);',
    'apps/checkout/src/lib/send-beacon.ts': "navigator.sendBeacon(url, 'x');",
    'apps/checkout/src/lib/web-socket.ts': 'new WebSocket(url);',
    'apps/checkout/src/lib/xhr.ts': [
      'const request = new XMLHttpRequest();',
      "request.open('POST', url);",
      "request.send('x');",
    ].join('\n'),
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map(
          (path) =>
            `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects mixed approved and rogue non-provider target constituents', () => {
  const path = 'apps/admin-dashboard/src/lib/api.ts';
  const rejected = ['ticket.uploadUrl + rogueProviderUrl', '[rogueProviderUrl, apiBaseUrl()][0]'];
  for (const target of rejected) {
    const root = fixture({ [path]: `fetch(${target});\n` });
    try {
      assert.deepEqual(providerClientBoundaryViolations(root), [
        `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('does not authorize dynamic destinations from approved source spellings alone', () => {
  const cases = {
    'apps/admin-dashboard/src/lib/api.ts': [
      'export async function forgedUpload(uploadUrl, request) {',
      '  const completeUrl = request.completeUrl;',
      '  await fetch(uploadUrl);',
      '  await fetch(completeUrl);',
      '}',
    ].join('\n'),
    'apps/checkout/src/lib/api.ts': [
      'export async function forgedCheckoutOrigin() {',
      '  const apiBaseUrl = process.env.ROGUE_PROVIDER_URL;',
      '  return fetch(apiBaseUrl);',
      '}',
    ].join('\n'),
    'apps/docs/src/components/api-explorer.tsx': [
      'export async function forgedExplorer(opaqueCallback) {',
      '  return opaqueCallback((baseUrl) => fetch(baseUrl));',
      '}',
    ].join('\n'),
    'packages/shared/src/observability.ts': [
      'export async function forgedPushgateway(gatewayUrl, opaqueDestination, enabled) {',
      '  return fetch(enabled ? gatewayUrl : opaqueDestination);',
      '}',
    ].join('\n'),
    'packages/workflows/src/activities/webhook-delivery.ts': [
      "import { parseWebhookDeliveryUrl } from './trusted-validator.js';",
      'export async function forgedWebhook(rawUrl) {',
      '  const parseWebhookDeliveryUrl = (value) => value;',
      '  return fetch(parseWebhookDeliveryUrl(rawUrl));',
      '}',
    ].join('\n'),
    'packages/workflows/src/activities/migration-preparation.ts': [
      "import { validateMigrationSource } from './trusted-validator.js';",
      'export async function forgedMigration(input, opaqueDestination, useInput) {',
      '  const validateMigrationSource = (value) => value;',
      '  const destination = validateMigrationSource(input);',
      '  return fetch(useInput ? destination : input + opaqueDestination);',
      '}',
    ].join('\n'),
    'packages/api/src/services/portable-export.ts': [
      'export async function forgedObjectStore(store) {',
      '  const localAlias = store;',
      '  return fetch(localAlias);',
      '}',
    ].join('\n'),
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map(
          (path) =>
            `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
        ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidates issued target authority after object mutation', () => {
  const path = 'packages/workflows/src/activities/webhook-delivery.ts';
  const root = fixture({
    [path]: [
      'export function createValidatedWebhookTarget(rawUrl) { return Object.freeze({ hostname: rawUrl }); }',
      'export async function forgedMutation(rawUrl, rogueUrl) {',
      '  const target = createValidatedWebhookTarget(rawUrl);',
      '  target.hostname = rogueUrl;',
      "  return fetch(target.hostname, { method: 'POST' });",
      '}',
    ].join('\n'),
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      `${path}: runtime-configured provider HTTP execution must use a registry-approved transport executor`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unresolved dynamic loaders in every authored production source', () => {
  const cases = {
    'packages/api/src/services/dynamic-import.ts':
      "const Vendor = (await import(process.env.PROVIDER_SDK)).default; new Vendor('secret');\n",
    'packages/api/src/services/dynamic-require.cts':
      "const Vendor = require(process.env.PROVIDER_SDK); new Vendor('secret');\n",
    'packages/workflows/src/activities/aliased-require.cts':
      "const load = require; const Vendor = load(process.env.PROVIDER_SDK); new Vendor('secret');\n",
    'packages/provider-clients/src/created-require.ts':
      "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const Vendor = load(process.env.PROVIDER_SDK); new Vendor('secret');\n",
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map((path) => `${path}: unresolved dynamic module loading is prohibited`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects SDK loading through object properties and bound module.require aliases', () => {
  const root = fixture({
    'packages/api/src/services/object-require.cts':
      "const holder = { load: require }; const Stripe = holder.load('stripe'); new Stripe('secret');\n",
    'packages/api/src/services/bound-module-require.cts':
      "const load = module.require.bind(module); const Stripe = load('stripe'); new Stripe('secret');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/api/src/services/bound-module-require.cts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
      'packages/api/src/services/object-require.cts: server-side Stripe SDK execution must cross @tixkit/provider-clients',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unresolved dynamic loaders through createRequire, Reflect, call, and bind', () => {
  const cases = {
    'apps/docs/src/dynamic-import.ts': 'void import(process.env.PROVIDER_SDK);\n',
    'packages/domain/src/create-require.cts':
      "const { createRequire: make } = require('node:module'); const load = make(import.meta.url); load(process.env.PROVIDER_SDK);\n",
    'packages/shared/src/reflect-require.cts':
      'Reflect.apply(require, null, [process.env.PROVIDER_SDK]);\n',
    'packages/shared/src/call-require.cts': 'require.call(null, process.env.PROVIDER_SDK);\n',
    'packages/shared/src/bind-require.cts':
      'const load = require.bind(null); load(process.env.PROVIDER_SDK);\n',
    'packages/shared/src/array-require.cts':
      'const [load] = [require]; load(process.env.PROVIDER_SDK);\n',
    'packages/shared/src/default-require.cts':
      'const { load = require } = {}; load(process.env.PROVIDER_SDK);\n',
    'packages/shared/src/computed-require.cts':
      "module['re' + 'quire'](process.env.PROVIDER_SDK);\n",
    'packages/shared/src/eval.ts': "eval('1');\n",
    'packages/shared/src/function.ts': "new Function('return 1');\n",
  };
  const root = fixture(cases);
  try {
    assert.deepEqual(
      providerClientBoundaryViolations(root),
      Object.keys(cases)
        .sort()
        .map((path) => `${path}: unresolved dynamic module loading is prohibited`),
    );
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
      assert.deepEqual(
        providerClientBoundaryViolations(root),
        source.startsWith('eval(')
          ? [violation, `${webhookPath}: unresolved dynamic module loading is prohibited`]
          : [violation],
        source,
      );
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

test('permits the browser Stripe CSP origin and confines direct REST to the exact executor', () => {
  const root = fixture({
    'apps/checkout/src/lib/checkout-security-headers.ts':
      'export function checkoutContentSecurityPolicy() { return ["connect-src \'self\' https://api.stripe.com"]; }\n',
    'packages/provider-clients/src/stripe-rest.ts':
      "fetch('https://api.stripe.com/v1/payment_intents');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'packages/provider-clients/src/stripe-rest.ts: server-side Stripe REST execution must cross @tixkit/provider-clients',
    ]);
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
    'apps/docs/.next/server/chunk.js': "fetch('https://api.stripe.com/v1/payment_intents');\n",
    'apps/sdk-astro-demo/.astro/types.d.ts':
      "fetch('https://api.stripe.com/v1/payment_intents');\n",
    'apps/sdk-nuxt-demo/.nuxt/dist/server/chunk.mjs':
      "fetch('https://api.stripe.com/v1/payment_intents');\n",
    'apps/sdk-sveltekit-demo/.svelte-kit/output/client/chunk.js':
      "fetch('https://api.stripe.com/v1/payment_intents');\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores framework-generated roots without excluding adjacent authored sources', () => {
  const root = fixture({
    'apps/sdk-astro-demo/.astro/generated.js': "fetch('https://api.generated-astro.invalid/v1');\n",
    'apps/sdk-astro-demo/src/pages/index.ts': "fetch('https://api.authored-astro.invalid/v1');\n",
    'apps/sdk-astro-demo/src/pages/attack.astro':
      "---\nfetch('https://api.authored-astro-frontmatter.invalid/v1');\n---\n<script>fetch('https://api.authored-astro-script.invalid/v1')</script>\n<button onclick=\"fetch('https://api.authored-astro-handler.invalid/v1')\">Run</button>\n<div>{/* } */ fetch('https://api.authored-astro-comment.invalid/v1')}</div>\n<div>{(() => { const send = fetch; return send('https://api.authored-astro-alias.invalid/v1'); })()}</div>\n",
    'apps/sdk-nuxt-demo/.nuxt/generated.js': "fetch('https://api.generated-nuxt.invalid/v1');\n",
    'apps/sdk-nuxt-demo/server/api/example.ts': "fetch('https://api.authored-nuxt.invalid/v1');\n",
    'apps/sdk-nuxt-demo/pages/attack.vue':
      '<script setup="setup" lang="ts">fetch(\'https://api.authored-vue.invalid/v1\')</script>\n<template><button @click.once="$fetch(\'https://api.authored-vue-handler.invalid/v1\')">Run</button><button v-on:[event]="$fetch(\'https://api.authored-vue-dynamic.invalid/v1\')">Dynamic</button><button @click="() => { const send = fetch; return send(\'https://api.authored-vue-alias.invalid/v1\'); }">Alias</button><div v-if="$fetch(\'https://api.authored-vue-directive.invalid/v1\')">Conditional</div></template>\n',
    'apps/sdk-sveltekit-demo/.svelte-kit/generated.js':
      "fetch('https://api.generated-svelte.invalid/v1');\n",
    'apps/sdk-sveltekit-demo/src/routes/example.ts':
      "fetch('https://api.authored-svelte.invalid/v1');\n",
    'apps/sdk-sveltekit-demo/src/routes/attack.svelte':
      "<script context=\"module\">fetch('https://api.authored-svelte.invalid/v1')</script>\n<p>Don't skip this text.</p><button onclick={() => fetch('https://api.authored-svelte-handler.invalid/v1')}>Run</button>\n<div>{/* } */ fetch('https://api.authored-svelte-comment.invalid/v1')}</div>\n<div>{(() => { const send = fetch; return send('https://api.authored-svelte-alias.invalid/v1'); })()}</div>\n<div>{globalThis['\\x66etch']('https\\x3a//api.stripe.com/v1/refunds')}</div>\n{#await fetch('https://api.authored-svelte-await.invalid/v1')}<p>Loading</p>{:then value}<p>{value}</p>{/await}\n{#await Promise.resolve([' then ', fetch('https://api.authored-svelte-await-delimiter.invalid/v1')]) then value}<p>{value}</p>{/await}\n{#each [fetch('https://api.authored-svelte-each.invalid/v1'), ' as '] as item}<p>{item}</p>{/each}\n{#if false}<p>No</p>{:else if fetch('https://api.authored-svelte-else-if.invalid/v1')}<p>Yes</p>{/if}\n<div {@attach () => { fetch('https://api.authored-svelte-attach.invalid/v1'); }}></div>\n{#snippet card(value = fetch('https://api.authored-svelte-snippet.invalid/v1'))}<p>{value}</p>{/snippet}{@render card()}\n",
  });
  try {
    assert.deepEqual(providerClientBoundaryViolations(root), [
      'apps/sdk-astro-demo/src/pages/attack.astro: outbound host is not classified in the provider registry: api.authored-astro-alias.invalid',
      'apps/sdk-astro-demo/src/pages/attack.astro: outbound host is not classified in the provider registry: api.authored-astro-comment.invalid',
      'apps/sdk-astro-demo/src/pages/attack.astro: outbound host is not classified in the provider registry: api.authored-astro-frontmatter.invalid',
      'apps/sdk-astro-demo/src/pages/attack.astro: outbound host is not classified in the provider registry: api.authored-astro-handler.invalid',
      'apps/sdk-astro-demo/src/pages/attack.astro: outbound host is not classified in the provider registry: api.authored-astro-script.invalid',
      'apps/sdk-astro-demo/src/pages/index.ts: outbound host is not classified in the provider registry: api.authored-astro.invalid',
      'apps/sdk-nuxt-demo/pages/attack.vue: outbound host is not classified in the provider registry: api.authored-vue-alias.invalid',
      'apps/sdk-nuxt-demo/pages/attack.vue: outbound host is not classified in the provider registry: api.authored-vue-directive.invalid',
      'apps/sdk-nuxt-demo/pages/attack.vue: outbound host is not classified in the provider registry: api.authored-vue-dynamic.invalid',
      'apps/sdk-nuxt-demo/pages/attack.vue: outbound host is not classified in the provider registry: api.authored-vue-handler.invalid',
      'apps/sdk-nuxt-demo/pages/attack.vue: outbound host is not classified in the provider registry: api.authored-vue.invalid',
      'apps/sdk-nuxt-demo/server/api/example.ts: outbound host is not classified in the provider registry: api.authored-nuxt.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-alias.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-attach.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-await-delimiter.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-await.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-comment.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-each.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-else-if.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-handler.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte-snippet.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: outbound host is not classified in the provider registry: api.authored-svelte.invalid',
      'apps/sdk-sveltekit-demo/src/routes/attack.svelte: server-side Stripe REST execution must cross @tixkit/provider-clients',
      'apps/sdk-sveltekit-demo/src/routes/example.ts: outbound host is not classified in the provider registry: api.authored-svelte.invalid',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
