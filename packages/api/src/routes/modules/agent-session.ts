import { AGENT_PROTOCOL_VERSION } from '@tixkit/agent-protocol';
import { NotFoundError } from '@tixkit/domain';
import type { FastifyPluginAsync } from 'fastify';

export const agentSessionRoutes: FastifyPluginAsync = async (app) => {
  app.get('/agent/session', { config: { agentAccess: true } }, async (request) => {
    const actor = request.principal!;
    if (actor.type !== 'agent') throw new NotFoundError('AgentSession', actor.id);
    const principal = await app.context.db
      .selectFrom('agent_principals')
      .select([
        'id',
        'tenant_id',
        'kind',
        'sponsor_principal_id',
        'capabilities',
        'maximum_autonomy',
        'protocol_version',
        'state',
        'registered_at',
        'updated_at',
      ])
      .where('tenant_id', '=', actor.tenantId)
      .where('id', '=', actor.id)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (!principal) throw new NotFoundError('AgentSession', actor.id);
    const capabilities: unknown = JSON.parse(principal.capabilities);
    if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string'))
      throw new Error('Invalid persisted agent capabilities');
    return {
      principal: {
        id: principal.id,
        tenantId: principal.tenant_id,
        kind: principal.kind,
        sponsorPrincipalId: principal.sponsor_principal_id,
        capabilities,
        maximumAutonomy: principal.maximum_autonomy,
        protocolVersion: principal.protocol_version,
        state: principal.state,
        registeredAt: new Date(principal.registered_at).toISOString(),
        updatedAt: new Date(principal.updated_at).toISOString(),
      },
      authentication: {
        grantType: 'client_credentials',
        scope: 'agent.invoke',
        productPermissions: [],
      },
      delegationRequired: true,
      supportedProtocolVersion: AGENT_PROTOCOL_VERSION,
    };
  });
};
