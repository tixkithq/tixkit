import {
  agentSha256,
  canonicalAgentJson,
  normalizeAgentMemoryContent,
  normalizeAgentMemoryProvenance,
  validateAgentMemoryNamespace,
  validateAgentMemoryWrite,
  type AgentMemoryContent,
  type AgentMemoryEntry,
  type AgentMemoryNamespace,
  type AgentMemoryProvenance,
} from '@tixkit/agent-protocol';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { ulid } from 'ulid';
import type { DB } from '../types/db.js';

type Executor = Kysely<DB> | Transaction<DB>;
const TOKEN = /^[A-Z0-9_]{3,64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface AgentMemoryAuditInput {
  id: string;
  actorPrincipalId: string;
  reasonCode: string;
  idempotencyKey: string;
}

function scopeId(namespace: AgentMemoryNamespace): string {
  return namespace.scopeType === 'workspace' ? 'workspace' : namespace.scopeId!;
}
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}
function safeStoredSha(value: string): string {
  return SHA256.test(value) ? value : agentSha256({ domain: 'agent-memory-corrupt-sha-v1', value });
}

async function now(db: Executor): Promise<Date> {
  const row = await db
    .selectFrom('tenants')
    .select(sql<Date>`current_timestamp`.as('now'))
    .limit(1)
    .executeTakeFirstOrThrow();
  return new Date(row.now);
}

async function transaction<T>(db: Kysely<DB>, fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.transaction().execute(fn);
    } catch (error) {
      const item = error as {
        code?: string;
        errno?: number;
        cause?: { code?: string; errno?: number };
      };
      const code = item.code ?? item.cause?.code;
      const errno = item.errno ?? item.cause?.errno;
      if (
        attempt === 4 ||
        (code !== '40001' && code !== '40P01' && code !== 'ER_LOCK_DEADLOCK' && errno !== 1213)
      )
        throw error;
    }
  }
  throw new Error('AGENT_MEMORY_TRANSACTION_RETRY_EXHAUSTED');
}

function rowToEntry(row: Selectable<DB['agent_memory_entries']>): AgentMemoryEntry {
  try {
    const namespace = {
      tenantId: row.tenant_id,
      sponsorPrincipalId: row.sponsor_principal_id,
      scopeType: row.scope_type as AgentMemoryNamespace['scopeType'],
      ...(row.scope_type === 'workspace' ? {} : { scopeId: row.scope_id }),
      purpose: row.purpose as AgentMemoryNamespace['purpose'],
    };
    const content = normalizeAgentMemoryContent(parse<AgentMemoryContent>(row.content));
    const provenance = normalizeAgentMemoryProvenance(parse<AgentMemoryProvenance>(row.provenance));
    const sha = validateAgentMemoryWrite({
      namespace,
      key: row.memory_key,
      content,
      provenance,
      retentionExpiresAt: iso(row.retention_expires_at),
      now: iso(row.updated_at),
    });
    if (
      canonicalAgentJson(content) !== row.content ||
      canonicalAgentJson(provenance) !== row.provenance ||
      sha !== row.content_sha256 ||
      !SHA256.test(row.resource_binding_sha256)
    )
      throw new Error('digest mismatch');
    return {
      id: row.id,
      namespace,
      key: row.memory_key,
      content,
      contentSha256: sha,
      provenance,
      version: Number(row.version),
      retentionExpiresAt: iso(row.retention_expires_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  } catch {
    throw new Error('AGENT_MEMORY_INTEGRITY_INVALID');
  }
}

export class AgentMemoryRepository {
  constructor(private readonly db: Kysely<DB>) {}

  async create(input: {
    id: string;
    namespace: AgentMemoryNamespace;
    key: string;
    content: AgentMemoryContent;
    provenance: AgentMemoryProvenance;
    retentionExpiresAt: string;
    audit: AgentMemoryAuditInput;
  }): Promise<AgentMemoryEntry | undefined> {
    return transaction(this.db, async (tx) => {
      await this.lockTenant(tx, input.namespace.tenantId);
      const clock = await now(tx);
      const resource = await this.resolveScope(tx, input.namespace);
      const normalized = normalizeAgentMemoryContent(input.content);
      const submittedProvenance = normalizeAgentMemoryProvenance(input.provenance);
      this.assertUserProvenance(submittedProvenance, input.audit.actorPrincipalId);
      const provenance =
        submittedProvenance.type === 'organizer'
          ? { ...submittedProvenance, observedAt: clock.toISOString() }
          : submittedProvenance;
      const sha = validateAgentMemoryWrite({
        ...input,
        content: normalized,
        provenance,
        now: clock.toISOString(),
      });
      const fingerprint = agentSha256({
        operation: 'create',
        id: input.id,
        namespace: input.namespace,
        key: input.key,
        contentSha256: sha,
        provenance:
          provenance.type === 'organizer'
            ? { type: provenance.type, actorPrincipalId: provenance.actorPrincipalId }
            : provenance,
        retentionExpiresAt: input.retentionExpiresAt,
        actor: input.audit.actorPrincipalId,
        reason: input.audit.reasonCode,
        resourceAuthorizationSha256: resource.authorizationSha256,
      });
      await this.authorizeUser(tx, input.namespace, input.audit.actorPrincipalId);
      const replay = await this.replay(tx, input.namespace.tenantId, input.audit, fingerprint);
      if (replay) return this.findById(tx, input.namespace.tenantId, input.id);
      await tx
        .insertInto('agent_memory_entries')
        .values({
          id: input.id,
          tenant_id: input.namespace.tenantId,
          sponsor_principal_id: input.namespace.sponsorPrincipalId,
          scope_type: input.namespace.scopeType,
          scope_id: scopeId(input.namespace),
          purpose: input.namespace.purpose,
          memory_key: input.key,
          content: canonicalAgentJson(normalized),
          content_sha256: sha,
          resource_binding_sha256: resource.bindingSha256,
          provenance: canonicalAgentJson(provenance),
          version: 1,
          retention_expires_at: new Date(input.retentionExpiresAt),
          created_at: clock,
          updated_at: clock,
        })
        .execute();
      await this.event(
        tx,
        input.namespace,
        input.id,
        input.audit,
        'create',
        null,
        sha,
        fingerprint,
        'applied',
        clock,
        'user',
      );
      return this.findById(tx, input.namespace.tenantId, input.id);
    });
  }

  async correct(input: {
    tenantId: string;
    entryId: string;
    expectedVersion: number;
    content: AgentMemoryContent;
    retentionExpiresAt: string;
    audit: AgentMemoryAuditInput;
  }): Promise<AgentMemoryEntry | undefined> {
    return transaction(this.db, async (tx) => {
      await this.lockTenant(tx, input.tenantId);
      const row = await tx
        .selectFrom('agent_memory_entries')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.entryId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      if (row.sponsor_principal_id !== input.audit.actorPrincipalId)
        throw new Error('AGENT_MEMORY_ACTOR_DENIED');
      const namespace = rowToEntry(row).namespace;
      const clock = await now(tx);
      const resource = await this.resolveScope(tx, namespace);
      if (row.resource_binding_sha256 !== resource.bindingSha256)
        throw new Error('AGENT_MEMORY_RESOURCE_REBOUND');
      const normalized = normalizeAgentMemoryContent(input.content);
      const provenance = normalizeAgentMemoryProvenance(
        parse<AgentMemoryProvenance>(row.provenance),
      );
      const sha = validateAgentMemoryWrite({
        namespace,
        key: row.memory_key,
        content: normalized,
        provenance,
        retentionExpiresAt: input.retentionExpiresAt,
        now: clock.toISOString(),
      });
      const fingerprint = agentSha256({
        operation: 'correct',
        entryId: input.entryId,
        expectedVersion: input.expectedVersion,
        contentSha256: sha,
        retentionExpiresAt: input.retentionExpiresAt,
        actor: input.audit.actorPrincipalId,
        reason: input.audit.reasonCode,
        resourceAuthorizationSha256: resource.authorizationSha256,
      });
      await this.authorizeUser(tx, namespace, input.audit.actorPrincipalId);
      const replay = await this.replay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return this.findById(tx, input.tenantId, input.entryId);
      if (Number(row.version) !== input.expectedVersion)
        throw new Error('AGENT_MEMORY_VERSION_CONFLICT');
      await tx
        .updateTable('agent_memory_entries')
        .set({
          content: canonicalAgentJson(normalized),
          content_sha256: sha,
          retention_expires_at: new Date(input.retentionExpiresAt),
          version: input.expectedVersion + 1,
          updated_at: clock,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.entryId)
        .where('version', '=', input.expectedVersion)
        .execute();
      await this.event(
        tx,
        namespace,
        input.entryId,
        input.audit,
        'correct',
        row.content_sha256,
        sha,
        fingerprint,
        'applied',
        clock,
        'user',
      );
      return this.findById(tx, input.tenantId, input.entryId);
    });
  }

  async remove(input: {
    namespace: AgentMemoryNamespace;
    entryId: string;
    expectedVersion: number;
    audit: AgentMemoryAuditInput;
  }): Promise<boolean> {
    return transaction(this.db, async (tx) => {
      validateAgentMemoryNamespace(input.namespace);
      await this.lockTenant(tx, input.namespace.tenantId);
      const resource = await this.resolveScope(tx, input.namespace);
      const fingerprint = agentSha256({
        operation: 'delete',
        entryId: input.entryId,
        namespace: input.namespace,
        expectedVersion: input.expectedVersion,
        actor: input.audit.actorPrincipalId,
        reason: input.audit.reasonCode,
        resourceAuthorizationSha256: resource.authorizationSha256,
      });
      await this.authorizeUser(tx, input.namespace, input.audit.actorPrincipalId);
      const replay = await this.replay(tx, input.namespace.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      const row = await tx
        .selectFrom('agent_memory_entries')
        .selectAll()
        .where('tenant_id', '=', input.namespace.tenantId)
        .where('id', '=', input.entryId)
        .forUpdate()
        .executeTakeFirst();
      const clock = await now(tx);
      if (!row) {
        await this.event(
          tx,
          input.namespace,
          input.entryId,
          input.audit,
          'delete',
          null,
          null,
          fingerprint,
          'not_found',
          clock,
          'user',
        );
        return false;
      }
      const namespaceMatches =
        row.tenant_id === input.namespace.tenantId &&
        row.sponsor_principal_id === input.namespace.sponsorPrincipalId &&
        row.scope_type === input.namespace.scopeType &&
        row.scope_id === scopeId(input.namespace) &&
        row.purpose === input.namespace.purpose;
      if (!namespaceMatches) throw new Error('AGENT_MEMORY_NAMESPACE_MISMATCH');
      if (row.resource_binding_sha256 !== resource.bindingSha256)
        throw new Error('AGENT_MEMORY_RESOURCE_REBOUND');
      let integrityValid = true;
      try {
        rowToEntry(row);
      } catch {
        integrityValid = false;
      }
      if (Number(row.version) !== input.expectedVersion)
        throw new Error('AGENT_MEMORY_VERSION_CONFLICT');
      await tx
        .deleteFrom('agent_memory_entries')
        .where('tenant_id', '=', input.namespace.tenantId)
        .where('id', '=', input.entryId)
        .where('version', '=', input.expectedVersion)
        .execute();
      await this.event(
        tx,
        input.namespace,
        input.entryId,
        input.audit,
        integrityValid ? 'delete' : 'delete_corrupt',
        safeStoredSha(row.content_sha256),
        null,
        fingerprint,
        'applied',
        clock,
        'user',
      );
      return true;
    });
  }

  async inspect(
    namespace: AgentMemoryNamespace,
    audit: AgentMemoryAuditInput,
    operation: 'inspect' | 'export' = 'inspect',
  ): Promise<AgentMemoryEntry[]> {
    validateAgentMemoryNamespace(namespace);
    return transaction(this.db, async (tx) => {
      await this.lockTenant(tx, namespace.tenantId);
      const resource = await this.resolveScope(tx, namespace);
      await this.authorizeUser(tx, namespace, audit.actorPrincipalId);
      const clock = await now(tx);
      const rows = await tx
        .selectFrom('agent_memory_entries')
        .selectAll()
        .where('tenant_id', '=', namespace.tenantId)
        .where('sponsor_principal_id', '=', namespace.sponsorPrincipalId)
        .where('scope_type', '=', namespace.scopeType)
        .where('scope_id', '=', scopeId(namespace))
        .where('purpose', '=', namespace.purpose)
        .where('retention_expires_at', '>', clock)
        .orderBy('memory_key')
        .execute();
      if (rows.some((row) => row.resource_binding_sha256 !== resource.bindingSha256))
        throw new Error('AGENT_MEMORY_RESOURCE_REBOUND');
      const entries = rows.map(rowToEntry);
      const resultSha = agentSha256(rows.map((row) => ({ id: row.id, sha: row.content_sha256 })));
      const queryFingerprint = agentSha256({
        operation,
        namespace,
        actor: audit.actorPrincipalId,
        resultSha,
        resultCount: rows.length,
        resourceAuthorizationSha256: resource.authorizationSha256,
      });
      if (!(await this.replay(tx, namespace.tenantId, audit, queryFingerprint)))
        await this.event(
          tx,
          namespace,
          'namespace_query',
          audit,
          operation,
          null,
          resultSha,
          queryFingerprint,
          'applied',
          clock,
          'user',
        );
      for (const row of rows) {
        const itemAudit = {
          ...audit,
          id: `mem_evt_${ulid()}`,
          idempotencyKey: `memq_${agentSha256({
            domain: 'tixkit-agent-memory-query-item-v1',
            parentIdempotencyKey: audit.idempotencyKey,
            entryId: row.id,
          })}`,
        };
        const fingerprint = agentSha256({
          operation,
          entryId: row.id,
          contentSha256: row.content_sha256,
          actor: audit.actorPrincipalId,
        });
        if (!(await this.replay(tx, namespace.tenantId, itemAudit, fingerprint)))
          await this.event(
            tx,
            namespace,
            row.id,
            itemAudit,
            operation,
            row.content_sha256,
            row.content_sha256,
            fingerprint,
            'applied',
            clock,
            'user',
          );
      }
      return entries;
    });
  }

  async retrieveForAgent(input: {
    namespace: AgentMemoryNamespace;
    agentPrincipalId: string;
    delegationId: string;
    reasonCode: string;
    recommendationId: string;
  }): Promise<AgentMemoryEntry[]> {
    validateAgentMemoryNamespace(input.namespace);
    if (
      !ID.test(input.agentPrincipalId) ||
      !ID.test(input.delegationId) ||
      !ID.test(input.recommendationId) ||
      !TOKEN.test(input.reasonCode)
    )
      throw new Error('AGENT_MEMORY_RETRIEVAL_METADATA_INVALID');
    return transaction(this.db, async (tx) => {
      await this.lockTenant(tx, input.namespace.tenantId);
      const clock = await now(tx);
      const resource = await this.resolveScope(tx, input.namespace);
      let sponsorAuthorizationSha256: string;
      try {
        sponsorAuthorizationSha256 = await this.authorizeUser(
          tx,
          input.namespace,
          input.namespace.sponsorPrincipalId,
        );
      } catch {
        throw new Error('AGENT_MEMORY_RETRIEVAL_DENIED');
      }
      const principal = await tx
        .selectFrom('agent_principals')
        .selectAll()
        .where('tenant_id', '=', input.namespace.tenantId)
        .where('id', '=', input.agentPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      const delegation = await tx
        .selectFrom('agent_delegations')
        .selectAll()
        .where('tenant_id', '=', input.namespace.tenantId)
        .where('id', '=', input.delegationId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !principal ||
        principal.state !== 'active' ||
        principal.sponsor_principal_id !== input.namespace.sponsorPrincipalId ||
        !parse<string[]>(principal.capabilities).includes('memory.read') ||
        !delegation ||
        delegation.agent_principal_id !== principal.id ||
        delegation.revoked_at ||
        delegation.sponsor_principal_id !== input.namespace.sponsorPrincipalId ||
        new Date(delegation.issued_at) > clock ||
        new Date(delegation.expires_at) <= clock ||
        !parse<string[]>(delegation.capabilities).includes('memory.read') ||
        !parse<string[]>(delegation.resource_scopes).includes(
          input.namespace.scopeType === 'workspace'
            ? 'workspace:workspace'
            : `${input.namespace.scopeType}:${input.namespace.scopeId}`,
        )
      )
        throw new Error('AGENT_MEMORY_RETRIEVAL_DENIED');
      const rows = await tx
        .selectFrom('agent_memory_entries')
        .selectAll()
        .where('tenant_id', '=', input.namespace.tenantId)
        .where('sponsor_principal_id', '=', input.namespace.sponsorPrincipalId)
        .where('scope_type', '=', input.namespace.scopeType)
        .where('scope_id', '=', scopeId(input.namespace))
        .where('purpose', '=', input.namespace.purpose)
        .where('retention_expires_at', '>', clock)
        .orderBy('memory_key')
        .execute();
      if (rows.some((row) => row.resource_binding_sha256 !== resource.bindingSha256))
        throw new Error('AGENT_MEMORY_RETRIEVAL_DENIED');
      const entries = rows.map(rowToEntry);
      const resultSha = agentSha256(rows.map((row) => ({ id: row.id, sha: row.content_sha256 })));
      const queryAudit = {
        id: `mem_evt_${ulid()}`,
        actorPrincipalId: input.agentPrincipalId,
        reasonCode: input.reasonCode,
        idempotencyKey: `memory-retrieve:${input.recommendationId}:namespace`,
      };
      const queryFingerprint = agentSha256({
        operation: 'retrieve',
        namespace: input.namespace,
        recommendationId: input.recommendationId,
        delegationId: input.delegationId,
        sponsorAuthorizationSha256,
        resultSha,
        resultCount: rows.length,
        resourceAuthorizationSha256: resource.authorizationSha256,
      });
      if (!(await this.replay(tx, input.namespace.tenantId, queryAudit, queryFingerprint)))
        await this.event(
          tx,
          input.namespace,
          'namespace_query',
          queryAudit,
          'retrieve',
          null,
          resultSha,
          queryFingerprint,
          'applied',
          clock,
          'agent',
          {
            delegationId: input.delegationId,
            useId: input.recommendationId,
            authorizationSha256: sponsorAuthorizationSha256,
          },
        );
      for (const row of rows) {
        const audit = {
          id: `mem_evt_${ulid()}`,
          actorPrincipalId: input.agentPrincipalId,
          reasonCode: input.reasonCode,
          idempotencyKey: `memory-retrieve:${input.recommendationId}:${row.id}`,
        };
        const fingerprint = agentSha256({
          operation: 'retrieve',
          entryId: row.id,
          recommendationId: input.recommendationId,
          delegationId: input.delegationId,
          contentSha256: row.content_sha256,
          sponsorAuthorizationSha256,
        });
        if (!(await this.replay(tx, input.namespace.tenantId, audit, fingerprint)))
          await this.event(
            tx,
            input.namespace,
            row.id,
            audit,
            'retrieve',
            row.content_sha256,
            row.content_sha256,
            fingerprint,
            'applied',
            clock,
            'agent',
            {
              delegationId: input.delegationId,
              useId: input.recommendationId,
              authorizationSha256: sponsorAuthorizationSha256,
            },
          );
      }
      return entries;
    });
  }

  async sweepExpired(limit = 100): Promise<number> {
    return transaction(this.db, async (tx) => {
      const clock = await now(tx);
      const rows = await tx
        .selectFrom('agent_memory_entries')
        .selectAll()
        .where('retention_expires_at', '<=', clock)
        .orderBy('retention_expires_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        const namespace = {
          tenantId: row.tenant_id,
          sponsorPrincipalId: row.sponsor_principal_id,
          scopeType: row.scope_type as AgentMemoryNamespace['scopeType'],
          ...(row.scope_type === 'workspace' ? {} : { scopeId: row.scope_id }),
          purpose: row.purpose as AgentMemoryNamespace['purpose'],
        };
        let integrityValid = true;
        try {
          rowToEntry(row);
        } catch {
          integrityValid = false;
        }
        await tx.deleteFrom('agent_memory_entries').where('id', '=', row.id).execute();
        const audit = {
          id: `mem_evt_${ulid()}`,
          actorPrincipalId: 'system_retention',
          reasonCode: 'RETENTION_EXPIRED',
          idempotencyKey: `memory-retention:${row.id}:${iso(row.retention_expires_at)}`,
        };
        await this.event(
          tx,
          namespace,
          row.id,
          audit,
          integrityValid ? 'expire' : 'expire_corrupt',
          safeStoredSha(row.content_sha256),
          null,
          agentSha256({ operation: 'expire', id: row.id, sha: safeStoredSha(row.content_sha256) }),
          'applied',
          clock,
          'system',
        );
      }
      return rows.length;
    });
  }

  private async authorizeUser(
    db: Executor,
    namespace: AgentMemoryNamespace,
    actorPrincipalId: string,
  ): Promise<string> {
    const user = await db
      .selectFrom('user_profiles')
      .select(['id', 'status'])
      .where('tenant_id', '=', namespace.tenantId)
      .where('id', '=', actorPrincipalId)
      .forUpdate()
      .executeTakeFirst();
    const permission = namespace.scopeType === 'event' ? 'events.write' : 'settings.write';
    const grants = await db
      .selectFrom('permission_grants')
      .selectAll()
      .where('tenant_id', '=', namespace.tenantId)
      .where('principal_type', '=', 'user')
      .where('principal_id', '=', actorPrincipalId)
      .where('permission', 'in', [permission, 'developers.write'])
      .forUpdate()
      .execute();
    const allowed =
      grants.some(
        (grant) =>
          grant.permission === 'developers.write' &&
          grant.scope_type === 'tenant' &&
          grant.scope_id === null,
      ) ||
      (actorPrincipalId === namespace.sponsorPrincipalId &&
        grants.some(
          (grant) =>
            grant.permission === permission &&
            (grant.scope_type === 'tenant' ||
              (namespace.scopeType === 'event' &&
                grant.scope_type === 'event' &&
                grant.scope_id === namespace.scopeId)),
        ));
    if (!user || user.status !== 'active' || !allowed) throw new Error('AGENT_MEMORY_ACTOR_DENIED');
    return agentSha256({
      userId: user.id,
      status: user.status,
      grants: grants
        .map((grant) => ({
          id: grant.id,
          permission: grant.permission,
          scopeType: grant.scope_type,
          scopeId: grant.scope_id,
          updatedAt: iso(grant.updated_at),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  private async resolveScope(
    db: Executor,
    namespace: AgentMemoryNamespace,
  ): Promise<{
    bindingSha256: string;
    authorizationSha256: string;
  }> {
    validateAgentMemoryNamespace(namespace);
    if (namespace.scopeType === 'project')
      throw new Error('AGENT_MEMORY_PROJECT_SCOPE_UNAVAILABLE');
    if (namespace.scopeType === 'workspace') {
      const tenant = await db
        .selectFrom('tenants')
        .select(['id', 'status', 'created_at', 'updated_at'])
        .where('id', '=', namespace.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!tenant) throw new Error('AGENT_MEMORY_SCOPE_NOT_FOUND');
      const bindingSha256 = agentSha256({
        type: 'workspace',
        id: tenant.id,
        createdAt: iso(tenant.created_at),
      });
      return {
        bindingSha256,
        authorizationSha256: agentSha256({
          bindingSha256,
          status: tenant.status,
          updatedAt: iso(tenant.updated_at),
        }),
      };
    }
    const event = await db
      .selectFrom('events')
      .select(['id', 'status', 'version', 'created_at'])
      .where('tenant_id', '=', namespace.tenantId)
      .where('id', '=', namespace.scopeId!)
      .forUpdate()
      .executeTakeFirst();
    if (!event) throw new Error('AGENT_MEMORY_SCOPE_NOT_FOUND');
    const bindingSha256 = agentSha256({
      type: 'event',
      id: event.id,
      createdAt: iso(event.created_at),
    });
    return {
      bindingSha256,
      authorizationSha256: agentSha256({
        bindingSha256,
        status: event.status,
        version: Number(event.version),
      }),
    };
  }

  private assertUserProvenance(provenance: AgentMemoryProvenance, actorPrincipalId: string): void {
    if (provenance.type === 'agent_observation' || provenance.actorPrincipalId !== actorPrincipalId)
      throw new Error('AGENT_MEMORY_PROVENANCE_ACTOR_MISMATCH');
  }

  private async lockTenant(db: Executor, tenantId: string): Promise<void> {
    if (
      !(await db
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', tenantId)
        .forUpdate()
        .executeTakeFirst())
    )
      throw new Error('AGENT_MEMORY_TENANT_NOT_FOUND');
  }
  private async replay(
    db: Executor,
    tenantId: string,
    audit: AgentMemoryAuditInput,
    fingerprint: string,
  ): Promise<string | undefined> {
    const row = await db
      .selectFrom('agent_memory_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', audit.idempotencyKey)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return undefined;
    if (
      row.request_fingerprint !== fingerprint ||
      row.actor_principal_id !== audit.actorPrincipalId
    )
      throw new Error('AGENT_MEMORY_IDEMPOTENCY_CONFLICT');
    return row.outcome;
  }
  private async findById(
    db: Executor,
    tenantId: string,
    id: string,
  ): Promise<AgentMemoryEntry | undefined> {
    const row = await db
      .selectFrom('agent_memory_entries')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToEntry(row) : undefined;
  }
  private async event(
    db: Executor,
    namespace: AgentMemoryNamespace,
    entryId: string,
    audit: AgentMemoryAuditInput,
    operation: string,
    previousSha: string | null,
    newSha: string | null,
    fingerprint: string,
    outcome: string,
    clock: Date,
    actorType: string,
    agentUse?: { delegationId: string; useId: string; authorizationSha256: string },
  ): Promise<void> {
    if (
      !ID.test(audit.id) ||
      !ID.test(audit.actorPrincipalId) ||
      !TOKEN.test(audit.reasonCode) ||
      audit.idempotencyKey.length < 16 ||
      audit.idempotencyKey.length > 255
    )
      throw new Error('AGENT_MEMORY_AUDIT_INVALID');
    if (
      (previousSha !== null && !SHA256.test(previousSha)) ||
      (newSha !== null && !SHA256.test(newSha))
    )
      throw new Error('AGENT_MEMORY_AUDIT_DIGEST_INVALID');
    await db
      .insertInto('agent_memory_events')
      .values({
        id: audit.id,
        tenant_id: namespace.tenantId,
        sponsor_principal_id: namespace.sponsorPrincipalId,
        scope_type: namespace.scopeType,
        scope_id: scopeId(namespace),
        purpose: namespace.purpose,
        entry_id: entryId,
        actor_type: actorType,
        actor_principal_id: audit.actorPrincipalId,
        delegation_id: agentUse?.delegationId ?? null,
        use_id: agentUse?.useId ?? null,
        authorization_sha256: agentUse?.authorizationSha256 ?? null,
        operation,
        previous_sha256: previousSha,
        new_sha256: newSha,
        reason_code: audit.reasonCode,
        idempotency_key: audit.idempotencyKey,
        request_fingerprint: fingerprint,
        outcome,
        occurred_at: clock,
      })
      .execute();
  }
}
