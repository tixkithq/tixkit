import { ALL_PERMISSIONS, type Permission } from '@tixkit/domain';
import { openApiSpec } from '@tixkit/openapi';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import { buildRouteManifest, type RouteAccess } from './route-manifest.js';
import {
  ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  type AuthorizationBoundary,
  type AuthorizationSideEffectKind,
  type RouteAuthorizationDenialContract,
} from './route-authorization-contracts.js';

type OpenApiOperation = {
  operationId?: string;
  security?: readonly Record<string, readonly string[]>[];
  'x-principal-type-restrictions'?: {
    byUploadPurpose?: Readonly<Record<string, readonly string[]>>;
  };
  'x-required-permissions'?:
    | readonly Permission[]
    | {
        allOf?: readonly Permission[];
        anyOf?: readonly Permission[];
        base?: readonly Permission[];
        byType?: Readonly<Record<string, readonly Permission[]>>;
      };
};

export type DocumentedPermissionClause = {
  discriminator?: string;
  kind: 'all-of' | 'any-of' | 'base' | 'conditional';
  permissions: Permission[];
  value?: string;
};

export type RouteAccessInventoryEntry = {
  access: RouteAccess;
  boundaries: string[];
  credentialSchemes: string[];
  documentedPermissions: Permission[];
  documentedPermissionClauses: DocumentedPermissionClause[];
  guardEvidence: string[];
  method: string;
  negativeAuthorizationEvidence: NegativeAuthorizationEvidence[];
  operationId: string | null;
  path: string;
  permissionEvidence: string[];
  permissionDocumentationStatus:
    | 'credential-only'
    | 'conditional-unverified'
    | 'delegated-contract'
    | 'delegated-undocumented'
    | 'not-applicable'
    | 'runtime-undocumented'
    | 'verified';
  permissions: Permission[];
  permissionPolicy: 'explicit' | 'delegated' | 'credential-only' | 'not-applicable';
};

export type RouteAccessInventory = {
  schemaVersion: 4;
  routes: RouteAccessInventoryEntry[];
};

export type NegativeAuthorizationEvidence = {
  authorizedControlStatus: 200 | 201 | 202 | 204 | 410;
  boundary: AuthorizationBoundary;
  condition:
    | Readonly<{
        discriminator: 'principal-scope';
        value: 'no-event-scope' | 'organization-wide';
      }>
    | Readonly<{ discriminator: 'purpose'; value: 'user_avatar' }>
    | null;
  denialKind: 'permission' | 'policy' | 'resource-boundary';
  deniedCode: 'FORBIDDEN' | 'NOT_FOUND';
  deniedStatus: 403 | 404;
  persistenceSource: string | null;
  sideEffectAssertions: AuthorizationSideEffectKind[];
  source: string;
};

const EXECUTABLE_AUTHORIZATION_EVIDENCE_SOURCES = new Map([
  [
    'event-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'event-route-authorization-db.integration.test.ts'),
  ],
  [
    'tenant-list-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'tenant-list-route-authorization-db.integration.test.ts'),
  ],
  [
    'migration-job-read-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'migration-job-read-route-authorization-db.integration.test.ts'),
  ],
  [
    'migration-mapping-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'migration-mapping-route-authorization-db.integration.test.ts'),
  ],
  [
    'migration-job-write-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'migration-job-write-route-authorization-db.integration.test.ts'),
  ],
  [
    'order-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'order-route-authorization-db.integration.test.ts'),
  ],
  [
    'provider-incident-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'provider-incident-route-authorization-db.integration.test.ts'),
  ],
  [
    'migration-credential-route-authorization.test.ts',
    resolve(import.meta.dirname, '../migration-credential-route-authorization.test.ts'),
  ],
  [
    'import-platform.integration.test.ts',
    resolve(
      import.meta.dirname,
      '../../../../db/src/__tests__/integration/import-platform.integration.test.ts',
    ),
  ],
  [
    'api-key-route-authorization.test.ts',
    resolve(import.meta.dirname, '../api-key-route-authorization.test.ts'),
  ],
  [
    'api-key-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'api-key-route-authorization-db.integration.test.ts'),
  ],
  [
    'scanner-device-route-authorization.test.ts',
    resolve(import.meta.dirname, '../scanner-device-route-authorization.test.ts'),
  ],
  [
    'scanner-device-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'scanner-device-route-authorization-db.integration.test.ts'),
  ],
  [
    'resale-routes-db.integration.test.ts',
    resolve(import.meta.dirname, 'resale-routes-db.integration.test.ts'),
  ],
  [
    'resale-settlement-routes.test.ts',
    resolve(import.meta.dirname, '../resale-settlement-routes.test.ts'),
  ],
  [
    'resale-settlement-concurrency-db.integration.test.ts',
    resolve(import.meta.dirname, 'resale-settlement-concurrency-db.integration.test.ts'),
  ],
  [
    'attendee-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'attendee-route-authorization-db.integration.test.ts'),
  ],
  [
    'checkin-scan-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'checkin-scan-route-authorization-db.integration.test.ts'),
  ],
  ['box-office-routes.test.ts', resolve(import.meta.dirname, 'box-office-routes.test.ts')],
  [
    'box-office-orders-db.integration.test.ts',
    resolve(import.meta.dirname, 'box-office-orders-db.integration.test.ts'),
  ],
  [
    'upload-artifact-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'upload-artifact-route-authorization-db.integration.test.ts'),
  ],
  [
    'payment-account-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'payment-account-route-authorization-db.integration.test.ts'),
  ],
  [
    'webhook-replay-route-authorization-db.integration.test.ts',
    resolve(import.meta.dirname, 'webhook-replay-route-authorization-db.integration.test.ts'),
  ],
]);

type AuthorizationEvidenceBinding = Readonly<{
  persistenceSource?: string;
  source: string;
}>;

function evidenceBindings(
  operationIds: readonly string[],
  binding: AuthorizationEvidenceBinding,
): Array<readonly [string, AuthorizationEvidenceBinding]> {
  return operationIds.map((operationId) => [operationId, Object.freeze({ ...binding })] as const);
}

const AUTHORIZATION_EVIDENCE_BINDINGS = new Map([
  ...evidenceBindings(
    [
      'getEventsByEventId',
      'getEventsByEventIdAttendees',
      'getEventsByEventIdAvailability',
      'getEventsByEventIdCheckInLists',
      'getEventsByEventIdLaunchReadiness',
      'getEventsByEventIdMedia',
      'getEventsByEventIdMessages',
      'getEventsByEventIdOperationalHealth',
      'getEventsByEventIdQuestions',
      'getEventsByEventIdReportsSales',
      'getEventsByEventIdWaitlist',
    ],
    { source: 'event-route-authorization-db.integration.test.ts' },
  ),
  ...evidenceBindings(['getOrganizations', 'getBrands'], {
    source: 'tenant-list-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['listMigrationAdapters'], {
    source: 'migration-credential-route-authorization.test.ts',
  }),
  ...evidenceBindings(
    [
      'getMigrationJob',
      'listMigrationJobFiles',
      'listMigrationJobRows',
      'listMigrationJobConflicts',
      'listMigrationJobEvents',
      'assessMigrationRollback',
    ],
    { source: 'migration-job-read-route-authorization-db.integration.test.ts' },
  ),
  ...evidenceBindings(['listMigrationJobs', 'listMigrationMappings'], {
    source: 'migration-job-read-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['getPortableMigrationRebindings'], {
    source: 'migration-job-read-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['createMigrationMapping'], {
    source: 'migration-mapping-route-authorization-db.integration.test.ts',
    persistenceSource: 'migration-mapping-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['createMigrationJob'], {
    source: 'migration-job-write-route-authorization-db.integration.test.ts',
    persistenceSource: 'migration-job-write-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(
    [
      'getOrganizationsByOrganizationIdReadiness',
      'getOrganizationsByOrganizationIdDashboardActions',
    ],
    { source: 'event-route-authorization-db.integration.test.ts' },
  ),
  ...evidenceBindings(
    [
      'postEventsByEventIdCheckInLists',
      'postEventsByEventIdProductCategories',
      'postEventsByEventIdQuestions',
      'postEventsByEventIdReadinessAcknowledgementsByStepId',
      'deleteEventsByEventIdReadinessAcknowledgementsByStepId',
      'putEventsByEventIdSetupSection',
    ],
    {
      source: 'event-route-authorization-db.integration.test.ts',
      persistenceSource: 'event-route-authorization-db.integration.test.ts',
    },
  ),
  ...evidenceBindings(
    ['getOrdersByOrderId', 'getOrdersByOrderIdInvoice', 'getOrdersByOrderIdInvoiceDownload'],
    { source: 'order-route-authorization-db.integration.test.ts' },
  ),
  ...evidenceBindings(['postOrdersByOrderIdCancel', 'postOrdersByOrderIdRefunds'], {
    source: 'order-route-authorization-db.integration.test.ts',
    persistenceSource: 'order-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['getProviderIncidents'], {
    source: 'provider-incident-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['postProviderIncidentsByEvidenceIdReveal'], {
    source: 'provider-incident-route-authorization-db.integration.test.ts',
    persistenceSource: 'provider-incident-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['createMigrationCredential', 'revokeMigrationCredential'], {
    source: 'migration-credential-route-authorization.test.ts',
    persistenceSource: 'import-platform.integration.test.ts',
  }),
  ...evidenceBindings(['postApiKeys', 'deleteApiKeysByKeyId'], {
    source: 'api-key-route-authorization.test.ts',
    persistenceSource: 'api-key-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['postScannerDevices', 'postScannerDevicesByDeviceIdRevoke'], {
    source: 'scanner-device-route-authorization.test.ts',
    persistenceSource: 'scanner-device-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(
    [
      'postTicketListingsByListingIdComplete',
      'postTicketsByTicketIdResaleListings',
      'postTicketListingsByListingIdDelist',
      'postTicketsByTicketIdTransfer',
    ],
    {
      source: 'resale-routes-db.integration.test.ts',
      persistenceSource: 'resale-routes-db.integration.test.ts',
    },
  ),
  ...evidenceBindings(['getTicketListingsByListingIdSettlement'], {
    source: 'resale-settlement-routes.test.ts',
  }),
  ...evidenceBindings(
    [
      'postTicketListingsByListingIdSettlementPayouts',
      'postTicketListingsByListingIdSettlementReversals',
    ],
    {
      source: 'resale-settlement-routes.test.ts',
      persistenceSource: 'resale-settlement-concurrency-db.integration.test.ts',
    },
  ),
  ...evidenceBindings(['patchAttendeesByAttendeeId'], {
    source: 'attendee-route-authorization-db.integration.test.ts',
    persistenceSource: 'attendee-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['postCheckInsScan'], {
    source: 'checkin-scan-route-authorization-db.integration.test.ts',
    persistenceSource: 'checkin-scan-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['postEventsByEventIdBoxOfficeOrders'], {
    source: 'box-office-routes.test.ts',
    persistenceSource: 'box-office-orders-db.integration.test.ts',
  }),
  ...evidenceBindings(['postUploadArtifacts', 'postUploadArtifactsByArtifactIdComplete'], {
    source: 'upload-artifact-route-authorization-db.integration.test.ts',
    persistenceSource: 'upload-artifact-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['getUploadArtifactsByArtifactIdDownload'], {
    source: 'upload-artifact-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(['postOrganizationsByOrganizationIdPaymentAccountsStripeConnect'], {
    source: 'payment-account-route-authorization-db.integration.test.ts',
    persistenceSource: 'payment-account-route-authorization-db.integration.test.ts',
  }),
  ...evidenceBindings(
    ['postWebhookEndpointsByEndpointIdEventsByEventIdReplay', 'postWebhookEventsByEventIdReplay'],
    {
      source: 'webhook-replay-route-authorization-db.integration.test.ts',
      persistenceSource: 'webhook-replay-route-authorization-db.integration.test.ts',
    },
  ),
  ...evidenceBindings(['postWebhookEndpointsByEndpointIdTest'], {
    source: 'webhook-replay-route-authorization-db.integration.test.ts',
    persistenceSource: 'webhook-replay-route-authorization-db.integration.test.ts',
  }),
]);

const knownPermissions = new Set<string>(ALL_PERMISSIONS);
const credentialOnlyOperations = new Set(['getAgentSession', 'getMe']);
const delegatedAuthorizationGuards = new Set([
  'loadAuthorizedEventForUpdate',
  'withCredentialCreationResources',
  'assertEventIds',
  'filterManageableScopedCredentialRows',
  'assertPrincipalCanAuthorizeOrganizationWideOAuth',
  'assertPrincipalCanAuthorizeResourceOwnerOAuth',
  'authorizeScope',
  'createPrivacyRequest',
  'loadCampaignProviderEventItems',
  'loadAuthorizedCampaign',
  'loadAuthorizedDocument',
  'loadAuthorizedEvent',
  'loadSettlementScope',
  'report',
  'requireAgent',
  'requireHumanApprover',
  'requireHumanSponsor',
  'requirePlanActor',
  'requireHumanAgentAdministrator',
  'requireHumanMemoryActor',
  'requireHumanMemorySponsor',
  'requireHumanUserPrincipal',
  'requireContentListPermission',
  'requireContentPermission',
  'requireEventAccess',
  'requireExportTypePermission',
  'requireHistoricalAuthorizationPrincipal',
  'requireMigrationPermission',
  'requireOrganizationScopedPermission',
  'requireOrganizationWideWebhookEndpointPrincipal',
  'requireReportEventAccess',
  'requireUploadArtifactAccess',
  'scopedEvent',
  'scopedJob',
]);
const eventScopeGuards = new Set([
  'loadAuthorizedEventForUpdate',
  'withCredentialCreationResources',
  'assertEventIds',
  'filterManageableScopedCredentialRows',
  'loadCampaignProviderEventItems',
  'loadAuthorizedCampaign',
  'loadAuthorizedEvent',
  'loadSettlementScope',
  'requireEventAccess',
  'requireOrganizationWideWebhookEndpointPrincipal',
  'requireReportEventAccess',
  'scopedEvent',
]);
const organizationWideScopeGuards = new Set([
  'requireMigrationPermission',
  'requireOrganizationWideWebhookEndpointPrincipal',
]);
const scopedJobAuthorizationOperations = new Set([
  'assessMigrationRollback',
  'getMigrationJob',
  'getPortableMigrationRebindings',
  'listMigrationJobConflicts',
  'listMigrationJobEvents',
  'listMigrationJobFiles',
  'listMigrationJobRows',
]);
const delegatedPermissionContracts = new Map<
  string,
  Readonly<{ guard: string; permissions: readonly Permission[] }>
>([
  ...[
    'getAgentPrincipalsById',
    'postAgentDelegations',
    'postAgentDelegationsByIdRevoke',
    'postAgentPrincipals',
    'postAgentPrincipalsByIdOauthClients',
    'postAgentPrincipalsByIdOauthClientsByClientIdRevoke',
    'postAgentPrincipalsByIdRevoke',
  ].map(
    (operationId) =>
      [
        operationId,
        { guard: 'requireHumanAgentAdministrator', permissions: ['developers.write'] },
      ] as const,
  ),
  [
    'postAgentActionsByActionIdApprovals',
    { guard: 'requireHumanApprover', permissions: ['events.write'] },
  ],
  [
    'postAgentEventUpdatesByActionIdApprovals',
    { guard: 'requireHumanApprover', permissions: ['events.write'] },
  ],
  ['getMigrationReport', { guard: 'report', permissions: ['migrations.read'] }],
  ['downloadMigrationReport', { guard: 'report', permissions: ['migrations.read'] }],
  [
    'grantPortableHistoricalExportAuthorization',
    { guard: 'requireHistoricalAuthorizationPrincipal', permissions: ['migrations.write'] },
  ],
  [
    'revokePortableHistoricalExportAuthorization',
    { guard: 'requireHistoricalAuthorizationPrincipal', permissions: ['migrations.write'] },
  ],
  [
    'postExports',
    {
      guard: 'requireExportTypePermission',
      permissions: ['attendees.read', 'checkins.read', 'orders.read'],
    },
  ],
]);
const enforcingPermissionCalls = new Set([
  'ClerkAuthService.requireAnyPermission',
  'ClerkAuthService.requirePermission',
  'requireAnyPermission',
  'requireContentListPermission',
  'requireContentPermission',
  'requireMigrationPermission',
  'requireOrganizationScopedPermission',
]);

function normalizePath(url: string): string {
  const withoutPrefix = url.startsWith('/v1/') ? url.slice(3) : url === '/v1' ? '/' : url;
  return withoutPrefix.replace(/:(\w+)/g, '{$1}');
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function permissionClausesFromExtension(
  value: OpenApiOperation['x-required-permissions'],
): DocumentedPermissionClause[] {
  if (Array.isArray(value)) return [{ kind: 'all-of', permissions: [...value] as Permission[] }];
  if (!value) return [];
  const compound = value as {
    allOf?: readonly Permission[];
    anyOf?: readonly Permission[];
    base?: readonly Permission[];
    byType?: Readonly<Record<string, readonly Permission[]>>;
  };
  return [
    ...(compound.allOf ? [{ kind: 'all-of' as const, permissions: [...compound.allOf] }] : []),
    ...(compound.anyOf ? [{ kind: 'any-of' as const, permissions: [...compound.anyOf] }] : []),
    ...(compound.base ? [{ kind: 'base' as const, permissions: [...compound.base] }] : []),
    ...Object.entries(compound.byType ?? {}).map(([value, permissions]) => ({
      discriminator: 'type',
      kind: 'conditional' as const,
      permissions: [...permissions],
      value,
    })),
  ];
}

type SyntaxNode = { type: string } & Record<string, unknown>;

function syntaxNode(value: unknown): SyntaxNode | undefined {
  if (!value || typeof value !== 'object' || !('type' in value)) return undefined;
  return value as SyntaxNode;
}

function identifierName(node: SyntaxNode | undefined): string | undefined {
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;
}

function staticMemberName(node: SyntaxNode): string | undefined {
  if (node.type !== 'MemberExpression') return undefined;
  const object = calleeName(node.object);
  const property = syntaxNode(node.property);
  const propertyName =
    identifierName(property) ??
    (property?.type === 'Literal' && typeof property.value === 'string'
      ? property.value
      : undefined);
  return object && propertyName ? `${object}.${propertyName}` : undefined;
}

function calleeName(expression: unknown): string | undefined {
  const node = syntaxNode(expression);
  return identifierName(node) ?? (node ? staticMemberName(node) : undefined);
}

function isEnforcingPermissionCall(name: string): boolean {
  for (const enforcingCall of enforcingPermissionCalls) {
    if (name === enforcingCall) return true;
    if (
      enforcingCall.startsWith('ClerkAuthService.') &&
      new RegExp(`^__vite_ssr_import_[0-9]+__\\.${enforcingCall.replace('.', '\\.')}$$`, 'u').test(
        name,
      )
    ) {
      return true;
    }
  }
  return false;
}

function staticallyUnreachable(node: SyntaxNode, parents: WeakMap<object, SyntaxNode>): boolean {
  let current: SyntaxNode | undefined = node;
  while (current) {
    const parent = parents.get(current);
    if (!parent) break;
    const expression = syntaxNode(parent.test);
    if (
      parent.type === 'IfStatement' &&
      expression?.type === 'Literal' &&
      expression.value === false &&
      current === parent.consequent
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function normalizedCallName(name: string): string {
  return name.replace(/^__vite_ssr_import_[0-9]+__\./u, '');
}

function analyzeHandlerSource(source: string): { callNames: string[]; permissions: Permission[] } {
  const callNames: string[] = [];
  const permissions: string[] = [];
  const parsed = parseSync('route-handler.ts', `const __routeHandler = (${source});`);
  if (parsed.errors.length > 0) throw new Error('Unable to parse captured route handler');
  const parents = new WeakMap<object, SyntaxNode>();
  let routeHandler: SyntaxNode | undefined;
  const walk = (
    value: unknown,
    visitor: (node: SyntaxNode) => boolean | void,
    parent?: SyntaxNode,
    seen = new WeakSet<object>(),
  ): void => {
    const node = syntaxNode(value);
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (parent) parents.set(node, parent);
    if (visitor(node) === false) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parent' || key === 'scope') continue;
      if (Array.isArray(child)) {
        for (const entry of child) walk(entry, visitor, node, seen);
      } else {
        walk(child, visitor, node, seen);
      }
    }
  };
  walk(parsed.program, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      identifierName(syntaxNode(node.id)) === '__routeHandler'
    ) {
      routeHandler = syntaxNode(node.init);
      while (
        routeHandler &&
        (routeHandler.type === 'ParenthesizedExpression' ||
          routeHandler.type === 'TSAsExpression' ||
          routeHandler.type === 'TSSatisfiesExpression')
      ) {
        routeHandler = syntaxNode(routeHandler.expression);
      }
      return false;
    }
    return true;
  });
  if (!routeHandler) return { callNames: [], permissions: [] };
  walk(routeHandler, (node) => {
    if (
      node !== routeHandler &&
      (node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression')
    ) {
      return false;
    }
    if (node.type === 'CallExpression' && !staticallyUnreachable(node, parents)) {
      const name = calleeName(node.callee);
      if (name) callNames.push(normalizedCallName(name));
      if (name && isEnforcingPermissionCall(name)) {
        const collect = (value: unknown): void => {
          const argument = syntaxNode(value);
          if (!argument) return;
          if (
            argument.type === 'FunctionDeclaration' ||
            argument.type === 'FunctionExpression' ||
            argument.type === 'ArrowFunctionExpression'
          ) {
            return;
          }
          if (
            argument.type === 'Literal' &&
            typeof argument.value === 'string' &&
            knownPermissions.has(argument.value)
          ) {
            permissions.push(argument.value);
          }
          for (const child of Object.values(argument)) {
            if (Array.isArray(child)) for (const entry of child) collect(entry);
            else collect(child);
          }
        };
        if (Array.isArray(node.arguments)) for (const argument of node.arguments) collect(argument);
      }
    }
    return true;
  });
  return {
    callNames: sortedUnique(callNames),
    permissions: sortedUnique(permissions) as Permission[],
  };
}

export function permissionsFromSource(source: string): Permission[] {
  return analyzeHandlerSource(source).permissions;
}

export function guardEvidenceFromSource(source: string): string[] {
  return analyzeHandlerSource(source).callNames.filter(
    (name) => name.startsWith('ClerkAuthService.require') || delegatedAuthorizationGuards.has(name),
  );
}

function effectivePermissionEvidence(
  sourcePermissions: readonly Permission[],
  guardEvidence: readonly string[],
  operationId: string | null,
): { evidence: string[]; permissions: Permission[] } {
  const evidence = sourcePermissions.map((permission) => `literal:${permission}`);
  const permissions = new Set<Permission>(sourcePermissions);
  const delegated = operationId ? delegatedPermissionContracts.get(operationId) : undefined;
  if (delegated && guardEvidence.includes(delegated.guard)) {
    for (const permission of delegated.permissions) {
      permissions.add(permission);
      evidence.push(`declared-delegated-contract:${operationId}:${delegated.guard}:${permission}`);
    }
  }
  return {
    evidence: sortedUnique(evidence),
    permissions: sortedUnique(permissions) as Permission[],
  };
}

export function assertDocumentedPermissionsAccountedFor(
  route: Pick<
    RouteAccessInventoryEntry,
    'documentedPermissions' | 'method' | 'operationId' | 'path' | 'permissions'
  >,
): void {
  const unsupported = route.documentedPermissions.filter(
    (permission) => !route.permissions.includes(permission),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `OpenAPI permission drift ${route.method} ${route.path} (${route.operationId ?? 'missing operationId'}): ${unsupported.join(', ')} lacks runtime or declared delegated evidence`,
    );
  }
}

function boundariesFor(
  access: RouteAccess,
  path: string,
  handlerSource: string,
  guardEvidence: readonly string[],
): string[] {
  const boundaries: string[] = [];
  if (access === 'authenticated') boundaries.push('tenant');
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    boundaries.push(`resource-parameter:${match[1]}`);
  }
  if (/requireOrganizationScope|organizationIds|organization_id/.test(handlerSource)) {
    boundaries.push('organization');
  }
  if (/requireBrandScope|brandIds|brand_id/.test(handlerSource)) boundaries.push('brand');
  if (/requireEventScope|eventIds|event_id/.test(handlerSource)) boundaries.push('event');
  if (/requireResourceTenant|tenantId|tenant_id/.test(handlerSource)) boundaries.push('tenant');
  if (guardEvidence.some((guard) => eventScopeGuards.has(guard))) {
    boundaries.push('tenant', 'organization', 'brand', 'event');
  }
  if (guardEvidence.some((guard) => organizationWideScopeGuards.has(guard))) {
    boundaries.push('brand', 'event');
  }
  if (guardEvidence.includes('scopedJob')) boundaries.push('organization');
  if (guardEvidence.includes('ClerkAuthService.requireNoEventScope')) boundaries.push('event');
  if (guardEvidence.includes('requireHumanUserPrincipal')) boundaries.push('principal-type');
  if (guardEvidence.includes('requireUploadArtifactAccess')) {
    boundaries.push('organization', 'brand', 'event', 'owner', 'principal-type');
  }
  return sortedUnique(boundaries);
}

function pathParameters(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}

function contractError(contract: RouteAuthorizationDenialContract, message: string): Error {
  return new Error(
    `Invalid negative authorization contract ${contract.method} ${contract.path}: ${message}`,
  );
}

export function negativeAuthorizationEvidenceForRoutes(
  routes: readonly Pick<
    RouteAccessInventoryEntry,
    'access' | 'boundaries' | 'guardEvidence' | 'method' | 'operationId' | 'path'
  >[],
  contracts: readonly RouteAuthorizationDenialContract[] = ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
): Map<string, NegativeAuthorizationEvidence[]> {
  const routesByKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
  const evidenceByRoute = new Map<string, NegativeAuthorizationEvidence[]>();
  const routeBoundaryPairs = new Set<string>();

  for (const contract of contracts) {
    const routeKey = `${contract.method} ${contract.path}`;
    const route = routesByKey.get(routeKey);
    if (!route) throw contractError(contract, 'runtime route is missing');
    if (route.access !== 'authenticated') {
      throw contractError(contract, `runtime route is ${route.access}, not authenticated`);
    }
    if (route.operationId !== contract.operationId) {
      throw contractError(
        contract,
        `operationId is ${route.operationId ?? 'missing'}, expected ${contract.operationId}`,
      );
    }
    const actualParameters = pathParameters(contract.path).sort();
    const declaredParameters = [...contract.resourceParameters].sort();
    if (contract.deniedBoundaries.includes('permission')) {
      throw contractError(contract, 'permission denial must use permissionDenialResponse');
    }
    if (JSON.stringify(actualParameters) !== JSON.stringify(declaredParameters)) {
      throw contractError(
        contract,
        `resourceParameters ${JSON.stringify(declaredParameters)} do not match path parameters ${JSON.stringify(actualParameters)}`,
      );
    }
    for (const parameter of declaredParameters) {
      if (!route.boundaries.includes(`resource-parameter:${parameter}`)) {
        throw contractError(contract, `inventory omits resource parameter ${parameter}`);
      }
    }
    if (
      scopedJobAuthorizationOperations.has(contract.operationId) &&
      contract.deniedBoundaries.includes('organization') &&
      !route.guardEvidence.includes('scopedJob')
    ) {
      throw contractError(contract, 'organization boundary is not enforced by scopedJob');
    }
    if (contract.denialResponse.status !== 404 || contract.denialResponse.code !== 'NOT_FOUND') {
      throw contractError(contract, 'denial must be indistinguishable 404 NOT_FOUND');
    }
    if (contract.authorizedControl.required !== true) {
      throw contractError(contract, 'authorized control is not required');
    }
    if (contract.method === 'DELETE' && contract.authorizedControl.status !== 204) {
      throw contractError(contract, 'DELETE authorized control must be 204');
    }
    const evidenceBinding = AUTHORIZATION_EVIDENCE_BINDINGS.get(contract.operationId);
    if (!evidenceBinding || evidenceBinding.source !== contract.source)
      throw contractError(contract, 'source is not bound to this operationId');
    const sourcePath = EXECUTABLE_AUTHORIZATION_EVIDENCE_SOURCES.get(contract.source);
    if (!sourcePath || !existsSync(sourcePath))
      throw contractError(contract, 'source must name a registered existing executable test file');
    if (
      contract.permissionDenialResponse &&
      (contract.permissionDenialResponse.status !== 403 ||
        contract.permissionDenialResponse.code !== 'FORBIDDEN')
    ) {
      throw contractError(contract, 'permission denial must be 403 FORBIDDEN');
    }
    const policyDeniedBoundaries = contract.policyDeniedBoundaries ?? [];
    if (policyDeniedBoundaries.length > 0 && !contract.policyDenialResponse) {
      throw contractError(contract, 'policy denials require an explicit response');
    }
    if (policyDeniedBoundaries.length > 0 && !contract.policyCondition) {
      throw contractError(contract, 'policy denials require an explicit condition');
    }
    if (
      contract.policyDenialResponse &&
      (contract.policyDenialResponse.status !== 403 ||
        contract.policyDenialResponse.code !== 'FORBIDDEN')
    ) {
      throw contractError(contract, 'policy denial must be 403 FORBIDDEN');
    }
    if (contract.policyDenialResponse && policyDeniedBoundaries.length === 0) {
      throw contractError(contract, 'policy denial response has no boundary');
    }
    if (contract.policyCondition && policyDeniedBoundaries.length === 0) {
      throw contractError(contract, 'policy condition has no boundary');
    }
    if (contract.policyCondition?.discriminator === 'purpose') {
      if (contract.policyCondition.value !== 'user_avatar') {
        throw contractError(contract, 'unsupported policy condition');
      }
      const operation = (
        openApiSpec.paths as unknown as Record<string, Record<string, OpenApiOperation>>
      )[contract.path]?.[contract.method.toLowerCase()];
      const permittedPrincipalTypes =
        operation?.['x-principal-type-restrictions']?.byUploadPurpose?.[
          contract.policyCondition.value
        ];
      if (JSON.stringify(permittedPrincipalTypes) !== JSON.stringify(['user'])) {
        throw contractError(
          contract,
          'policy condition drifts from OpenAPI principal restrictions',
        );
      }
    } else if (contract.policyCondition?.discriminator === 'principal-scope') {
      if (contract.policyCondition.value === 'organization-wide') {
        if (
          !route.guardEvidence.some((guard) => organizationWideScopeGuards.has(guard)) ||
          !route.boundaries.includes('brand') ||
          !route.boundaries.includes('event')
        ) {
          throw contractError(
            contract,
            'organization-wide scope policy is not enforced by runtime',
          );
        }
      } else if (contract.policyCondition.value === 'no-event-scope') {
        if (
          !route.guardEvidence.includes('ClerkAuthService.requireNoEventScope') ||
          !route.boundaries.includes('event')
        ) {
          throw contractError(contract, 'no-event-scope policy is not enforced by runtime');
        }
      } else {
        throw contractError(contract, 'unsupported policy condition');
      }
    } else if (contract.policyCondition) {
      throw contractError(contract, 'unsupported policy condition');
    }
    for (const boundary of policyDeniedBoundaries) {
      if (!route.boundaries.includes(boundary)) {
        throw contractError(contract, `inventory omits policy boundary ${boundary}`);
      }
    }
    if (
      contract.method !== 'GET' &&
      (contract.sideEffectAssertions.length === 0 ||
        contract.sideEffectAssertions.some((kind) => kind !== 'persistence' && kind !== 'workflow'))
    ) {
      throw contractError(contract, 'mutation omits persistence or workflow side-effect proof');
    }
    const requiresPersistence = contract.sideEffectAssertions.includes('persistence');
    if (evidenceBinding.persistenceSource !== contract.persistenceSource)
      throw contractError(contract, 'persistence source is not bound to this operationId');
    const persistenceSourcePath = contract.persistenceSource
      ? EXECUTABLE_AUTHORIZATION_EVIDENCE_SOURCES.get(contract.persistenceSource)
      : undefined;
    if (requiresPersistence && (!persistenceSourcePath || !existsSync(persistenceSourcePath))) {
      throw contractError(
        contract,
        'persistence assertion must name a registered existing executable database test file',
      );
    }
    if (!requiresPersistence && contract.persistenceSource !== undefined)
      throw contractError(
        contract,
        'non-persistence contract must not declare persistence evidence',
      );

    const evidence = evidenceByRoute.get(routeKey) ?? [];
    for (const boundary of contract.deniedBoundaries) {
      const pair = `${routeKey} ${boundary}`;
      if (routeBoundaryPairs.has(pair)) {
        throw contractError(contract, `duplicate route/boundary pair ${boundary}`);
      }
      if (!route.boundaries.includes(boundary)) {
        throw contractError(contract, `inventory omits denied boundary ${boundary}`);
      }
      routeBoundaryPairs.add(pair);
      evidence.push({
        authorizedControlStatus: contract.authorizedControl.status,
        boundary,
        condition: null,
        denialKind: 'resource-boundary',
        deniedCode: contract.denialResponse.code,
        deniedStatus: contract.denialResponse.status,
        persistenceSource: contract.persistenceSource ?? null,
        sideEffectAssertions: [...contract.sideEffectAssertions],
        source: contract.source,
      });
    }
    if (contract.permissionDenialResponse) {
      const pair = `${routeKey} permission`;
      if (routeBoundaryPairs.has(pair)) {
        throw contractError(contract, 'duplicate route/boundary pair permission');
      }
      routeBoundaryPairs.add(pair);
      evidence.push({
        authorizedControlStatus: contract.authorizedControl.status,
        boundary: 'permission',
        condition: null,
        denialKind: 'permission',
        deniedCode: contract.permissionDenialResponse.code,
        deniedStatus: contract.permissionDenialResponse.status,
        persistenceSource: contract.persistenceSource ?? null,
        sideEffectAssertions: [...contract.sideEffectAssertions],
        source: contract.source,
      });
    }
    for (const boundary of policyDeniedBoundaries) {
      const pair = `${routeKey} ${boundary} ${contract.policyCondition!.discriminator}=${contract.policyCondition!.value}`;
      if (routeBoundaryPairs.has(pair)) {
        throw contractError(contract, `duplicate route/boundary pair ${boundary}`);
      }
      routeBoundaryPairs.add(pair);
      evidence.push({
        authorizedControlStatus: contract.authorizedControl.status,
        boundary,
        condition: { ...contract.policyCondition! },
        denialKind: 'policy',
        deniedCode: contract.policyDenialResponse!.code,
        deniedStatus: contract.policyDenialResponse!.status,
        persistenceSource: contract.persistenceSource ?? null,
        sideEffectAssertions: [...contract.sideEffectAssertions],
        source: contract.source,
      });
    }
    evidenceByRoute.set(routeKey, evidence);
  }

  return evidenceByRoute;
}

export async function buildRouteAccessInventory(): Promise<RouteAccessInventory> {
  const manifest = await buildRouteManifest();
  const routes: RouteAccessInventoryEntry[] = [];

  for (const route of manifest) {
    if (route.method === 'HEAD') continue;
    const path = normalizePath(route.url);
    const operation = (
      openApiSpec.paths as unknown as Record<string, Record<string, OpenApiOperation>>
    )[path]?.[route.method.toLowerCase()];
    const operationId = operation?.operationId ?? null;
    const documentedPermissionClauses = permissionClausesFromExtension(
      operation?.['x-required-permissions'],
    );
    const documentedPermissions = sortedUnique(
      documentedPermissionClauses.flatMap((clause) => clause.permissions),
    ) as Permission[];
    const sourcePermissions = permissionsFromSource(route.handlerSource);
    const guardEvidence = guardEvidenceFromSource(route.handlerSource);
    const effectivePermission = effectivePermissionEvidence(
      sourcePermissions,
      guardEvidence,
      operationId,
    );
    const permissions = effectivePermission.permissions;
    const delegatedContract = operationId
      ? delegatedPermissionContracts.get(operationId)
      : undefined;
    const hasDelegatedContract = Boolean(
      delegatedContract && guardEvidence.includes(delegatedContract.guard),
    );
    const permissionPolicy =
      route.access !== 'authenticated'
        ? 'not-applicable'
        : operationId !== null && credentialOnlyOperations.has(operationId)
          ? 'credential-only'
          : sourcePermissions.length > 0
            ? 'explicit'
            : 'delegated';
    const permissionDocumentationStatus =
      route.access !== 'authenticated'
        ? 'not-applicable'
        : permissionPolicy === 'credential-only'
          ? 'credential-only'
          : documentedPermissions.length > 0
            ? hasDelegatedContract
              ? 'delegated-contract'
              : sourcePermissions.some((permission) => !documentedPermissions.includes(permission))
                ? 'conditional-unverified'
                : 'verified'
            : permissionPolicy === 'delegated'
              ? 'delegated-undocumented'
              : 'runtime-undocumented';

    routes.push({
      access: route.access,
      boundaries: boundariesFor(route.access, path, route.handlerSource, guardEvidence),
      credentialSchemes: sortedUnique(
        route.access === 'operational' && path === '/metrics'
          ? ['MetricsBearer']
          : (operation?.security ?? []).flatMap((requirement) => Object.keys(requirement)),
      ),
      documentedPermissions,
      documentedPermissionClauses,
      guardEvidence,
      method: route.method,
      negativeAuthorizationEvidence: [],
      operationId,
      path,
      permissionEvidence: effectivePermission.evidence,
      permissionDocumentationStatus,
      permissions,
      permissionPolicy,
    });
  }

  routes.sort(
    (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  );
  const evidenceByRoute = negativeAuthorizationEvidenceForRoutes(routes);
  for (const route of routes) {
    assertDocumentedPermissionsAccountedFor(route);
    route.negativeAuthorizationEvidence =
      evidenceByRoute.get(`${route.method} ${route.path}`) ?? [];
  }
  return { schemaVersion: 4, routes };
}
