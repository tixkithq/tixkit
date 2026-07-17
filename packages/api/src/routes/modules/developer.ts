import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  ApiKeyRepository,
  ScannerDeviceRepository,
  AuditLogRepository,
  type Database,
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
const SCOPED_CREDENTIAL_SCAN_BATCH_MULTIPLIER = 10;
const SCOPED_CREDENTIAL_SCAN_MAX_ROWS = 500;
type Principal = NonNullable<FastifyRequest['principal']>;
type ScopedCredentialRow = {
  id: string;
  brand_ids?: unknown;
  event_ids?: unknown;
};
type CredentialListQuery<T extends ScopedCredentialRow> = {
  limit(limit: number): CredentialListQuery<T>;
  execute(): Promise<T[]>;
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

  async function listManageableScopedCredentialPage<T extends ScopedCredentialRow>(
    principal: Principal,
    pagination: { cursor?: string; limit: number },
    buildQuery: (cursor?: string) => CredentialListQuery<T>,
  ) {
    if (!hasScopedResourceBounds(principal)) {
      return buildQuery(pagination.cursor)
        .limit(pagination.limit + 1)
        .execute();
    }

    const batchSize = pagination.limit + 1;
    const maxRowsToScan = Math.max(
      batchSize,
      Math.min(
        SCOPED_CREDENTIAL_SCAN_MAX_ROWS,
        batchSize * SCOPED_CREDENTIAL_SCAN_BATCH_MULTIPLIER,
      ),
    );
    const authorizedRows: T[] = [];
    let scannedRows = 0;
    let cursor = pagination.cursor;

    while (authorizedRows.length <= pagination.limit && scannedRows < maxRowsToScan) {
      const currentLimit = Math.min(batchSize, maxRowsToScan - scannedRows);
      const rows = await buildQuery(cursor).limit(currentLimit).execute();
      if (rows.length === 0) break;

      scannedRows += rows.length;
      authorizedRows.push(...(await filterManageableScopedCredentialRows(principal, rows)));

      if (rows.length < currentLimit) break;
      const nextCursor = rows.at(-1)?.id;
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return authorizedRows;
  }

  async function assertBrandIds(
    principal: Principal,
    organizationId: string,
    brandIds: string[] | undefined,
    database: Database = db,
  ) {
    if (!brandIds) return;
    const requestedIds = [...new Set(brandIds)].sort();
    const rows = await database
      .selectFrom('brands')
      .selectAll()
      .where('id', 'in', requestedIds)
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const brandId of requestedIds) {
      const brand = byId.get(brandId);
      if (!brand) throw new NotFoundError('Brand', brandId);
      ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
      if (brand.organization_id !== organizationId) throw new NotFoundError('Brand', brandId);
      ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
      ClerkAuthService.requireBrandScope(principal, brandId);
    }
  }

  async function assertEventIds(
    principal: Principal,
    organizationId: string,
    eventIds: string[] | undefined,
    database: Database = db,
  ) {
    if (!eventIds) return;
    const requestedIds = [...new Set(eventIds)].sort();
    const rows = await database
      .selectFrom('events')
      .selectAll()
      .where('id', 'in', requestedIds)
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const eventId of requestedIds) {
      const event = byId.get(eventId);
      if (!event) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
      if (event.organization_id !== organizationId) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
      ClerkAuthService.requireBrandScope(principal, event.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
    }
  }

  async function assertCredentialOrganization(
    principal: Principal,
    organizationId: string,
    database: Database,
  ) {
    const organization = await database
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!organization) throw new NotFoundError('Organization', organizationId);
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);
  }

  async function withCredentialCreationResources<T>(
    principal: Principal,
    input: { brandIds?: string[]; eventIds?: string[]; organizationId: string },
    operation: (transaction: Database) => Promise<T>,
  ): Promise<T> {
    return db.transaction().execute(async (transaction) => {
      await assertCredentialOrganization(principal, input.organizationId, transaction);
      await assertBrandIds(principal, input.organizationId, input.brandIds, transaction);
      await assertEventIds(principal, input.organizationId, input.eventIds, transaction);
      return operation(transaction);
    });
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
    const { apiKey, record } = await withCredentialCreationResources(
      principal,
      {
        organizationId: body.organizationId,
        brandIds: body.brandIds,
        eventIds: body.eventIds,
      },
      async (transaction) => {
        const created = await new ApiKeyRepository(transaction).create({
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          name: body.name,
          scopes: body.scopes,
          brandIds: body.brandIds,
          eventIds: body.eventIds,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        });
        await writeAuditLog(
          new AuditLogRepository(transaction),
          request,
          principal,
          {
            action: 'api_key.created',
            organizationId: body.organizationId,
            resourceType: 'ApiKey',
            resourceId: created.record.id as string,
            diffSummary: { name: body.name, scopes: body.scopes },
          },
          { failClosed: true },
        );
        return created;
      },
    );

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
    const { organizationId } = request.query as { organizationId?: string };
    if (organizationId) {
      ClerkAuthService.requireOrganizationScope(principal, organizationId);
    }
    if (principal.type !== 'system') {
      if (principal.organizationIds.length === 0) {
        return pageEnvelope([], pagination.limit);
      }
    }
    const buildQuery = (cursor?: string) => {
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
      if (principal.type !== 'system') {
        query = query.where('organization_id', 'in', principal.organizationIds);
      }
      if (organizationId) {
        query = query.where('organization_id', '=', organizationId);
      }
      if (cursor) query = query.where('id', '>', cursor);
      return query;
    };
    const authorizedKeys = await listManageableScopedCredentialPage(
      principal,
      pagination,
      buildQuery,
    );

    return pageEnvelope(
      authorizedKeys.map((row) => serializeApiKey(row)),
      pagination.limit,
    );
  });

  app.delete('/api-keys/:keyId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { keyId } = request.params as { keyId: string };
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
    await db.transaction().execute(async (transaction) => {
      const revoked = await new ApiKeyRepository(transaction).revokeScoped({
        id: keyId,
        tenantId: principal.tenantId,
        organizationId: key.organization_id,
      });
      if (revoked !== 1) throw new NotFoundError('ApiKey', keyId);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'api_key.revoked',
          organizationId: key.organization_id,
          resourceType: 'ApiKey',
          resourceId: keyId,
        },
        { failClosed: true },
      );
    });
    return reply.status(204).send();
  });

  app.post('/scanner-devices', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const body = parseBody(createScannerDeviceSchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    requireAssignableScannerScope(principal, body.eventIds);
    const scopes = [...(body.scopes ?? DEFAULT_SCANNER_DEVICE_SCOPES)];
    requireAssignableScopes(principal, scopes);

    const { secret, record } = await withCredentialCreationResources(
      principal,
      { organizationId: body.organizationId, eventIds: body.eventIds },
      async (transaction) => {
        const created = await new ScannerDeviceRepository(transaction).create({
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          name: body.name,
          eventIds: body.eventIds ?? [],
          scopes,
        });
        await writeAuditLog(
          new AuditLogRepository(transaction),
          request,
          principal,
          {
            action: 'scanner_device.created',
            organizationId: body.organizationId,
            resourceType: 'ScannerDevice',
            resourceId: created.record.id as string,
            diffSummary: { name: body.name, eventIds: body.eventIds, scopes },
          },
          { failClosed: true },
        );
        return created;
      },
    );

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
    const buildQuery = (cursor?: string) => {
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
      if (cursor) query = query.where('id', '>', cursor);
      if (principal.type !== 'system') {
        query = query.where('organization_id', 'in', principal.organizationIds);
      }
      return query;
    };
    const authorizedRows = await listManageableScopedCredentialPage(
      principal,
      pagination,
      buildQuery,
    );
    return pageEnvelope(
      authorizedRows.map((row) => serializeScannerDevice(row)),
      pagination.limit,
    );
  });

  app.post('/scanner-devices/:deviceId/revoke', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { deviceId } = request.params as { deviceId: string };
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
    await db.transaction().execute(async (transaction) => {
      const revoked = await new ScannerDeviceRepository(transaction).revokeScoped({
        id: device.id,
        tenantId: principal.tenantId,
        organizationId: device.organization_id,
      });
      if (revoked !== 1) throw new NotFoundError('ScannerDevice', deviceId);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'scanner_device.revoked',
          organizationId: device.organization_id,
          resourceType: 'ScannerDevice',
          resourceId: device.id,
        },
        { failClosed: true },
      );
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

    await db.transaction().execute(async (transaction) => {
      await assertCredentialOrganization(principal, body.organizationId, transaction);
      await transaction
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
          subject_type: 'resource_owner',
          agent_principal_id: null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'oauth_app.created',
          organizationId: body.organizationId,
          resourceType: 'OAuthApplication',
          resourceId: id,
          diffSummary: { name: body.name, clientId },
        },
        { failClosed: true },
      );
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
      .where('subject_type', '=', 'resource_owner')
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
    await db.transaction().execute(async (transaction) => {
      let oauthAppQuery = transaction
        .selectFrom('oauth_applications')
        .selectAll()
        .where('id', '=', appId)
        .where('tenant_id', '=', principal.tenantId)
        .where('subject_type', '=', 'resource_owner');
      if (principal.type !== 'system') {
        if (principal.organizationIds.length === 0) {
          throw new NotFoundError('OAuthApplication', appId);
        }
        oauthAppQuery = oauthAppQuery.where('organization_id', 'in', principal.organizationIds);
      }
      const oauthApp = await oauthAppQuery.executeTakeFirst();
      if (!oauthApp || oauthApp.status !== 'active') {
        throw new NotFoundError('OAuthApplication', appId);
      }
      const revoked = await transaction
        .updateTable('oauth_applications')
        .set({ status: 'revoked', updated_at: new Date() })
        .where('id', '=', oauthApp.id)
        .where('tenant_id', '=', principal.tenantId)
        .where('organization_id', '=', oauthApp.organization_id)
        .where('subject_type', '=', 'resource_owner')
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (Number(revoked.numUpdatedRows) !== 1) {
        throw new NotFoundError('OAuthApplication', appId);
      }
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'oauth_app.revoked',
          organizationId: oauthApp.organization_id,
          resourceType: 'OAuthApplication',
          resourceId: appId,
        },
        { failClosed: true },
      );
    });
    return reply.status(204).send();
  });
};
