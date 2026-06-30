import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  ApiKeyRepository,
  ScannerDeviceRepository,
  AuditLogRepository,
  BrandRepository,
  EventRepository,
} from '@tixkit/db';
import { ForbiddenError, NotFoundError } from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import {
  pageEnvelope,
  parsePagination,
  requireAssignableScopes,
  serializeApiKey,
  serializeScannerDevice,
} from '../../http/contracts.js';
import {
  createApiKeySchema,
  createScannerDeviceSchema,
  parseBody,
  createOAuthAppSchema,
} from '../../http/schemas.js';

const SENSITIVE_API_KEY_FIELDS = ['hashed_key'] as const;
const SENSITIVE_DEVICE_FIELDS = ['hashed_secret'] as const;
const DEFAULT_SCANNER_DEVICE_SCOPES = ['checkins.read', 'checkins.write'] as const;
type Principal = NonNullable<FastifyRequest['principal']>;
type ScopedCredentialRow = {
  brand_ids?: unknown;
  event_ids?: unknown;
};

function sanitize<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[],
): Partial<T> {
  const copy: Record<string, unknown> = { ...record };
  for (const field of fields) delete copy[field];
  return copy as Partial<T>;
}

function requireAssignableResourceScope(
  principal: Principal,
  input: { brandIds?: string[]; eventIds?: string[] },
) {
  const principalHasBrandScope = Boolean(principal.brandIds?.length);
  const principalHasEventScope = Boolean(principal.eventIds?.length);
  const requestedBrandScope = Boolean(input.brandIds?.length);
  const requestedEventScope = Boolean(input.eventIds?.length);

  if (principalHasEventScope) {
    if (requestedBrandScope) {
      throw new ForbiddenError('Event-scoped principals cannot grant brand-scoped access');
    }
    if (!requestedEventScope) {
      throw new ForbiddenError('Event-scoped principals must create event-scoped credentials');
    }
  } else if (principalHasBrandScope && !requestedBrandScope && !requestedEventScope) {
    throw new ForbiddenError(
      'Brand-scoped principals must create brand- or event-scoped credentials',
    );
  }
}

function requireAssignableScannerScope(principal: Principal, eventIds?: string[]) {
  if (
    (principal.brandIds?.length || principal.eventIds?.length) &&
    (!eventIds || eventIds.length === 0)
  ) {
    throw new ForbiddenError('Scoped principals must bind scanner devices to explicit events');
  }
}

function requireOrganizationWideOAuthApplicationPrincipal(principal: Principal) {
  if (principal.brandIds?.length || principal.eventIds?.length) {
    throw new ForbiddenError(
      'Scoped principals cannot manage organization-wide OAuth applications',
    );
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function hasScopedResourceBounds(principal: Principal) {
  return (
    principal.type !== 'system' && Boolean(principal.eventIds?.length || principal.brandIds?.length)
  );
}

function isContained(values: string[], allowedValues: readonly string[]) {
  const allowed = new Set<string>(allowedValues);
  return values.length > 0 && values.every((value) => allowed.has(value));
}

export const developerRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  async function loadEventBrandIds(principal: Principal, eventIds: string[]) {
    const uniqueEventIds = [...new Set(eventIds)];
    if (uniqueEventIds.length === 0) return new Map<string, string>();
    const organizationIds = new Set<string>(principal.organizationIds);

    const events = await db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id'])
      .where('id', 'in', uniqueEventIds)
      .execute();

    const eventBrandIds = new Map<string, string>();
    for (const event of events) {
      if (
        event.tenant_id === principal.tenantId &&
        (principal.type === 'system' || organizationIds.has(String(event.organization_id))) &&
        typeof event.id === 'string' &&
        typeof event.brand_id === 'string'
      ) {
        eventBrandIds.set(event.id, event.brand_id);
      }
    }
    return eventBrandIds;
  }

  function canManageScopedCredentialRow(
    principal: Principal,
    row: ScopedCredentialRow,
    eventBrandIds: Map<string, string>,
  ) {
    const eventIds = parseStringArray(row.event_ids);

    if (principal.eventIds?.length) {
      return (
        parseStringArray(row.brand_ids).length === 0 && isContained(eventIds, principal.eventIds)
      );
    }

    if (!principal.brandIds?.length) {
      return true;
    }

    const brandIds = parseStringArray(row.brand_ids);
    if (brandIds.length === 0 && eventIds.length === 0) {
      return false;
    }
    if (brandIds.length > 0 && !isContained(brandIds, principal.brandIds)) {
      return false;
    }
    if (eventIds.length > 0) {
      const principalBrandIds = new Set<string>(principal.brandIds);
      return eventIds.every((eventId) => {
        const brandId = eventBrandIds.get(eventId);
        return Boolean(brandId && principalBrandIds.has(brandId));
      });
    }
    return true;
  }

  async function filterManageableScopedCredentialRows<T extends ScopedCredentialRow>(
    principal: Principal,
    rows: T[],
  ) {
    if (!hasScopedResourceBounds(principal)) {
      return rows;
    }
    const eventBrandIds = principal.eventIds?.length
      ? new Map<string, string>()
      : await loadEventBrandIds(
          principal,
          rows.flatMap((row) => parseStringArray(row.event_ids)),
        );
    return rows.filter((row) => canManageScopedCredentialRow(principal, row, eventBrandIds));
  }

  async function assertBrandIds(principal: Principal, brandIds?: string[]) {
    if (!brandIds) return;
    const repo = new BrandRepository(db);
    await Promise.all(
      brandIds.map(async (brandId) => {
        const brand = await repo.findById(brandId);
        if (!brand) throw new NotFoundError('Brand', brandId);
        ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
        ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
        ClerkAuthService.requireBrandScope(principal, brandId);
      }),
    );
  }

  async function assertEventIds(principal: Principal, eventIds?: string[]) {
    if (!eventIds) return;
    const repo = new EventRepository(db);
    await Promise.all(
      eventIds.map(async (eventId) => {
        const event = await repo.findById(eventId);
        if (!event) throw new NotFoundError('Event', eventId);
        ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
        ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
        ClerkAuthService.requireBrandScope(principal, event.brand_id);
        ClerkAuthService.requireEventScope(principal, eventId);
      }),
    );
  }

  app.post('/api-keys', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const body = parseBody(createApiKeySchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    requireAssignableScopes(principal, body.scopes as never);
    requireAssignableResourceScope(principal, {
      brandIds: body.brandIds,
      eventIds: body.eventIds,
    });
    await assertBrandIds(principal, body.brandIds);
    await assertEventIds(principal, body.eventIds);

    const repo = new ApiKeyRepository(db);
    const { apiKey, record } = await repo.create({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      name: body.name,
      scopes: body.scopes,
      brandIds: body.brandIds,
      eventIds: body.eventIds,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });

    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'api_key.created',
      organizationId: body.organizationId,
      resourceType: 'ApiKey',
      resourceId: record.id as string,
      diffSummary: { name: body.name, scopes: body.scopes },
    });

    // The raw `apiKey` is returned exactly once at creation. The persisted
    // record never exposes the hashed key material.
    return reply
      .status(201)
      .send({ ...serializeApiKey(sanitize(record, SENSITIVE_API_KEY_FIELDS)), apiKey });
  });

  app.get('/api-keys', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const pagination = parsePagination(request.query);
    let query = db
      .selectFrom('api_keys')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'name',
        'key_prefix',
        'scopes',
        'brand_ids',
        'event_ids',
        'last_used_at',
        'expires_at',
        'revoked_at',
        'created_at',
        'updated_at',
      ])
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc');
    // Filter by principal's organizations to prevent cross-org data exposure
    // within the same tenant. System principals bypass this filter.
    // Fail closed: a non-system principal with no org memberships sees nothing.
    if (principal.type !== 'system') {
      if (principal.organizationIds.length === 0) {
        return pageEnvelope([], pagination.limit);
      }
      query = query.where('organization_id', 'in', principal.organizationIds);
    }
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (!hasScopedResourceBounds(principal)) query = query.limit(pagination.limit + 1);
    const keys = await query.execute();
    const authorizedKeys = await filterManageableScopedCredentialRows(principal, keys);

    return pageEnvelope(
      authorizedKeys.map((row) => serializeApiKey(row)),
      pagination.limit,
    );
  });

  app.delete('/api-keys/:keyId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { keyId } = request.params as { keyId: string };
    const repo = new ApiKeyRepository(db);
    const key = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('id', '=', keyId)
      .executeTakeFirst();
    if (!key) throw new NotFoundError('ApiKey', keyId);
    ClerkAuthService.requireResourceTenant(principal, key, 'ApiKey', keyId);
    ClerkAuthService.requireOrganizationScope(principal, key.organization_id);
    const [authorizedKey] = await filterManageableScopedCredentialRows(principal, [key]);
    if (!authorizedKey) throw new NotFoundError('ApiKey', keyId);
    await repo.revoke(keyId);
    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'api_key.revoked',
      organizationId: key.organization_id,
      resourceType: 'ApiKey',
      resourceId: keyId,
    });
    return reply.status(204).send();
  });

  app.post('/scanner-devices', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const body = parseBody(createScannerDeviceSchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    requireAssignableScannerScope(principal, body.eventIds);
    await assertEventIds(principal, body.eventIds);
    const scopes = [...(body.scopes ?? DEFAULT_SCANNER_DEVICE_SCOPES)];
    requireAssignableScopes(principal, scopes);

    const repo = new ScannerDeviceRepository(db);
    const { secret, record } = await repo.create({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      name: body.name,
      eventIds: body.eventIds ?? [],
      scopes,
    });

    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'scanner_device.created',
      organizationId: body.organizationId,
      resourceType: 'ScannerDevice',
      resourceId: record.id as string,
      diffSummary: { name: body.name, eventIds: body.eventIds, scopes },
    });

    // The raw device `secret` is returned exactly once. The persisted record
    // only stores the hash.
    return reply.status(201).send({
      ...serializeScannerDevice(sanitize(record, SENSITIVE_DEVICE_FIELDS)),
      deviceId: record.device_id,
      secret,
    });
  });

  app.get('/scanner-devices', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const pagination = parsePagination(request.query);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }
    let query = db
      .selectFrom('scanner_devices')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'name',
        'device_id',
        'event_ids',
        'scopes',
        'status',
        'last_seen_at',
        'created_at',
        'updated_at',
      ])
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc');
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (principal.type !== 'system') {
      query = query.where('organization_id', 'in', principal.organizationIds);
    }
    if (!hasScopedResourceBounds(principal)) query = query.limit(pagination.limit + 1);
    const rows = await query.execute();
    const authorizedRows = await filterManageableScopedCredentialRows(principal, rows);
    return pageEnvelope(
      authorizedRows.map((row) => serializeScannerDevice(row)),
      pagination.limit,
    );
  });

  app.post('/scanner-devices/:deviceId/revoke', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { deviceId } = request.params as { deviceId: string };
    const repo = new ScannerDeviceRepository(db);
    const device = await db
      .selectFrom('scanner_devices')
      .selectAll()
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    if (!device) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Scanner device not found', requestId: request.id },
      });
    }
    ClerkAuthService.requireResourceTenant(principal, device, 'ScannerDevice', deviceId);
    ClerkAuthService.requireOrganizationScope(principal, device.organization_id);
    const [authorizedDevice] = await filterManageableScopedCredentialRows(principal, [device]);
    if (!authorizedDevice) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Scanner device not found', requestId: request.id },
      });
    }
    await repo.revoke(device.id);
    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'scanner_device.revoked',
      organizationId: device.organization_id,
      resourceType: 'ScannerDevice',
      resourceId: device.id,
    });
    return reply.status(200).send({ deviceId, status: 'revoked' });
  });

  // OAuth Applications
  app.post('/oauth-applications', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideOAuthApplicationPrincipal(principal);
    const body = parseBody(createOAuthAppSchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    requireAssignableScopes(principal, body.scopes as never);

    const { ulid } = await import('ulid');
    const { createHash } = await import('crypto');
    const clientId = `tk_oauth_${ulid()}`;
    const clientSecret = `tk_secret_${ulid()}`;
    const clientSecretHash = createHash('sha256').update(clientSecret).digest('hex');
    const id = `oapp_${ulid()}`;
    const now = new Date();

    await db
      .insertInto('oauth_applications')
      .values({
        id,
        tenant_id: principal.tenantId,
        organization_id: body.organizationId,
        name: body.name,
        client_id: clientId,
        client_secret_hash: clientSecretHash,
        redirect_uris: JSON.stringify(body.redirectUris),
        scopes: JSON.stringify(body.scopes),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'oauth_app.created',
      organizationId: body.organizationId,
      resourceType: 'OAuthApplication',
      resourceId: id,
      diffSummary: { name: body.name, clientId },
    });

    return reply.status(201).send({
      id,
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      name: body.name,
      clientId,
      clientSecret,
      redirectUris: body.redirectUris,
      scopes: body.scopes,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });

  app.get('/oauth-applications', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideOAuthApplicationPrincipal(principal);
    const pagination = parsePagination(request.query);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }
    let query = db
      .selectFrom('oauth_applications')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'name',
        'client_id',
        'redirect_uris',
        'scopes',
        'status',
        'created_at',
        'updated_at',
      ])
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (principal.type !== 'system') {
      query = query.where('organization_id', 'in', principal.organizationIds);
    }
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        name: row.name,
        clientId: row.client_id,
        redirectUris: JSON.parse(row.redirect_uris as string),
        scopes: JSON.parse(row.scopes as string),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      pagination.limit,
    );
  });

  app.delete('/oauth-applications/:appId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideOAuthApplicationPrincipal(principal);
    const { appId } = request.params as { appId: string };
    const oauthApp = await db
      .selectFrom('oauth_applications')
      .selectAll()
      .where('id', '=', appId)
      .executeTakeFirst();
    if (!oauthApp) throw new NotFoundError('OAuthApplication', appId);
    ClerkAuthService.requireResourceTenant(principal, oauthApp, 'OAuthApplication', appId);
    ClerkAuthService.requireOrganizationScope(principal, oauthApp.organization_id);

    await db
      .updateTable('oauth_applications')
      .set({ status: 'revoked', updated_at: new Date() })
      .where('id', '=', appId)
      .execute();
    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'oauth_app.revoked',
      organizationId: oauthApp.organization_id,
      resourceType: 'OAuthApplication',
      resourceId: appId,
    });
    return reply.status(204).send();
  });
};
