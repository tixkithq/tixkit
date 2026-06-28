import { BaseRepository } from './base.js';
import { ulid } from 'ulid';
import { createHash, randomBytes } from 'node:crypto';

export class UserProfileRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    clerkUserId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    avatarUrl?: string;
  }) {
    const id = `usr_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'user_profiles',
      {
        id,
        tenant_id: input.tenantId,
        clerk_user_id: input.clerkUserId,
        email: input.email,
        first_name: input.firstName ?? null,
        last_name: input.lastName ?? null,
        avatar_url: input.avatarUrl ?? null,
        status: 'active',
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('user_profiles').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByClerkUserId(tenantId: string, clerkUserId: string) {
    return this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('clerk_user_id', '=', clerkUserId)
      .executeTakeFirst();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('user_profiles', id, { ...input, updated_at: new Date() });
  }

  async suspend(id: string) {
    return this.updateReturning('user_profiles', id, {
      status: 'suspended',
      updated_at: new Date(),
    });
  }

  async findAllByClerkUserId(clerkUserId: string) {
    return this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('clerk_user_id', '=', clerkUserId)
      .execute();
  }

  /**
   * Suspends every profile linked to a Clerk user without deleting any
   * historical data (orders, attendees, audit logs remain intact).
   */
  async suspendAllByClerkUserId(clerkUserId: string): Promise<number> {
    const result = await this.db
      .updateTable('user_profiles')
      .set({ status: 'suspended', updated_at: new Date() })
      .where('clerk_user_id', '=', clerkUserId)
      .where('status', '!=', 'suspended')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }
}

export class ApiKeyRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    name: string;
    scopes: string[];
    brandIds?: string[];
    eventIds?: string[];
    expiresAt?: Date;
  }): Promise<{ apiKey: string; record: Record<string, unknown> }> {
    const id = `key_${ulid()}`;
    const rawKey = `tk_${randomBytes(32).toString('hex')}`;
    const keyPrefix = rawKey.substring(0, 12);
    const hashedKey = createHash('sha256').update(rawKey).digest('hex');
    const now = new Date();

    const record = await this.insertReturning(
      'api_keys',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        name: input.name,
        key_prefix: keyPrefix,
        hashed_key: hashedKey,
        scopes: JSON.stringify(input.scopes),
        brand_ids: input.brandIds ? JSON.stringify(input.brandIds) : null,
        event_ids: input.eventIds ? JSON.stringify(input.eventIds) : null,
        last_used_at: null,
        expires_at: input.expiresAt ?? null,
        revoked_at: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );

    return { apiKey: rawKey, record };
  }

  async findByHashedKey(hashedKey: string) {
    return this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('hashed_key', '=', hashedKey)
      .executeTakeFirst();
  }

  async revoke(id: string) {
    return this.updateReturning('api_keys', id, { revoked_at: new Date(), updated_at: new Date() });
  }

  async updateLastUsed(id: string) {
    return this.db
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
}

export class ScannerDeviceRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    name: string;
    eventIds: string[];
  }): Promise<{
    secret: string;
    record: Record<string, unknown>;
  }> {
    const id = `sd_${ulid()}`;
    const deviceId = `sd_${ulid()}`;
    const rawSecret = randomBytes(32).toString('hex');
    const hashedSecret = createHash('sha256').update(rawSecret).digest('hex');
    const now = new Date();

    const record = await this.insertReturning(
      'scanner_devices',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        name: input.name,
        device_id: deviceId,
        hashed_secret: hashedSecret,
        event_ids: JSON.stringify(input.eventIds),
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );

    return { secret: rawSecret, record };
  }

  async findByDeviceId(deviceId: string) {
    return this.db
      .selectFrom('scanner_devices')
      .selectAll()
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
  }

  async revoke(id: string) {
    return this.updateReturning('scanner_devices', id, {
      status: 'revoked',
      updated_at: new Date(),
    });
  }
}

export class AuditLogRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId?: string | null;
    brandId?: string | null;
    actorType: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    diffSummary?: Record<string, unknown>;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }) {
    const id = `audit_${ulid()}`;
    return this.insertReturning(
      'audit_logs',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId ?? null,
        brand_id: input.brandId ?? null,
        actor_type: input.actorType,
        actor_id: input.actorId,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        diff_summary: input.diffSummary ? JSON.stringify(input.diffSummary) : null,
        request_id: input.requestId ?? null,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
        created_at: new Date(),
      },
      id,
    );
  }

  async findByTenant(tenantId: string, limit = 50) {
    return this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
  }

  async findByResource(resourceId: string) {
    return this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_id', '=', resourceId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async listByTenant(
    tenantId: string,
    filters: {
      organizationIds?: string[];
      organizationId?: string;
      brandId?: string;
      action?: string;
      resourceType?: string;
      actorId?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    let query = this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'desc')
      .limit(limit + 1);

    if (filters.cursor) query = query.where('id', '<', filters.cursor);
    if (filters.organizationId) query = query.where('organization_id', '=', filters.organizationId);
    if (filters.brandId) query = query.where('brand_id', '=', filters.brandId);
    if (filters.action) query = query.where('action', '=', filters.action);
    if (filters.resourceType) query = query.where('resource_type', '=', filters.resourceType);
    if (filters.actorId) query = query.where('actor_id', '=', filters.actorId);
    if (filters.organizationIds && filters.organizationIds.length > 0) {
      query = query.where((eb) =>
        eb.or([
          eb('organization_id', 'in', filters.organizationIds!),
          eb('organization_id', 'is', null),
        ]),
      );
    }

    return query.execute();
  }
}

export class PrivacyRequestRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    brandId?: string | null;
    requestType: 'export' | 'erasure';
    subjectType: 'buyer' | 'attendee';
    subjectId?: string | null;
    subjectEmail?: string | null;
    requestedBy: string;
  }) {
    const id = `prv_${ulid()}`;
    return this.insertReturning(
      'privacy_requests',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: input.brandId ?? null,
        request_type: input.requestType,
        subject_type: input.subjectType,
        subject_id: input.subjectId ?? null,
        subject_email: input.subjectEmail?.toLowerCase() ?? null,
        status: 'pending',
        requested_by: input.requestedBy,
        result: null,
        error: null,
        created_at: new Date(),
        completed_at: null,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('privacy_requests')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async listByTenant(
    tenantId: string,
    filters: {
      organizationIds?: string[];
      organizationId?: string;
      brandId?: string;
      requestType?: string;
      status?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    let query = this.db
      .selectFrom('privacy_requests')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'desc')
      .limit(limit + 1);

    if (filters.cursor) query = query.where('id', '<', filters.cursor);
    if (filters.organizationId) query = query.where('organization_id', '=', filters.organizationId);
    if (filters.brandId) query = query.where('brand_id', '=', filters.brandId);
    if (filters.requestType) query = query.where('request_type', '=', filters.requestType);
    if (filters.status) query = query.where('status', '=', filters.status);
    if (filters.organizationIds && filters.organizationIds.length > 0) {
      query = query.where('organization_id', 'in', filters.organizationIds);
    }

    return query.execute();
  }

  async markProcessing(id: string) {
    return this.db
      .updateTable('privacy_requests')
      .set({ status: 'processing' })
      .where('id', '=', id)
      .execute();
  }

  async markCompleted(id: string, result: Record<string, unknown>) {
    return this.updateReturning('privacy_requests', id, {
      status: 'completed',
      result: JSON.stringify(result),
      error: null,
      completed_at: new Date(),
    });
  }

  async markFailed(id: string, error: string) {
    return this.updateReturning('privacy_requests', id, {
      status: 'failed',
      error,
      completed_at: new Date(),
    });
  }
}

export class PermissionGrantRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    principalType: string;
    principalId: string;
    permission: string;
    scopeType: string;
    scopeId?: string;
  }) {
    const id = `pg_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'permission_grants',
      {
        id,
        tenant_id: input.tenantId,
        principal_type: input.principalType,
        principal_id: input.principalId,
        permission: input.permission,
        scope_type: input.scopeType,
        scope_id: input.scopeId ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByPrincipal(tenantId: string, principalType: string, principalId: string) {
    return this.db
      .selectFrom('permission_grants')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('principal_type', '=', principalType)
      .where('principal_id', '=', principalId)
      .execute();
  }
}
