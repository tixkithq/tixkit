import { sql, type Selectable } from 'kysely';
import { getDriver, type Database } from '../client.js';
import { mssqlForUpdateTable } from '../dialects/mssql.js';
import type { PortableExportAuthorizationTable } from '../types/db.js';
import { BaseRepository } from './base.js';

const HISTORICAL_SCOPE = 'tenant-historical-portability';
const MAX_AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MIN_SIGNING_WINDOW_MS = 5_000;

function trustedWallClockExpression() {
  return getDriver() === 'postgres' ? sql<Date>`clock_timestamp()` : sql<Date>`current_timestamp`;
}

async function trustedWallClockNow(db: Database): Promise<Date> {
  const expression = trustedWallClockExpression();
  const result = await sql<{
    trusted_now: Date | string;
  }>`select ${expression} as trusted_now`.execute(db);
  const now = new Date(result.rows[0]!.trusted_now);
  if (!Number.isFinite(now.getTime())) throw new Error('PORTABLE_EXPORT_DATABASE_TIME_INVALID');
  return now;
}

async function authorizationForUpdate(
  db: Database,
  input: { tenantId: string; organizationId: string; authorizationId: string },
): Promise<Selectable<PortableExportAuthorizationTable> | undefined> {
  if (getDriver() === 'mssql') {
    const result = await sql<Selectable<PortableExportAuthorizationTable>>`select * from ${sql.raw(
      mssqlForUpdateTable('portable_export_authorizations'),
    )} where tenant_id = ${input.tenantId} and organization_id = ${input.organizationId} and id = ${input.authorizationId}`.execute(
      db,
    );
    return result.rows[0];
  }
  return db
    .selectFrom('portable_export_authorizations')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('organization_id', '=', input.organizationId)
    .where('id', '=', input.authorizationId)
    .forUpdate()
    .executeTakeFirst();
}

export class PortableExportAuthorizationRepository extends BaseRepository {
  constructor(db: Database) {
    super(db);
  }

  async grant(input: {
    tenantId: string;
    organizationId: string;
    grantedByPrincipalId: string;
    expiresAt: Date;
  }): Promise<Selectable<PortableExportAuthorizationTable>> {
    if (
      !input.tenantId.trim() ||
      !input.organizationId.trim() ||
      !input.grantedByPrincipalId.trim() ||
      input.grantedByPrincipalId.length > 128 ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= 0
    )
      throw new Error('PORTABLE_EXPORT_AUTHORIZATION_INVALID');

    return this.db.transaction().execute(async (transaction) => {
      const repository = new PortableExportAuthorizationRepository(transaction as Database);
      const grantedAt = await trustedWallClockNow(transaction as Database);
      if (
        input.expiresAt <= grantedAt ||
        input.expiresAt.getTime() - grantedAt.getTime() > MAX_AUTHORIZATION_LIFETIME_MS
      )
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_INVALID');
      const id = this.generateId('pexa');
      await transaction
        .insertInto('portable_export_authorizations')
        .values({
          id,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          scope: HISTORICAL_SCOPE,
          granted_by_principal_id: input.grantedByPrincipalId,
          granted_at: grantedAt,
          expires_at: input.expiresAt,
          revoked_by_principal_id: null,
          revoked_at: null,
          consumed_at: null,
        })
        .execute();
      await transaction
        .insertInto('portable_export_authorization_events')
        .values({
          id: repository.generateId('peae'),
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          authorization_id: id,
          event_type: 'granted',
          actor_principal_id: input.grantedByPrincipalId,
          export_job_id: null,
          occurred_at: grantedAt,
        })
        .execute();
      return transaction
        .selectFrom('portable_export_authorizations')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    });
  }

  async find(input: { tenantId: string; organizationId: string; authorizationId: string }) {
    return this.db
      .selectFrom('portable_export_authorizations')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.authorizationId)
      .executeTakeFirst();
  }

  async revoke(input: {
    tenantId: string;
    organizationId: string;
    authorizationId: string;
    revokedByPrincipalId: string;
  }): Promise<Selectable<PortableExportAuthorizationTable>> {
    if (!input.revokedByPrincipalId.trim() || input.revokedByPrincipalId.length > 128)
      throw new Error('PORTABLE_EXPORT_AUTHORIZATION_REVOCATION_INVALID');

    return this.db.transaction().execute(async (transaction) => {
      const authorization = await authorizationForUpdate(transaction as Database, input);
      if (!authorization) throw new Error('PORTABLE_EXPORT_AUTHORIZATION_NOT_FOUND');
      const revokedAt = await trustedWallClockNow(transaction as Database);
      if (authorization.consumed_at)
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_ALREADY_CONSUMED');
      if (authorization.revoked_at) return authorization;

      const result = await transaction
        .updateTable('portable_export_authorizations')
        .set({
          revoked_by_principal_id: input.revokedByPrincipalId,
          revoked_at: revokedAt,
        })
        .where('id', '=', input.authorizationId)
        .where('revoked_at', 'is', null)
        .where('consumed_at', 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_STATE_CONFLICT');
      await transaction
        .insertInto('portable_export_authorization_events')
        .values({
          id: this.generateId('peae'),
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          authorization_id: input.authorizationId,
          event_type: 'revoked',
          actor_principal_id: input.revokedByPrincipalId,
          export_job_id: null,
          occurred_at: revokedAt,
        })
        .execute();
      return transaction
        .selectFrom('portable_export_authorizations')
        .selectAll()
        .where('id', '=', input.authorizationId)
        .executeTakeFirstOrThrow();
    });
  }

  async consume(input: {
    tenantId: string;
    organizationId: string;
    authorizationId: string;
    exportJobId: string;
    actorPrincipalId: string;
  }): Promise<Selectable<PortableExportAuthorizationTable>> {
    if (!input.actorPrincipalId.trim() || input.actorPrincipalId.length > 128)
      throw new Error('PORTABLE_EXPORT_AUTHORIZATION_CONSUMPTION_INVALID');

    return this.db.transaction().execute(async (transaction) => {
      const authorization = await authorizationForUpdate(transaction as Database, input);
      if (!authorization) throw new Error('PORTABLE_EXPORT_AUTHORIZATION_NOT_FOUND');
      const consumedAt = await trustedWallClockNow(transaction as Database);
      if (authorization.granted_by_principal_id !== input.actorPrincipalId)
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_PRINCIPAL_MISMATCH');
      const job = await transaction
        .selectFrom('portable_export_jobs')
        .select(['id', 'mode', 'historical_authorization_id'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.exportJobId)
        .executeTakeFirst();
      if (
        !job ||
        job.mode !== 'historical' ||
        job.historical_authorization_id !== input.authorizationId
      )
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_JOB_MISMATCH');

      if (authorization.consumed_at) {
        const consumed = await transaction
          .selectFrom('portable_export_authorization_events')
          .select('export_job_id')
          .where('authorization_id', '=', input.authorizationId)
          .where('event_type', '=', 'consumed')
          .executeTakeFirst();
        if (consumed?.export_job_id !== input.exportJobId)
          throw new Error('PORTABLE_EXPORT_AUTHORIZATION_ALREADY_CONSUMED');
        return authorization;
      }
      if (authorization.revoked_at) throw new Error('PORTABLE_EXPORT_AUTHORIZATION_REVOKED');
      if (
        consumedAt < new Date(authorization.granted_at) ||
        new Date(authorization.expires_at).getTime() <= consumedAt.getTime()
      )
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_EXPIRED');

      const result = await transaction
        .updateTable('portable_export_authorizations')
        .set({ consumed_at: consumedAt })
        .where('id', '=', input.authorizationId)
        .where('revoked_at', 'is', null)
        .where('consumed_at', 'is', null)
        .where('granted_at', '<=', trustedWallClockExpression())
        .where('expires_at', '>', trustedWallClockExpression())
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_STATE_CONFLICT');
      await transaction
        .insertInto('portable_export_authorization_events')
        .values({
          id: this.generateId('peae'),
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          authorization_id: input.authorizationId,
          event_type: 'consumed',
          actor_principal_id: input.actorPrincipalId,
          export_job_id: input.exportJobId,
          occurred_at: consumedAt,
        })
        .execute();
      return transaction
        .selectFrom('portable_export_authorizations')
        .selectAll()
        .where('id', '=', input.authorizationId)
        .executeTakeFirstOrThrow();
    });
  }

  async validateForSigning(input: {
    tenantId: string;
    organizationId: string;
    authorizationId: string;
    exportJobId: string;
    actorPrincipalId: string;
  }): Promise<{ authorization: Selectable<PortableExportAuthorizationTable>; signingTime: Date }> {
    if (!input.actorPrincipalId.trim() || input.actorPrincipalId.length > 128)
      throw new Error('PORTABLE_EXPORT_AUTHORIZATION_SIGNING_INVALID');

    return this.db.transaction().execute(async (transaction) => {
      const authorization = await authorizationForUpdate(transaction as Database, input);
      if (!authorization) throw new Error('PORTABLE_EXPORT_AUTHORIZATION_NOT_FOUND');
      const consumedEvent = await transaction
        .selectFrom('portable_export_authorization_events')
        .select(['actor_principal_id', 'export_job_id'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('authorization_id', '=', input.authorizationId)
        .where('event_type', '=', 'consumed')
        .executeTakeFirst();
      if (
        authorization.scope !== HISTORICAL_SCOPE ||
        authorization.granted_by_principal_id !== input.actorPrincipalId ||
        !authorization.consumed_at ||
        authorization.revoked_at ||
        consumedEvent?.actor_principal_id !== input.actorPrincipalId ||
        consumedEvent.export_job_id !== input.exportJobId
      )
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_SIGNING_MISMATCH');

      const signingTime = await trustedWallClockNow(transaction as Database);
      if (
        signingTime < new Date(authorization.granted_at) ||
        new Date(authorization.expires_at).getTime() - signingTime.getTime() < MIN_SIGNING_WINDOW_MS
      )
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_EXPIRED');
      return { authorization, signingTime };
    });
  }
}
