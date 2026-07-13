import { PortableExportAuthorizationRepository, type Database } from '@tixkit/db';
import type { HistoricalExportAuthorization } from '@tixkit/portability';

export interface PortableHistoricalAuthorizationService {
  grant(input: {
    tenantId: string;
    organizationId: string;
    principalId: string;
    expiresAt: Date;
  }): Promise<HistoricalExportAuthorization>;
  revoke(input: {
    tenantId: string;
    organizationId: string;
    principalId: string;
    authorizationId: string;
  }): Promise<void>;
}

export function createPortableHistoricalAuthorizationService(
  db: Database,
): PortableHistoricalAuthorizationService {
  const repository = new PortableExportAuthorizationRepository(db);
  const requireAdministrator = async (input: {
    tenantId: string;
    organizationId: string;
    principalId: string;
  }) => {
    const member = await db
      .selectFrom('organization_members')
      .select(['role', 'accepted_at'])
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('user_id', '=', input.principalId)
      .executeTakeFirst();
    if (!member?.accepted_at || (member.role !== 'owner' && member.role !== 'admin'))
      throw new Error('PORTABLE_EXPORT_AUTHORIZATION_ADMIN_REQUIRED');
  };

  return {
    async grant(input) {
      await requireAdministrator(input);
      const authorization = await repository.grant({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        grantedByPrincipalId: input.principalId,
        expiresAt: input.expiresAt,
      });
      return {
        authorizationId: authorization.id,
        tenantId: authorization.tenant_id,
        organizationId: authorization.organization_id,
        scope: 'tenant-historical-portability',
        grantedByPrincipalId: authorization.granted_by_principal_id,
        grantedAt: new Date(authorization.granted_at).toISOString(),
        expiresAt: new Date(authorization.expires_at).toISOString(),
      };
    },
    async revoke(input) {
      await requireAdministrator(input);
      await repository.revoke({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        authorizationId: input.authorizationId,
        revokedByPrincipalId: input.principalId,
      });
    },
  };
}
