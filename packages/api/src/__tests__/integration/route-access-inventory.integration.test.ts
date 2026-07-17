import { describe, expect, it } from 'vitest';
import {
  assertDocumentedPermissionsAccountedFor,
  buildRouteAccessInventory,
  guardEvidenceFromSource,
  negativeAuthorizationEvidenceForRoutes,
  permissionsFromSource,
} from './route-access-inventory.js';
import { buildAuthenticatedRouteTestApp, buildRouteManifest } from './route-manifest.js';
import {
  ATTENDEE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  BOX_OFFICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  CHECK_IN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ORDER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  PROVIDER_INCIDENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  RESALE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  type RouteAuthorizationDenialContract,
} from './route-authorization-contracts.js';

const operationalPaths = new Set(['/health', '/metrics', '/ready']);
const signedWebhookSchemes = new Set([
  'SvixSignature',
  'EmailProviderSignature',
  'StripeSignature',
  'TelnyxSignature',
]);
const authenticatedSchemes = new Set(['AgentOAuth', 'ApiKey', 'BearerAuth', 'ScannerDeviceAuth']);
const eventScopeGuards = new Set([
  'assertEventIds',
  'ClerkAuthService.requireEventScope',
  'loadCampaignProviderEventItems',
  'loadAuthorizedCampaign',
  'loadAuthorizedEvent',
  'requireEventAccess',
  'requireReportEventAccess',
  'scopedEvent',
]);
const orderScopeGuards = [
  'ClerkAuthService.requireResourceTenant',
  'ClerkAuthService.requireOrganizationScope',
  'ClerkAuthService.requireBrandScope',
  'ClerkAuthService.requireEventScope',
] as const;
const signedWebhookRejections: Readonly<Record<string, { code: string; status: number }>> = {
  EmailProviderSignature: { code: 'INVALID_SIGNATURE', status: 400 },
  StripeSignature: { code: 'WEBHOOK_SIGNATURE_INVALID', status: 400 },
  SvixSignature: { code: 'WEBHOOK_SIGNATURE_INVALID', status: 401 },
  TelnyxSignature: { code: 'WEBHOOK_SIGNATURE_INVALID', status: 400 },
};

function invalidCredentialHeaders(scheme: string): Record<string, string> {
  if (scheme === 'ApiKey') return { authorization: 'Bearer tk_invalid' };
  if (scheme === 'AgentOAuth') return { authorization: 'Bearer tk_aat_invalid' };
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
  it('binds the immutable denial matrices into schema v4 evidence', async () => {
    const inventory = await buildRouteAccessInventory();
    const coveredRoutes = inventory.routes.filter(
      (route) => route.negativeAuthorizationEvidence.length > 0,
    );

    expect(inventory.schemaVersion).toBe(4);
    expect(EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(13);
    expect(ORDER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(5);
    expect(PROVIDER_INCIDENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(2);
    expect(MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(2);
    expect(SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(2);
    expect(ATTENDEE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(1);
    expect(CHECK_IN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(1);
    expect(BOX_OFFICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(1);
    expect(UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(3);
    expect(RESALE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(6);
    expect(ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(38);
    expect(Object.isFrozen(ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)).toBe(true);
    expect(
      ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.every(
        (contract) =>
          Object.isFrozen(contract) &&
          Object.isFrozen(contract.deniedBoundaries) &&
          (!contract.permissionDenialResponse ||
            Object.isFrozen(contract.permissionDenialResponse)) &&
          (!contract.policyDenialResponse || Object.isFrozen(contract.policyDenialResponse)) &&
          (!contract.policyCondition || Object.isFrozen(contract.policyCondition)) &&
          (!contract.policyDeniedBoundaries || Object.isFrozen(contract.policyDeniedBoundaries)) &&
          Object.isFrozen(contract.resourceParameters) &&
          Object.isFrozen(contract.sideEffectAssertions),
      ),
    ).toBe(true);
    expect(coveredRoutes).toHaveLength(38);
    expect(coveredRoutes.flatMap((route) => route.negativeAuthorizationEvidence)).toHaveLength(125);
    expect(
      inventory.routes
        .filter((route) => route.operationId?.includes('UploadArtifacts'))
        .flatMap((route) => route.negativeAuthorizationEvidence)
        .filter((evidence) => evidence.denialKind === 'policy'),
    ).toHaveLength(3);
    expect(
      inventory.routes
        .flatMap((route) => route.negativeAuthorizationEvidence)
        .filter((evidence) => evidence.denialKind === 'policy')
        .map((evidence) => evidence.condition),
    ).toEqual([
      { discriminator: 'purpose', value: 'user_avatar' },
      { discriminator: 'purpose', value: 'user_avatar' },
      { discriminator: 'purpose', value: 'user_avatar' },
    ]);
    expect(
      inventory.routes.find((route) => route.path === '/health')?.negativeAuthorizationEvidence,
    ).toEqual([]);
    expect(coveredRoutes.map((route) => route.operationId).sort()).toEqual(
      ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map((contract) => contract.operationId).sort(),
    );
  });

  it('recognizes the settlement scope loader as the complete delegated event boundary', async () => {
    const inventory = await buildRouteAccessInventory();
    const settlementRoutes = inventory.routes.filter((route) =>
      route.path.startsWith('/ticket-listings/{listingId}/settlement'),
    );

    expect(settlementRoutes).toHaveLength(3);
    for (const route of settlementRoutes) {
      expect(route.guardEvidence).toContain('loadSettlementScope');
      expect(route.boundaries).toEqual(
        expect.arrayContaining(['tenant', 'organization', 'brand', 'event']),
      );
    }
  });

  it('fails closed when OpenAPI claims permission absent from runtime or declared delegated evidence', async () => {
    const inventory = await buildRouteAccessInventory();
    const route = inventory.routes.find((candidate) => candidate.operationId === 'getEvents')!;

    expect(() =>
      assertDocumentedPermissionsAccountedFor({
        ...route,
        documentedPermissions: ['billing.write'],
      }),
    ).toThrow(/billing\.write lacks runtime or declared delegated evidence/);
  });

  it('extracts only reachable calls to exact enforcing permission guards', async () => {
    expect(
      permissionsFromSource(`async function handler(principal) {
        const optional = hasPermission(principal, 'settings.write');
        const text = "ClerkAuthService.requirePermission(principal, 'billing.write')";
        // ClerkAuthService.requirePermission(principal, 'orders.write');
        if (false) ClerkAuthService.requirePermission(principal, 'messages.write');
        FakeClerkAuthService.requirePermission(principal, 'attendees.write');
        attacker.ClerkAuthService.requirePermission(principal, 'tickets.write');
        requireAnyPermission(principal, [() => 'reports.read']);
        ClerkAuthService.requireAnyPermission(principal, ['events.read', 'events.write']);
        requireMigrationPermission(principal, 'migrations.read');
        return optional || text;
      }`),
    ).toEqual(['events.read', 'events.write', 'migrations.read']);
    const brands = (await buildRouteManifest()).find(
      (route) => route.method === 'GET' && route.url === '/v1/brands',
    )!;
    expect(permissionsFromSource(brands.handlerSource)).toEqual(['settings.write']);
    expect(
      guardEvidenceFromSource(`async function handler() {
        const text = 'requireHumanApprover()';
        // requireHistoricalAuthorizationPrincipal();
        if (false) report();
        requireExportTypePermission();
      }`),
    ).toEqual(['requireExportTypePermission']);
  });

  it('binds documented delegated permissions to audited runtime guard contracts', async () => {
    const inventory = await buildRouteAccessInventory();
    const expected = new Map([
      ['postAgentDelegations', ['developers.write', 'requireHumanAgentAdministrator']],
      ['postAgentActionsByActionIdApprovals', ['events.write', 'requireHumanApprover']],
      ['getMigrationReport', ['migrations.read', 'report']],
      [
        'grantPortableHistoricalExportAuthorization',
        ['migrations.write', 'requireHistoricalAuthorizationPrincipal'],
      ],
    ]);

    for (const [operationId, [permission, guard]] of expected) {
      const route = inventory.routes.find((candidate) => candidate.operationId === operationId)!;
      expect(route.permissions).toContain(permission);
      expect(route.documentedPermissions).toContain(permission);
      expect(route.permissionEvidence).toContain(
        `declared-delegated-contract:${operationId}:${guard}:${permission}`,
      );
      expect(route.permissionDocumentationStatus).toBe('delegated-contract');
    }
  });

  it('preserves conditional OpenAPI clauses and makes undocumented runtime requirements explicit', async () => {
    const inventory = await buildRouteAccessInventory();
    const exportsRoute = inventory.routes.find((route) => route.operationId === 'postExports')!;
    const undocumented = inventory.routes.filter(
      (route) => route.permissionDocumentationStatus === 'runtime-undocumented',
    );

    expect(exportsRoute.documentedPermissionClauses).toEqual([
      { kind: 'base', permissions: ['reports.read'] },
      {
        discriminator: 'type',
        kind: 'conditional',
        permissions: ['attendees.read'],
        value: 'attendees',
      },
      {
        discriminator: 'type',
        kind: 'conditional',
        permissions: ['orders.read'],
        value: 'orders',
      },
      {
        discriminator: 'type',
        kind: 'conditional',
        permissions: ['orders.read'],
        value: 'sales',
      },
      {
        discriminator: 'type',
        kind: 'conditional',
        permissions: ['orders.read'],
        value: 'tax',
      },
      {
        discriminator: 'type',
        kind: 'conditional',
        permissions: ['checkins.read'],
        value: 'tickets',
      },
      {
        discriminator: 'type',
        kind: 'conditional',
        permissions: ['checkins.read'],
        value: 'scan_logs',
      },
    ]);
    expect(exportsRoute.permissionDocumentationStatus).toBe('delegated-contract');
    expect(undocumented.length).toBeGreaterThan(0);
    expect(
      inventory.routes.find((route) => route.operationId === 'getBootstrapContext')
        ?.permissionEvidence,
    ).not.toContain('literal:settings.write');
    expect(
      inventory.routes
        .filter((route) =>
          [
            'cancelMigrationJob',
            'pauseMigrationJob',
            'resumeMigrationJob',
            'rollbackMigrationJob',
          ].includes(route.operationId ?? ''),
        )
        .map((route) => [route.operationId, route.permissionDocumentationStatus]),
    ).toEqual([
      ['cancelMigrationJob', 'conditional-unverified'],
      ['pauseMigrationJob', 'conditional-unverified'],
      ['resumeMigrationJob', 'conditional-unverified'],
      ['rollbackMigrationJob', 'conditional-unverified'],
    ]);
  });

  it('fails closed for invalid denial-contract fixtures', async () => {
    const inventory = await buildRouteAccessInventory();
    const base = ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const mutation = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
      (contract) => contract.method === 'POST',
    )!;
    const route = inventory.routes.find(
      (candidate) => candidate.method === base.method && candidate.path === base.path,
    )!;
    const mutationRoute = inventory.routes.find(
      (candidate) => candidate.method === mutation.method && candidate.path === mutation.path,
    )!;
    const deleteMutation = MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
      (contract) => contract.method === 'DELETE',
    )!;
    const deleteMutationRoute = inventory.routes.find(
      (candidate) =>
        candidate.method === deleteMutation.method && candidate.path === deleteMutation.path,
    )!;
    const conditionalPolicy = UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const conditionalPolicyRoute = inventory.routes.find(
      (candidate) =>
        candidate.method === conditionalPolicy.method && candidate.path === conditionalPolicy.path,
    )!;
    const invalidFixtures: Array<{
      contracts: readonly RouteAuthorizationDenialContract[];
      message: RegExp;
      routes: typeof inventory.routes;
    }> = [
      { contracts: [base], message: /runtime route is missing/, routes: [] },
      {
        contracts: [base],
        message: /not authenticated/,
        routes: [{ ...route, access: 'public' }],
      },
      {
        contracts: [{ ...base, operationId: `${base.operationId}Renamed` }],
        message: /operationId/,
        routes: [route],
      },
      {
        contracts: [{ ...base, resourceParameters: [] }],
        message: /do not match path parameters/,
        routes: [route],
      },
      {
        contracts: [base, base],
        message: /duplicate route\/boundary pair/,
        routes: [route],
      },
      {
        contracts: [
          {
            ...base,
            denialResponse: { code: 'NOT_FOUND', status: 403 },
          } as unknown as RouteAuthorizationDenialContract,
        ],
        message: /404 NOT_FOUND/,
        routes: [route],
      },
      {
        contracts: [{ ...mutation, sideEffectAssertions: [] }],
        message: /omits persistence or workflow side-effect proof/,
        routes: [mutationRoute],
      },
      {
        contracts: [{ ...conditionalPolicy, policyCondition: undefined }],
        message: /policy denials require an explicit condition/,
        routes: [conditionalPolicyRoute],
      },
      {
        contracts: [
          {
            ...conditionalPolicy,
            policyCondition: { discriminator: 'purpose', value: 'event_cover' },
          } as unknown as RouteAuthorizationDenialContract,
        ],
        message: /unsupported policy condition/,
        routes: [conditionalPolicyRoute],
      },
      {
        contracts: [
          {
            ...conditionalPolicy,
            policyCondition: {
              discriminator: 'uploadPurpose',
              value: 'user_avatar',
            },
          } as unknown as RouteAuthorizationDenialContract,
        ],
        message: /unsupported policy condition/,
        routes: [conditionalPolicyRoute],
      },
      {
        contracts: [{ ...deleteMutation, authorizedControl: { required: true, status: 201 } }],
        message: /DELETE authorized control must be 204/,
        routes: [deleteMutationRoute],
      },
      {
        contracts: [
          {
            ...deleteMutation,
            permissionDenialResponse: { code: 'FORBIDDEN', status: 404 },
          } as unknown as RouteAuthorizationDenialContract,
        ],
        message: /403 FORBIDDEN/,
        routes: [deleteMutationRoute],
      },
      {
        contracts: [{ ...base, source: 'fabricated.test.ts' }],
        message: /source is not bound to this operationId/,
        routes: [route],
      },
      {
        contracts: [{ ...mutation, persistenceSource: 'fabricated.test.ts' }],
        message: /persistence source is not bound to this operationId/,
        routes: [mutationRoute],
      },
      {
        contracts: [{ ...base, source: 'order-route-authorization-db.integration.test.ts' }],
        message: /source is not bound to this operationId/,
        routes: [route],
      },
      {
        contracts: [{ ...mutation, persistenceSource: 'import-platform.integration.test.ts' }],
        message: /persistence source is not bound to this operationId/,
        routes: [mutationRoute],
      },
      {
        contracts: [
          {
            ...mutation,
            sideEffectAssertions: ['telemetry'],
          } as unknown as RouteAuthorizationDenialContract,
        ],
        message: /omits persistence or workflow side-effect proof/,
        routes: [mutationRoute],
      },
    ];

    for (const fixture of invalidFixtures) {
      expect(() =>
        negativeAuthorizationEvidenceForRoutes(fixture.routes, fixture.contracts),
      ).toThrow(fixture.message);
    }
  });

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

  it('requires event-scope evidence on every authenticated event route', async () => {
    const inventory = await buildRouteAccessInventory();
    const missingEventScope = inventory.routes
      .filter(
        (route) =>
          route.access === 'authenticated' &&
          route.path.startsWith('/events/{eventId}') &&
          !route.guardEvidence.some((guard) => eventScopeGuards.has(guard)),
      )
      .map((route) => `${route.method} ${route.path} (${route.operationId})`);

    expect(missingEventScope).toEqual([]);
  });

  it('requires every tenant and delegated scope guard on authenticated order routes', async () => {
    const inventory = await buildRouteAccessInventory();
    const incompleteOrderScope = inventory.routes
      .filter(
        (route) =>
          route.access === 'authenticated' &&
          route.path.startsWith('/orders/{orderId}') &&
          orderScopeGuards.some((guard) => !route.guardEvidence.includes(guard)),
      )
      .map((route) => `${route.method} ${route.path} (${route.operationId})`);

    expect(incompleteOrderScope).toEqual([]);
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
