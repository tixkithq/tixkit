import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  ApiKeyRepository,
  ScannerDeviceRepository,
  AuditLogRepository,
  type Database,
} from '@tixkit/db';
import { ForbiddenError, NotFoundError, ValidationError, type Permission } from '@tixkit/domain';
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
import { hashRequest, withIdempotency } from '../../services/idempotency.js';
import { config } from '../../config/index.js';

const SENSITIVE_API_KEY_FIELDS = ['hashed_key'] as const;
const SENSITIVE_DEVICE_FIELDS = ['hashed_secret'] as const;
const DEFAULT_SCANNER_DEVICE_SCOPES = ['checkins.read', 'checkins.write'] as const;
const SCOPED_CREDENTIAL_SCAN_BATCH_MULTIPLIER = 10;
const SCOPED_CREDENTIAL_SCAN_MAX_ROWS = 500;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,255}$/u;
const API_KEY_CURSOR_TTL_MS = 15 * 60 * 1000;
const API_KEY_CURSOR_PREFIX = 'aksc1';
const SCANNER_DEVICE_CURSOR_PREFIX = 'sdsc1';
type Principal = NonNullable<FastifyRequest['principal']>;
type ScopedCredentialRow = {
  id: string;
  organization_id: string;
  brand_ids?: unknown;
  event_ids?: unknown;
};
type PermissionAuthority = {
  acceptedOrganizationIds: ReadonlySet<string>;
  brandIds: ReadonlySet<string>;
  brandOrganizationIds: ReadonlyMap<string, string>;
  eventIds: ReadonlySet<string>;
  eventOrganizationIds: ReadonlyMap<string, string>;
  organizationIds: ReadonlySet<string>;
  tenantWide: boolean;
};
type CredentialTarget = {
  brandIds: readonly string[];
  brandOrganizationIds: ReadonlyMap<string, string>;
  eventBrandIds: ReadonlyMap<string, string>;
  eventIds: readonly string[];
  eventOrganizationIds: ReadonlyMap<string, string>;
  organizationId: string;
};
type CredentialListQuery<T extends ScopedCredentialRow> = {
  limit(limit: number): CredentialListQuery<T>;
  execute(): Promise<T[]>;
};

function requireHumanUserPrincipal(principal: Principal): void {
  if (principal.type !== 'user') {
    throw new ForbiddenError('API key lifecycle management requires a human user principal');
  }
}

function requireApiKeyCreationIdempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (typeof value !== 'string' || value !== value.trim() || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ValidationError(
      'Idempotency-Key must contain 16-255 visible ASCII characters with no surrounding whitespace',
    );
  }
  return value;
}

function apiKeySecretReplayTombstone(apiKeyId: string, requestId: string) {
  return {
    status: 409,
    body: {
      error: {
        code: 'API_KEY_SECRET_NOT_REPLAYABLE',
        message:
          'This API key was already created, but its one-time secret cannot be replayed. Revoke it and create a replacement if the original response was lost.',
        requestId,
        details: { apiKeyId },
      },
    },
  } as const;
}

function apiKeyCursorKey(): Buffer {
  return createHash('sha256').update(config.dashboardCursorSigningKey, 'utf8').digest();
}

function encodeScopedCredentialCursor(rawCursor: string, binding: string, prefix: string): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', apiKeyCursorKey(), initializationVector);
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      rawCursor,
      binding,
      expiresAt: Date.now() + API_KEY_CURSOR_TTL_MS,
    }),
    'utf8',
  );
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    prefix,
    initializationVector.toString('base64url'),
    encrypted.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

function decodeScopedCredentialCursor(
  cursor: string,
  binding: string,
  prefix: string,
  errorMessage: string,
): string {
  try {
    const [parsedPrefix, initializationVector, encrypted, authenticationTag, ...extra] =
      cursor.split('.');
    if (
      parsedPrefix !== prefix ||
      !initializationVector ||
      !encrypted ||
      !authenticationTag ||
      extra.length > 0
    ) {
      throw new Error('invalid cursor envelope');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      apiKeyCursorKey(),
      Buffer.from(initializationVector, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    ) as Record<string, unknown>;
    if (
      payload.version !== 1 ||
      typeof payload.rawCursor !== 'string' ||
      payload.rawCursor.length === 0 ||
      payload.binding !== binding ||
      typeof payload.expiresAt !== 'number' ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= Date.now()
    ) {
      throw new Error('invalid cursor payload');
    }
    return payload.rawCursor;
  } catch {
    throw new ValidationError(errorMessage);
  }
}

function encodeApiKeyCursor(rawCursor: string, binding: string): string {
  return encodeScopedCredentialCursor(rawCursor, binding, API_KEY_CURSOR_PREFIX);
}

function decodeApiKeyCursor(cursor: string, binding: string): string {
  return decodeScopedCredentialCursor(
    cursor,
    binding,
    API_KEY_CURSOR_PREFIX,
    'Invalid or expired API key cursor',
  );
}

function encodeScannerDeviceCursor(rawCursor: string, binding: string): string {
  return encodeScopedCredentialCursor(rawCursor, binding, SCANNER_DEVICE_CURSOR_PREFIX);
}

function decodeScannerDeviceCursor(cursor: string, binding: string): string {
  return decodeScopedCredentialCursor(
    cursor,
    binding,
    SCANNER_DEVICE_CURSOR_PREFIX,
    'Invalid or expired scanner device cursor',
  );
}

function emptyPermissionAuthority(
  acceptedOrganizationIds: ReadonlySet<string>,
): PermissionAuthority {
  return {
    acceptedOrganizationIds,
    brandIds: new Set(),
    brandOrganizationIds: new Map(),
    eventIds: new Set(),
    eventOrganizationIds: new Map(),
    organizationIds: new Set(),
    tenantWide: false,
  };
}

function authorityCoversOrganization(authority: PermissionAuthority, organizationId: string) {
  return (
    authority.tenantWide ||
    (authority.acceptedOrganizationIds.has(organizationId) &&
      (authority.organizationIds.has(organizationId) ||
        [...authority.brandIds].some(
          (brandId) => authority.brandOrganizationIds.get(brandId) === organizationId,
        ) ||
        [...authority.eventIds].some(
          (eventId) => authority.eventOrganizationIds.get(eventId) === organizationId,
        )))
  );
}

function authorityCoversTarget(authority: PermissionAuthority, target: CredentialTarget) {
  if (authority.tenantWide) return true;
  if (!authority.acceptedOrganizationIds.has(target.organizationId)) return false;
  if (authority.organizationIds.has(target.organizationId)) return true;
  if (target.brandIds.length === 0 && target.eventIds.length === 0) return false;
  if (
    target.brandIds.some(
      (brandId) =>
        target.brandOrganizationIds.get(brandId) !== target.organizationId ||
        !authority.brandIds.has(brandId) ||
        authority.brandOrganizationIds.get(brandId) !== target.organizationId,
    )
  )
    return false;
  return target.eventIds.every(
    (eventId) =>
      target.eventBrandIds.has(eventId) &&
      target.eventOrganizationIds.get(eventId) === target.organizationId &&
      ((authority.eventIds.has(eventId) &&
        authority.eventOrganizationIds.get(eventId) === target.organizationId) ||
        Boolean(
          target.eventBrandIds.get(eventId) &&
          authority.brandIds.has(target.eventBrandIds.get(eventId)!) &&
          authority.brandOrganizationIds.get(target.eventBrandIds.get(eventId)!) ===
            target.organizationId,
        )),
  );
}

function sanitize<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[],
): Partial<T> {
  const copy: Record<string, unknown> = { ...record };
  for (const field of fields) delete copy[field];
  return copy as Partial<T>;
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

  async function loadPermissionAuthorities(
    database: Database,
    principal: Principal,
    permissions: readonly Permission[],
    lock: boolean,
  ): Promise<ReadonlyMap<Permission, PermissionAuthority>> {
    requireHumanUserPrincipal(principal);
    const uniquePermissions = [...new Set(permissions)];
    if (principal.type === 'system') {
      return new Map(
        uniquePermissions.map((permission) => [
          permission,
          { ...emptyPermissionAuthority(new Set()), tenantWide: true },
        ]),
      );
    }

    let membershipQuery = database
      .selectFrom('organization_members')
      .select('organization_id')
      .where('tenant_id', '=', principal.tenantId)
      .where('user_id', '=', principal.id)
      .where('accepted_at', 'is not', null);
    let grantQuery = database
      .selectFrom('permission_grants')
      .select(['permission', 'scope_type', 'scope_id'])
      .where('tenant_id', '=', principal.tenantId)
      .where('principal_type', '=', 'user')
      .where('principal_id', '=', principal.id)
      .where('permission', 'in', uniquePermissions);
    if (lock) {
      membershipQuery = membershipQuery.forUpdate();
      grantQuery = grantQuery.forUpdate();
    }
    const memberships = await membershipQuery.execute();
    const grants = await grantQuery.execute();
    const principalOrganizationIds = new Set(principal.organizationIds);
    const acceptedOrganizationIds = new Set(
      memberships
        .map((membership) => String(membership.organization_id))
        .filter((organizationId) => principalOrganizationIds.has(organizationId)),
    );
    const brandIds = [
      ...new Set(
        grants
          .filter((grant) => grant.scope_type === 'brand' && grant.scope_id)
          .map((grant) => String(grant.scope_id)),
      ),
    ];
    const eventIds = [
      ...new Set(
        grants
          .filter((grant) => grant.scope_type === 'event' && grant.scope_id)
          .map((grant) => String(grant.scope_id)),
      ),
    ];
    let brandQuery = database
      .selectFrom('brands')
      .select(['id', 'organization_id'])
      .where('tenant_id', '=', principal.tenantId)
      .where('id', 'in', brandIds.length > 0 ? brandIds : ['']);
    let eventQuery = database
      .selectFrom('events')
      .select(['id', 'organization_id'])
      .where('tenant_id', '=', principal.tenantId)
      .where('id', 'in', eventIds.length > 0 ? eventIds : ['']);
    if (lock) {
      brandQuery = brandQuery.forUpdate();
      eventQuery = eventQuery.forUpdate();
    }
    const brands = await brandQuery.execute();
    const events = await eventQuery.execute();
    const brandOrganizationIds = new Map(
      brands.map((brand) => [String(brand.id), String(brand.organization_id)]),
    );
    const eventOrganizationIds = new Map(
      events.map((event) => [String(event.id), String(event.organization_id)]),
    );

    return new Map(
      uniquePermissions.map((permission) => {
        const authority = emptyPermissionAuthority(acceptedOrganizationIds);
        const permissionGrants = grants.filter((grant) => grant.permission === permission);
        return [
          permission,
          {
            ...authority,
            tenantWide: permissionGrants.some((grant) => grant.scope_type === 'tenant'),
            organizationIds: new Set(
              permissionGrants
                .filter((grant) => grant.scope_type === 'organization' && grant.scope_id)
                .map((grant) => String(grant.scope_id)),
            ),
            brandIds: new Set(
              permissionGrants
                .filter((grant) => grant.scope_type === 'brand' && grant.scope_id)
                .map((grant) => String(grant.scope_id)),
            ),
            eventIds: new Set(
              permissionGrants
                .filter((grant) => grant.scope_type === 'event' && grant.scope_id)
                .map((grant) => String(grant.scope_id)),
            ),
            brandOrganizationIds,
            eventOrganizationIds,
          },
        ];
      }),
    );
  }

  async function credentialTarget(
    database: Database,
    tenantId: string,
    input: { brandIds?: readonly string[]; eventIds?: readonly string[]; organizationId: string },
    lock = false,
  ): Promise<CredentialTarget> {
    const brandIds = [...new Set(input.brandIds ?? [])];
    const eventIds = [...new Set(input.eventIds ?? [])];
    let brandQuery = database
      .selectFrom('brands')
      .select(['id', 'organization_id'])
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', 'in', brandIds.length > 0 ? brandIds : ['']);
    let eventQuery = database
      .selectFrom('events')
      .select(['id', 'brand_id', 'organization_id'])
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', 'in', eventIds.length > 0 ? eventIds : ['']);
    if (lock) {
      brandQuery = brandQuery.forUpdate();
      eventQuery = eventQuery.forUpdate();
    }
    const brands = await brandQuery.execute();
    const events = await eventQuery.execute();
    return {
      organizationId: input.organizationId,
      brandIds,
      brandOrganizationIds: new Map(
        brands.map((brand) => [String(brand.id), String(brand.organization_id)]),
      ),
      eventIds,
      eventBrandIds: new Map(events.map((event) => [String(event.id), String(event.brand_id)])),
      eventOrganizationIds: new Map(
        events.map((event) => [String(event.id), String(event.organization_id)]),
      ),
    };
  }

  function requireAuthority(
    authorities: ReadonlyMap<Permission, PermissionAuthority>,
    permission: Permission,
    target: CredentialTarget,
  ): void {
    const authority = authorities.get(permission);
    if (!authority || !authorityCoversTarget(authority, target)) {
      throw new NotFoundError('Organization', target.organizationId);
    }
  }

  async function loadEventScopes(
    principal: Principal,
    eventIds: string[],
    database: Database = db,
    lock = false,
  ) {
    const uniqueEventIds = [...new Set(eventIds)];
    if (uniqueEventIds.length === 0) {
      return new Map<string, { brandId: string; organizationId: string }>();
    }
    const organizationIds = new Set<string>(principal.organizationIds);

    let eventQuery = database
      .selectFrom('events')
      .select(['id', 'organization_id', 'brand_id'])
      .where('tenant_id', '=', principal.tenantId)
      .where('id', 'in', uniqueEventIds)
      .orderBy('id', 'asc');
    if (lock) eventQuery = eventQuery.forUpdate();
    const events = await eventQuery.execute();

    const eventScopes = new Map<string, { brandId: string; organizationId: string }>();
    for (const event of events) {
      if (
        (principal.type === 'system' || organizationIds.has(String(event.organization_id))) &&
        typeof event.id === 'string' &&
        typeof event.brand_id === 'string'
      ) {
        eventScopes.set(event.id, {
          brandId: event.brand_id,
          organizationId: event.organization_id,
        });
      }
    }
    return eventScopes;
  }

  function canManageScopedCredentialRow(
    principal: Principal,
    row: ScopedCredentialRow,
    eventScopes: Map<string, { brandId: string; organizationId: string }>,
  ) {
    const eventIds = parseStringArray(row.event_ids);

    if (principal.eventIds?.length) {
      return (
        parseStringArray(row.brand_ids).length === 0 &&
        eventIds.length > 0 &&
        isContained(eventIds, principal.eventIds) &&
        eventIds.every(
          (eventId) => eventScopes.get(eventId)?.organizationId === row.organization_id,
        )
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
        const eventScope = eventScopes.get(eventId);
        return Boolean(
          eventScope &&
          eventScope.organizationId === row.organization_id &&
          principalBrandIds.has(eventScope.brandId),
        );
      });
    }
    return true;
  }

  async function filterManageableScopedCredentialRows<T extends ScopedCredentialRow>(
    principal: Principal,
    rows: T[],
    database: Database = db,
    lock = false,
  ) {
    if (!hasScopedResourceBounds(principal)) {
      return rows;
    }
    const eventScopes = await loadEventScopes(
      principal,
      rows.flatMap((row) => parseStringArray(row.event_ids)),
      database,
      lock,
    );
    return rows.filter((row) => canManageScopedCredentialRow(principal, row, eventScopes));
  }

  async function revokeScannerDevice(
    request: FastifyRequest,
    principal: Principal,
    deviceId: string,
  ): Promise<void> {
    await db.transaction().execute(async (transaction) => {
      const device = await transaction
        .selectFrom('scanner_devices')
        .selectAll()
        .where('tenant_id', '=', principal.tenantId)
        .where('device_id', '=', deviceId)
        .forUpdate()
        .executeTakeFirst();
      if (!device) throw new NotFoundError('ScannerDevice', deviceId);
      ClerkAuthService.requireResourceTenant(principal, device, 'ScannerDevice', deviceId);
      if (
        principal.type !== 'system' &&
        !principal.organizationIds.includes(device.organization_id)
      ) {
        throw new NotFoundError('ScannerDevice', deviceId);
      }
      const [authorizedDevice] = await filterManageableScopedCredentialRows(
        principal,
        [device],
        transaction,
        true,
      );
      if (!authorizedDevice) throw new NotFoundError('ScannerDevice', deviceId);
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
  }

  async function listManageableScopedCredentialPage<T extends ScopedCredentialRow>(
    principal: Principal,
    pagination: { cursor?: string; limit: number },
    buildQuery: (cursor?: string) => CredentialListQuery<T>,
  ) {
    if (!hasScopedResourceBounds(principal)) {
      return {
        rows: await buildQuery(pagination.cursor)
          .limit(pagination.limit + 1)
          .execute(),
      };
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
      if (rows.length === 0) return { rows: authorizedRows };

      scannedRows += rows.length;
      authorizedRows.push(...(await filterManageableScopedCredentialRows(principal, rows)));

      if (rows.length < currentLimit) return { rows: authorizedRows };
      const nextCursor = rows.at(-1)?.id;
      if (!nextCursor || nextCursor === cursor) return { rows: authorizedRows };
      cursor = nextCursor;
    }

    return authorizedRows.length <= pagination.limit
      ? { rows: authorizedRows, continuationCursor: cursor }
      : { rows: authorizedRows };
  }

  async function filterCredentialRowsByAuthority<T extends ScopedCredentialRow>(
    tenantId: string,
    authority: PermissionAuthority,
    rows: T[],
  ): Promise<T[]> {
    const brandIds = [...new Set(rows.flatMap((row) => parseStringArray(row.brand_ids)))];
    const eventIds = [...new Set(rows.flatMap((row) => parseStringArray(row.event_ids)))];
    const brands =
      brandIds.length === 0
        ? []
        : await db
            .selectFrom('brands')
            .select(['id', 'organization_id'])
            .where('tenant_id', '=', tenantId)
            .where('id', 'in', brandIds)
            .execute();
    const events =
      eventIds.length === 0
        ? []
        : await db
            .selectFrom('events')
            .select(['id', 'brand_id', 'organization_id'])
            .where('tenant_id', '=', tenantId)
            .where('id', 'in', eventIds)
            .execute();
    const eventBrandIds = new Map(
      events.map((event) => [String(event.id), String(event.brand_id)]),
    );
    const eventOrganizationIds = new Map(
      events.map((event) => [String(event.id), String(event.organization_id)]),
    );
    const brandOrganizationIds = new Map(
      brands.map((brand) => [String(brand.id), String(brand.organization_id)]),
    );
    return rows.filter((row) =>
      authorityCoversTarget(authority, {
        organizationId: row.organization_id,
        brandIds: parseStringArray(row.brand_ids),
        brandOrganizationIds,
        eventIds: parseStringArray(row.event_ids),
        eventBrandIds,
        eventOrganizationIds,
      }),
    );
  }

  async function listCredentialPageByAuthority<T extends ScopedCredentialRow>(
    tenantId: string,
    authority: PermissionAuthority,
    pagination: { cursor?: string; limit: number },
    buildQuery: (cursor?: string) => CredentialListQuery<T>,
  ): Promise<{ continuationCursor?: string; rows: T[] }> {
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
      if (rows.length === 0) return { rows: authorizedRows };
      scannedRows += rows.length;
      authorizedRows.push(...(await filterCredentialRowsByAuthority(tenantId, authority, rows)));
      const nextCursor = rows.at(-1)?.id;
      if (!nextCursor || nextCursor === cursor) return { rows: authorizedRows };
      cursor = nextCursor;
      if (rows.length < currentLimit) return { rows: authorizedRows };
    }

    return authorizedRows.length <= pagination.limit
      ? { rows: authorizedRows, continuationCursor: cursor }
      : { rows: authorizedRows };
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
    reply.header('Cache-Control', 'private, no-store');
    const principal = request.principal!;
    requireHumanUserPrincipal(principal);
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const body = parseBody(createApiKeySchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    requireAssignableScopes(principal, body.scopes as never);
    const idempotencyKey = requireApiKeyCreationIdempotencyKey(request.headers);
    const result = await withIdempotency(
      db,
      {
        key: `api-key:create:${hashRequest({ principalId: principal.id, idempotencyKey })}`,
        tenantId: principal.tenantId,
        requestHash: hashRequest(body),
        discardErrorCodes: ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR'],
        storedResponse: (response) => {
          const apiKeyId = (response.body as { id?: unknown }).id;
          if (typeof apiKeyId !== 'string') {
            throw new Error('API key creation response omitted its stable identifier');
          }
          return apiKeySecretReplayTombstone(apiKeyId, request.id);
        },
      },
      async ({ completeInTransaction }) => {
        const { apiKey, record } = await withCredentialCreationResources(
          principal,
          {
            organizationId: body.organizationId,
            brandIds: body.brandIds,
            eventIds: body.eventIds,
          },
          async (transaction) => {
            const requestedPermissions = [
              'developers.write' as const,
              ...(body.scopes as Permission[]),
            ];
            const authorities = await loadPermissionAuthorities(
              transaction,
              principal,
              requestedPermissions,
              true,
            );
            const target = await credentialTarget(transaction, principal.tenantId, {
              organizationId: body.organizationId,
              brandIds: body.brandIds,
              eventIds: body.eventIds,
            });
            for (const permission of requestedPermissions) {
              requireAuthority(authorities, permission, target);
            }
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
            await completeInTransaction(
              transaction,
              apiKeySecretReplayTombstone(created.record.id as string, request.id),
            );
            return created;
          },
        );
        return {
          status: 201,
          body: { ...serializeApiKey(sanitize(record, SENSITIVE_API_KEY_FIELDS)), apiKey },
        };
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.get('/api-keys', async (request) => {
    const principal = request.principal!;
    requireHumanUserPrincipal(principal);
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const pagination = parsePagination(request.query);
    const { organizationId } = request.query as { organizationId?: string };
    const cursorBinding = hashRequest({
      tenantId: principal.tenantId,
      principalId: principal.id,
      organizationId: organizationId ?? null,
    });
    const scopedPagination = {
      ...pagination,
      ...(pagination.cursor
        ? { cursor: decodeApiKeyCursor(pagination.cursor, cursorBinding) }
        : {}),
    };
    const authorities = await loadPermissionAuthorities(db, principal, ['developers.write'], false);
    const authority = authorities.get('developers.write')!;
    if (organizationId && !authorityCoversOrganization(authority, organizationId)) {
      throw new NotFoundError('Organization', organizationId);
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
      if (principal.type !== 'system' && !authority.tenantWide) {
        const acceptedOrganizationIds = [...authority.acceptedOrganizationIds];
        query = query.where(
          'organization_id',
          'in',
          acceptedOrganizationIds.length > 0 ? acceptedOrganizationIds : [''],
        );
      }
      if (organizationId) {
        query = query.where('organization_id', '=', organizationId);
      }
      if (cursor) query = query.where('id', '>', cursor);
      return query;
    };
    const authorizedPage = await listCredentialPageByAuthority(
      principal.tenantId,
      authority,
      scopedPagination,
      buildQuery,
    );
    const envelope = pageEnvelope(
      authorizedPage.rows.map((row) => serializeApiKey(row)),
      pagination.limit,
    );
    const rawNextCursor =
      authorizedPage.continuationCursor && !envelope.hasMore
        ? authorizedPage.continuationCursor
        : envelope.nextCursor;
    return {
      ...envelope,
      hasMore: Boolean(rawNextCursor),
      nextCursor: rawNextCursor ? encodeApiKeyCursor(rawNextCursor, cursorBinding) : null,
    };
  });

  app.delete('/api-keys/:keyId', async (request, reply) => {
    const principal = request.principal!;
    requireHumanUserPrincipal(principal);
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { keyId } = request.params as { keyId: string };
    await db.transaction().execute(async (transaction) => {
      const authorities = await loadPermissionAuthorities(
        transaction,
        principal,
        ['developers.write'],
        true,
      );
      const key = await transaction
        .selectFrom('api_keys')
        .selectAll()
        .where('id', '=', keyId)
        .forUpdate()
        .executeTakeFirst();
      if (!key) throw new NotFoundError('ApiKey', keyId);
      ClerkAuthService.requireResourceTenant(principal, key, 'ApiKey', keyId);
      const target = await credentialTarget(
        transaction,
        principal.tenantId,
        {
          organizationId: key.organization_id,
          brandIds: parseStringArray(key.brand_ids),
          eventIds: parseStringArray(key.event_ids),
        },
        true,
      );
      requireAuthority(authorities, 'developers.write', target);
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
          organizationId: target.organizationId,
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
    const cursorBinding = hashRequest({
      tenantId: principal.tenantId,
      principalType: principal.type,
      principalId: principal.id,
      organizationIds: [...principal.organizationIds].sort(),
      brandIds: principal.brandIds ? [...principal.brandIds].sort() : null,
      eventIds: principal.eventIds ? [...principal.eventIds].sort() : null,
      limit: pagination.limit,
    });
    const scopedPagination = {
      ...pagination,
      ...(pagination.cursor
        ? { cursor: decodeScannerDeviceCursor(pagination.cursor, cursorBinding) }
        : {}),
    };
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
    const authorizedPage = await listManageableScopedCredentialPage(
      principal,
      scopedPagination,
      buildQuery,
    );
    const envelope = pageEnvelope(
      authorizedPage.rows.map((row) => serializeScannerDevice(row)),
      pagination.limit,
    );
    const nextCursor =
      authorizedPage.continuationCursor && !envelope.hasMore
        ? authorizedPage.continuationCursor
        : envelope.nextCursor;
    return {
      ...envelope,
      hasMore: Boolean(nextCursor),
      nextCursor: nextCursor ? encodeScannerDeviceCursor(nextCursor, cursorBinding) : null,
    };
  });

  app.post('/scanner-devices/:deviceId/revoke', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { deviceId } = request.params as { deviceId: string };
    await revokeScannerDevice(request, principal, deviceId);
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
        redirectUris: parseStringArray(row.redirect_uris),
        scopes: parseStringArray(row.scopes),
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
