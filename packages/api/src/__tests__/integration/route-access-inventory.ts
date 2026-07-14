import { ALL_PERMISSIONS, type Permission } from '@tixkit/domain';
import { openApiSpec } from '@tixkit/openapi';
import { buildRouteManifest, type RouteAccess } from './route-manifest.js';

type OpenApiOperation = {
  operationId?: string;
  security?: readonly Record<string, readonly string[]>[];
  'x-required-permissions'?:
    | readonly Permission[]
    | { allOf?: readonly Permission[]; anyOf?: readonly Permission[] };
};

export type RouteAccessInventoryEntry = {
  access: RouteAccess;
  boundaries: string[];
  credentialSchemes: string[];
  documentedPermissions: Permission[];
  guardEvidence: string[];
  method: string;
  operationId: string | null;
  path: string;
  permissions: Permission[];
  permissionPolicy: 'explicit' | 'delegated' | 'credential-only' | 'not-applicable';
};

export type RouteAccessInventory = {
  schemaVersion: 1;
  routes: RouteAccessInventoryEntry[];
};

const knownPermissions = new Set<string>(ALL_PERMISSIONS);
const credentialOnlyOperations = new Set(['getMe']);
const delegatedAuthorizationGuards = new Set([
  'assertPrincipalCanAuthorizeOrganizationWideOAuth',
  'assertPrincipalCanAuthorizeResourceOwnerOAuth',
  'authorizeScope',
  'createPrivacyRequest',
  'loadCampaignProviderEventItems',
  'loadAuthorizedCampaign',
  'loadAuthorizedDocument',
  'loadAuthorizedEvent',
  'report',
  'requireHumanAgentAdministrator',
  'requireContentListPermission',
  'requireContentPermission',
  'requireEventAccess',
  'requireHistoricalAuthorizationPrincipal',
  'requireMigrationPermission',
  'requireOrganizationScopedPermission',
  'requireReportEventAccess',
  'requireUploadArtifactAccess',
  'scopedEvent',
  'scopedJob',
]);
const eventScopeGuards = new Set([
  'loadCampaignProviderEventItems',
  'loadAuthorizedCampaign',
  'loadAuthorizedEvent',
  'requireEventAccess',
  'requireReportEventAccess',
  'scopedEvent',
]);
const callPattern = /\b((?:ClerkAuthService\.)?[A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

function normalizePath(url: string): string {
  const withoutPrefix = url.startsWith('/v1/') ? url.slice(3) : url === '/v1' ? '/' : url;
  return withoutPrefix.replace(/:(\w+)/g, '{$1}');
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function permissionsFromExtension(value: OpenApiOperation['x-required-permissions']): Permission[] {
  if (Array.isArray(value)) return [...value] as Permission[];
  if (!value) return [];
  const compound = value as {
    allOf?: readonly Permission[];
    anyOf?: readonly Permission[];
  };
  return [...(compound.allOf ?? []), ...(compound.anyOf ?? [])];
}

function permissionsFromSource(source: string): Permission[] {
  const literals = [...source.matchAll(/['"]([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)['"]/g)].map(
    (match) => match[1],
  );
  return sortedUnique(literals.filter((value) => knownPermissions.has(value))) as Permission[];
}

function guardEvidenceFromSource(source: string): string[] {
  return sortedUnique(
    [...source.matchAll(callPattern)]
      .map((match) => match[1])
      .filter(
        (name) =>
          name.startsWith('ClerkAuthService.require') || delegatedAuthorizationGuards.has(name),
      ),
  );
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
  return sortedUnique(boundaries);
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
    const documentedPermissions = permissionsFromExtension(operation?.['x-required-permissions']);
    const sourcePermissions = permissionsFromSource(route.handlerSource);
    const permissions = sortedUnique(sourcePermissions) as Permission[];
    const guardEvidence = guardEvidenceFromSource(route.handlerSource);
    const permissionPolicy =
      route.access !== 'authenticated'
        ? 'not-applicable'
        : operationId !== null && credentialOnlyOperations.has(operationId)
          ? 'credential-only'
          : permissions.length > 0
            ? 'explicit'
            : 'delegated';

    routes.push({
      access: route.access,
      boundaries: boundariesFor(route.access, path, route.handlerSource, guardEvidence),
      credentialSchemes: sortedUnique(
        route.access === 'operational' && path === '/metrics'
          ? ['MetricsBearer']
          : (operation?.security ?? []).flatMap((requirement) => Object.keys(requirement)),
      ),
      documentedPermissions,
      guardEvidence,
      method: route.method,
      operationId,
      path,
      permissions,
      permissionPolicy,
    });
  }

  routes.sort(
    (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  );
  return { schemaVersion: 1, routes };
}
