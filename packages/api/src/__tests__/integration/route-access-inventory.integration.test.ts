import { describe, expect, it } from 'vitest';
import { buildRouteAccessInventory } from './route-access-inventory.js';
import { buildAuthenticatedRouteTestApp } from './route-manifest.js';

const operationalPaths = new Set(['/health', '/metrics', '/ready']);
const signedWebhookSchemes = new Set([
  'SvixSignature',
  'EmailProviderSignature',
  'StripeSignature',
  'TelnyxSignature',
]);
const authenticatedSchemes = new Set(['ApiKey', 'BearerAuth', 'ScannerDeviceAuth']);
const signedWebhookRejections: Readonly<Record<string, { code: string; status: number }>> = {
  EmailProviderSignature: { code: 'INVALID_SIGNATURE', status: 400 },
  StripeSignature: { code: 'WEBHOOK_SIGNATURE_INVALID', status: 400 },
  SvixSignature: { code: 'WEBHOOK_SIGNATURE_INVALID', status: 401 },
  TelnyxSignature: { code: 'WEBHOOK_SIGNATURE_INVALID', status: 400 },
};

function invalidCredentialHeaders(scheme: string): Record<string, string> {
  if (scheme === 'ApiKey') return { authorization: 'Bearer tk_invalid' };
  if (scheme === 'BearerAuth') return { authorization: 'Bearer invalid-user-token' };
  if (scheme === 'MetricsBearer') return { authorization: 'Bearer invalid-metrics-token' };
  if (scheme === 'ScannerDeviceAuth') {
    return { 'x-device-id': 'invalid-device', 'x-device-secret': 'invalid-secret' };
  }
  if (scheme === 'SvixSignature') {
    return {
      'svix-id': 'invalid-message',
      'svix-signature': 'v1,invalid-signature',
      'svix-timestamp': '1',
    };
  }
  if (scheme === 'StripeSignature') return { 'stripe-signature': 'invalid-signature' };
  if (scheme === 'TelnyxSignature') {
    return {
      'telnyx-signature-ed25519': 'invalid-signature',
      'telnyx-timestamp': '1',
    };
  }
  if (scheme === 'EmailProviderSignature') {
    return { 'x-tixkit-provider-signature': 'sha256=invalid-signature' };
  }
  throw new Error(`Unsupported authenticated credential scheme: ${scheme}`);
}

describe('API route access inventory (C-123)', () => {
  it('classifies every runtime operation and its credential boundary', async () => {
    const inventory = await buildRouteAccessInventory();
    const failures: string[] = [];

    for (const route of inventory.routes) {
      const label = `${route.method} ${route.path}`;
      if (route.access === 'operational') {
        if (!operationalPaths.has(route.path)) failures.push(`${label}: unknown operational route`);
        const expectedSchemes = route.path === '/metrics' ? ['MetricsBearer'] : [];
        if (JSON.stringify(route.credentialSchemes) !== JSON.stringify(expectedSchemes)) {
          failures.push(`${label}: unexpected operational credential policy`);
        }
        continue;
      }

      if (!route.operationId) failures.push(`${label}: missing OpenAPI operationId`);
      if (route.access === 'public' && route.credentialSchemes.length > 0) {
        failures.push(`${label}: public route declares ${route.credentialSchemes.join(', ')}`);
      }
      if (
        route.access === 'signed-webhook' &&
        (route.credentialSchemes.length !== 1 ||
          !signedWebhookSchemes.has(route.credentialSchemes[0]!))
      ) {
        failures.push(`${label}: signed webhook lacks one recognized signature scheme`);
      }
      if (
        route.access === 'authenticated' &&
        (route.credentialSchemes.length === 0 ||
          route.credentialSchemes.some((scheme) => !authenticatedSchemes.has(scheme)))
      ) {
        failures.push(`${label}: authenticated route lacks a recognized credential scheme`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('requires permission or delegated guard evidence for every authenticated operation', async () => {
    const inventory = await buildRouteAccessInventory();
    const unguarded = inventory.routes
      .filter(
        (route) =>
          route.access === 'authenticated' &&
          route.permissionPolicy !== 'credential-only' &&
          route.guardEvidence.length === 0,
      )
      .map((route) => `${route.method} ${route.path} (${route.operationId ?? 'no operationId'})`);

    expect(unguarded).toEqual([]);
  });

  it('has unique operation IDs and method/path pairs', async () => {
    const inventory = await buildRouteAccessInventory();
    const operationIds = inventory.routes.flatMap((route) =>
      route.operationId === null ? [] : [route.operationId],
    );
    const routeKeys = inventory.routes.map((route) => `${route.method} ${route.path}`);

    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
  });

  it('rejects missing credentials on every authenticated runtime route', async () => {
    const { app, routes } = await buildAuthenticatedRouteTestApp();
    const failures: string[] = [];

    try {
      for (const route of routes) {
        if (route.access !== 'authenticated' || route.method === 'HEAD') continue;
        const url = route.url.replace(/:([A-Za-z0-9_]+)/g, 'inventory-test-$1');
        const response = await app.inject({ method: route.method as 'GET', url });
        if (response.statusCode !== 401) {
          failures.push(`${route.method} ${route.url}: returned ${response.statusCode}`);
        }
      }
    } finally {
      await app.close();
    }

    expect(failures).toEqual([]);
  });

  it('rejects every invalid credential type declared by each protected operation', async () => {
    const inventory = await buildRouteAccessInventory();
    const originalEnvironment = {
      CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
      EMAIL_WEBHOOK_SECRET: process.env.EMAIL_WEBHOOK_SECRET,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      TELNYX_WEBHOOK_PUBLIC_KEY: process.env.TELNYX_WEBHOOK_PUBLIC_KEY,
    };
    process.env.CLERK_WEBHOOK_SECRET = 'whsec_test-secret-for-route-inventory';
    process.env.EMAIL_WEBHOOK_SECRET = 'email-secret-for-route-inventory';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stripe_route_inventory';
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64');
    const { app } = await buildAuthenticatedRouteTestApp();
    const failures: string[] = [];

    try {
      for (const route of inventory.routes) {
        if (route.credentialSchemes.length === 0) continue;
        const url = (
          route.access === 'operational' ? route.path : `/v1${route.path === '/' ? '' : route.path}`
        ).replace(/\{([^}]+)\}/g, 'inventory-test-$1');
        for (const scheme of route.credentialSchemes) {
          const response = await app.inject({
            method: route.method as 'GET',
            url,
            headers: invalidCredentialHeaders(scheme),
            ...(route.access === 'signed-webhook' ? { payload: {} } : {}),
          });
          const responseBody = response.json() as {
            code?: string;
            error?: { code?: string } | string;
          };
          const responseCode =
            typeof responseBody.error === 'object' ? responseBody.error.code : responseBody.code;
          const expectedWebhookRejection = signedWebhookRejections[scheme];
          const rejected = expectedWebhookRejection
            ? response.statusCode === expectedWebhookRejection.status &&
              responseCode === expectedWebhookRejection.code
            : response.statusCode === 401;
          if (!rejected) {
            failures.push(
              `${route.method} ${route.path} with invalid ${scheme}: returned ${response.statusCode} ${responseCode ?? 'without-code'}`,
            );
          }
        }
        if (route.access === 'authenticated' && route.credentialSchemes.includes('BearerAuth')) {
          const oauthResponse = await app.inject({
            method: route.method as 'GET',
            url,
            headers: { authorization: 'Bearer tk_oat_invalid' },
          });
          if (oauthResponse.statusCode !== 401) {
            failures.push(
              `${route.method} ${route.path} with invalid OAuthAccessToken: returned ${oauthResponse.statusCode}`,
            );
          }
        }
      }
    } finally {
      await app.close();
      for (const [name, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    expect(failures).toEqual([]);
  });
});
