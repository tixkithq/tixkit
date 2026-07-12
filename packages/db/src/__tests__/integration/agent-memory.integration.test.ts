import { AGENT_PROTOCOL_VERSION, type AgentMemoryNamespace } from '@tixkit/agent-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { AgentMemoryRepository, BrandRepository, EventRepository, OrganizationRepository,
  TenantRepository } from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const cases = [{ driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' }]
  .filter((item) => item.url && (!requestedDriver || item.driver === requestedDriver)) as DriverCase[];
if (cases.length === 0) it.skip('agent memory integration (database URLs not configured)', () => {});

describe.sequential.each(cases)('agent memory lifecycle: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let eventId: string;
  let organizationId: string;
  let brandId: string;
  const scopedEvents: Record<string, string> = {};
  const namespace = (): AgentMemoryNamespace => ({ tenantId, sponsorPrincipalId: 'user_sponsor',
    scopeType: 'event', scopeId: eventId, purpose: 'organizer_preferences' });
  const audit = (id: string) => ({ id, actorPrincipalId: 'user_sponsor',
    reasonCode: 'ORGANIZER_REQUEST', idempotencyKey: `agent-memory-${id}-2026` });
  const provenance = () => ({ type: 'organizer' as const, actorPrincipalId: 'user_sponsor',
    observedAt: new Date(Date.now() - 5_000).toISOString() });

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (await new TenantRepository(db).create({ name: `Memory ${driver}` })).id;
    const organization = await new OrganizationRepository(db).create({ tenantId,
      name: `Memory Organization ${driver}`, slug: `memory-organization-${driver}` });
    const brand = await new BrandRepository(db).create({ tenantId, organizationId: organization.id,
      name: `Memory Brand ${driver}`, slug: `memory-brand-${driver}` });
    organizationId = organization.id;
    brandId = brand.id;
    eventId = (await new EventRepository(db).create({ tenantId, organizationId: organization.id,
      brandId: brand.id, slug: `memory-event-${driver}`, title: `Memory Event ${driver}`,
      currency: 'USD', timezone: 'America/Chicago', startsAt: new Date('2027-01-01T18:00:00Z') })).id;
    for (const suffix of ['empty', 'malformed', 'digest', 'extra_key', 'non_canonical']) {
      scopedEvents[suffix] = (await new EventRepository(db).create({ tenantId,
        organizationId: organization.id, brandId: brand.id, slug: `memory-${suffix}-${driver}`,
        title: `Memory ${suffix} ${driver}`, currency: 'USD', timezone: 'America/Chicago',
        startsAt: new Date('2027-01-01T18:00:00Z') })).id;
    }
    const now = new Date();
    await db.insertInto('user_profiles').values({ id: 'user_sponsor', tenant_id: tenantId,
      clerk_user_id: `clerk_memory_${driver}`, email: `memory-${driver}@example.test`,
      first_name: null, last_name: null, avatar_url: null, status: 'active', last_seen_at: null,
      created_at: now, updated_at: now }).execute();
    await db.insertInto('permission_grants').values({ id: 'pg_memory', tenant_id: tenantId,
      principal_type: 'user', principal_id: 'user_sponsor', permission: 'events.write',
      scope_type: 'event', scope_id: eventId, created_at: now, updated_at: now }).execute();
    await db.insertInto('permission_grants').values({ id: 'pg_memory_tenant', tenant_id: tenantId,
      principal_type: 'user', principal_id: 'user_sponsor', permission: 'events.write',
      scope_type: 'tenant', scope_id: null, created_at: now, updated_at: now }).execute();
    await db.insertInto('permission_grants').values({ id: 'pg_memory_settings', tenant_id: tenantId,
      principal_type: 'user', principal_id: 'user_sponsor', permission: 'settings.write',
      scope_type: 'tenant', scope_id: null, created_at: now, updated_at: now }).execute();
    await db.insertInto('agent_principals').values({ id: 'agent_memory', tenant_id: tenantId,
      kind: 'third_party', sponsor_principal_id: 'user_sponsor',
      capabilities: JSON.stringify(['memory.read']), maximum_autonomy: 'read',
      protocol_version: AGENT_PROTOCOL_VERSION, state: 'active', registered_at: now, updated_at: now })
      .execute();
    await db.insertInto('agent_delegations').values({ id: 'delegation_memory', tenant_id: tenantId,
      agent_principal_id: 'agent_memory', sponsor_principal_id: 'user_sponsor',
      capabilities: JSON.stringify(['memory.read']), resource_scopes: JSON.stringify([`event:${eventId}`]),
      permission_snapshot: JSON.stringify(['events:read']), issued_at: new Date(now.getTime() - 5_000),
      expires_at: new Date(now.getTime() + 3_600_000), revoked_at: null, created_at: now }).execute();
  });
  afterAll(async () => { await db?.destroy(); });

  it('creates, inspects, corrects, exports, retrieves and physically deletes with digest-only audit', async () => {
    const memory = new AgentMemoryRepository(db);
    const createInput = { id: 'memory_primary', namespace: namespace(), key: 'tone.default',
      content: { kind: 'organizer_preferences' as const, summary: 'Prefer a warm concise tone',
        tone: 'warm' as const, verbosity: 'brief' as const }, provenance: provenance(),
      retentionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      audit: audit('create_primary') };
    const creates = await Promise.all(Array.from({ length: 8 }, () => memory.create(createInput)));
    expect(new Set(creates.map((entry) => entry?.id))).toEqual(new Set(['memory_primary']));
    expect((await memory.inspect(namespace(), audit('inspect_primary')))[0]?.content)
      .toMatchObject({ tone: 'warm' });
    const corrected = await memory.correct({ tenantId, entryId: 'memory_primary', expectedVersion: 1,
      content: { ...createInput.content, summary: 'Prefer a direct concise tone', tone: 'direct' },
      retentionExpiresAt: createInput.retentionExpiresAt,
      audit: audit('correct_primary') });
    expect(corrected).toMatchObject({ version: 2, content: { tone: 'direct' } });
    await expect(memory.correct({ tenantId, entryId: 'memory_primary', expectedVersion: 1,
      content: createInput.content,
      retentionExpiresAt: createInput.retentionExpiresAt,
      audit: audit('correct_stale') })).rejects.toThrow('AGENT_MEMORY_VERSION_CONFLICT');
    expect(await memory.retrieveForAgent({ namespace: namespace(), agentPrincipalId: 'agent_memory',
      delegationId: 'delegation_memory', reasonCode: 'RECOMMENDATION_CONTEXT',
      recommendationId: 'recommendation_primary' })).toHaveLength(1);
    expect(await memory.inspect(namespace(), audit('export_primary'), 'export')).toHaveLength(1);
    await expect(memory.remove({ namespace: namespace(), entryId: 'memory_primary', expectedVersion: 2,
      audit: audit('delete_primary') })).resolves.toBe(true);
    expect(await db.selectFrom('agent_memory_entries').select('id').execute()).toHaveLength(0);
    const events = await db.selectFrom('agent_memory_events').selectAll()
      .where('tenant_id', '=', tenantId).execute();
    expect(events.map(({ operation }) => operation)).toEqual(expect.arrayContaining([
      'create', 'inspect', 'correct', 'retrieve', 'export', 'delete',
    ]));
    expect(JSON.stringify(events)).not.toContain('direct concise');
    await expect(db.updateTable('agent_memory_events').set({ reason_code: 'TAMPERED' })
      .where('entry_id', '=', 'memory_primary').execute()).rejects.toThrow(/immutable/u);
    await expect(db.deleteFrom('agent_memory_events').where('entry_id', '=', 'memory_primary').execute())
      .rejects.toThrow(/immutable/u);
  });

  it('expires content using separate retention while preserving only digest audit', async () => {
    const memory = new AgentMemoryRepository(db);
    await memory.create({ id: 'memory_expired', namespace: namespace(), key: 'locale.default',
      content: { kind: 'organizer_preferences', summary: 'Use US English', locale: 'en-US' },
      provenance: provenance(), retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      audit: audit('create_expired') });
    await db.updateTable('agent_memory_entries').set({
      updated_at: new Date(Date.now() - 2_000),
      retention_expires_at: new Date(Date.now() - 1_000),
    })
      .where('id', '=', 'memory_expired').execute();
    await expect(memory.sweepExpired()).resolves.toBe(1);
    expect(await db.selectFrom('agent_memory_entries').select('id')
      .where('id', '=', 'memory_expired').execute()).toHaveLength(0);
    expect(await db.selectFrom('agent_memory_events').select(['operation', 'previous_sha256', 'new_sha256'])
      .where('entry_id', '=', 'memory_expired').where('operation', '=', 'expire')
      .executeTakeFirstOrThrow()).toMatchObject({ operation: 'expire', new_sha256: null });
  });

  it('binds event scopes to tenant ownership and immutable resource identity', async () => {
    const memory = new AgentMemoryRepository(db);
    const missing = { ...namespace(), scopeId: 'evt_missing' };
    await expect(memory.inspect(missing, audit('inspect_missing')))
      .rejects.toThrow('AGENT_MEMORY_SCOPE_NOT_FOUND');
    const foreignTenant = await new TenantRepository(db).create({ name: `Foreign Memory ${driver}` });
    const foreignOrganization = await new OrganizationRepository(db).create({ tenantId: foreignTenant.id,
      name: `Foreign Organization ${driver}`, slug: `foreign-memory-organization-${driver}` });
    const foreignBrand = await new BrandRepository(db).create({ tenantId: foreignTenant.id,
      organizationId: foreignOrganization.id, name: `Foreign Brand ${driver}`,
      slug: `foreign-memory-brand-${driver}` });
    const foreignEvent = await new EventRepository(db).create({ tenantId: foreignTenant.id,
      organizationId: foreignOrganization.id, brandId: foreignBrand.id,
      slug: `foreign-memory-event-${driver}`, title: `Foreign Memory Event ${driver}`,
      currency: 'USD', timezone: 'America/Chicago', startsAt: new Date('2027-01-01T18:00:00Z') });
    await expect(memory.inspect({ ...namespace(), scopeId: foreignEvent.id },
      audit('inspect_foreign'))).rejects.toThrow('AGENT_MEMORY_SCOPE_NOT_FOUND');
    const rebound = await new EventRepository(db).create({ tenantId, organizationId, brandId,
      slug: `memory-rebound-${driver}`, title: `Memory Rebound ${driver}`, currency: 'USD',
      timezone: 'America/Chicago', startsAt: new Date('2027-01-01T18:00:00Z') });
    const reboundNamespace = { ...namespace(), scopeId: rebound.id };
    await memory.create({ id: 'memory_rebound', namespace: reboundNamespace, key: 'tone.rebound',
      content: { kind: 'organizer_preferences', summary: 'Prefer a warm tone', tone: 'warm' },
      provenance: provenance(), retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      audit: audit('create_rebound') });
    const persisted = await db.selectFrom('events').selectAll().where('id', '=', rebound.id)
      .executeTakeFirstOrThrow();
    await db.deleteFrom('events').where('id', '=', rebound.id).execute();
    await db.insertInto('events').values({ ...persisted,
      seo: typeof persisted.seo === 'string' ? persisted.seo : JSON.stringify(persisted.seo),
      venue: persisted.venue === null || typeof persisted.venue === 'string'
        ? persisted.venue : JSON.stringify(persisted.venue),
      created_at: new Date(Date.now() + 86_400_000), updated_at: new Date() }).execute();
    await expect(memory.inspect(reboundNamespace, audit('inspect_rebound')))
      .rejects.toThrow('AGENT_MEMORY_RESOURCE_REBOUND');
  });

  it('permanently replays an authorized absent-delete outcome without deleting later content', async () => {
    const memory = new AgentMemoryRepository(db);
    const absentAudit = audit('delete_absent');
    await expect(memory.remove({ namespace: namespace(), entryId: 'memory_later', expectedVersion: 1,
      audit: absentAudit })).resolves.toBe(false);
    await memory.create({ id: 'memory_later', namespace: namespace(), key: 'verbosity.default',
      content: { kind: 'organizer_preferences', summary: 'Prefer standard detail',
        verbosity: 'standard' }, provenance: provenance(),
      retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      audit: audit('create_later') });
    await expect(memory.remove({ namespace: namespace(), entryId: 'memory_later', expectedVersion: 1,
      audit: absentAudit })).resolves.toBe(false);
    expect(await db.selectFrom('agent_memory_entries').select('id').where('id', '=', 'memory_later')
      .execute()).toHaveLength(1);
  });

  it('denies workspace, future, and wrong-sponsor delegation retrieval', async () => {
    const memory = new AgentMemoryRepository(db);
    const workspace: AgentMemoryNamespace = { tenantId, sponsorPrincipalId: 'user_sponsor',
      scopeType: 'workspace', purpose: 'organizer_preferences' };
    await memory.create({ id: 'memory_workspace', namespace: workspace, key: 'tone.workspace',
      content: { kind: 'organizer_preferences', summary: 'Prefer a formal tone', tone: 'formal' },
      provenance: provenance(), retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      audit: audit('create_workspace') });
    const retrieve = () => memory.retrieveForAgent({ namespace: workspace,
      agentPrincipalId: 'agent_memory', delegationId: 'delegation_memory',
      reasonCode: 'RECOMMENDATION_CONTEXT', recommendationId: 'recommendation_workspace' });
    await expect(retrieve()).rejects.toThrow('AGENT_MEMORY_RETRIEVAL_DENIED');
    await db.updateTable('agent_delegations').set({ resource_scopes: JSON.stringify(['workspace:workspace']),
      issued_at: new Date(Date.now() + 60_000) }).where('id', '=', 'delegation_memory').execute();
    await expect(retrieve()).rejects.toThrow('AGENT_MEMORY_RETRIEVAL_DENIED');
    await db.updateTable('agent_delegations').set({ issued_at: new Date(Date.now() - 60_000),
      sponsor_principal_id: 'user_other' }).where('id', '=', 'delegation_memory').execute();
    await expect(retrieve()).rejects.toThrow('AGENT_MEMORY_RETRIEVAL_DENIED');
    await db.updateTable('agent_delegations').set({ sponsor_principal_id: 'user_sponsor',
      resource_scopes: JSON.stringify([`event:${scopedEvents.empty}`]) })
      .where('id', '=', 'delegation_memory').execute();
  });

  it('audits empty inspection, export, and agent retrieval with namespace result digests', async () => {
    const memory = new AgentMemoryRepository(db);
    const empty = { ...namespace(), scopeId: scopedEvents.empty };
    await expect(memory.inspect(empty, audit('inspect_empty'))).resolves.toEqual([]);
    await expect(memory.inspect(empty, audit('export_empty'), 'export')).resolves.toEqual([]);
    await expect(memory.retrieveForAgent({ namespace: empty, agentPrincipalId: 'agent_memory',
      delegationId: 'delegation_memory', reasonCode: 'RECOMMENDATION_CONTEXT',
      recommendationId: 'recommendation_empty' })).resolves.toEqual([]);
    const queryEvents = await db.selectFrom('agent_memory_events')
      .select(['operation', 'delegation_id', 'use_id']).where('entry_id', '=', 'namespace_query')
      .where('scope_id', '=', scopedEvents.empty!).execute();
    expect(queryEvents).toHaveLength(3);
    expect(queryEvents.find(({ operation }) => operation === 'retrieve')).toMatchObject({
      delegation_id: 'delegation_memory', use_id: 'recommendation_empty',
    });
  });

  it('rechecks the active sponsor and current permission grants for every agent retrieval', async () => {
    const memory = new AgentMemoryRepository(db);
    const empty = { ...namespace(), scopeId: scopedEvents.empty };
    const retrieve = (recommendationId: string) => memory.retrieveForAgent({ namespace: empty,
      agentPrincipalId: 'agent_memory', delegationId: 'delegation_memory',
      reasonCode: 'RECOMMENDATION_CONTEXT', recommendationId });
    await db.updateTable('user_profiles').set({ status: 'suspended', updated_at: new Date() })
      .where('id', '=', 'user_sponsor').execute();
    await expect(retrieve('recommendation_suspended'))
      .rejects.toThrow('AGENT_MEMORY_RETRIEVAL_DENIED');
    await db.updateTable('user_profiles').set({ status: 'active', updated_at: new Date() })
      .where('id', '=', 'user_sponsor').execute();
    await db.deleteFrom('permission_grants').where('principal_id', '=', 'user_sponsor').execute();
    await expect(retrieve('recommendation_permission_removed'))
      .rejects.toThrow('AGENT_MEMORY_RETRIEVAL_DENIED');
    const now = new Date();
    await db.insertInto('permission_grants').values({ id: 'pg_memory_restore', tenant_id: tenantId,
      principal_type: 'user', principal_id: 'user_sponsor', permission: 'events.write',
      scope_type: 'tenant', scope_id: null, created_at: now, updated_at: now }).execute();
    await expect(retrieve('recommendation_permission_restored')).resolves.toEqual([]);
  });

  it.each([
    ['malformed', '{'],
    ['digest', '{"kind":"organizer_preferences","summary":"Changed safely"}'],
    ['extra_key', '{"apiToken":"secret","kind":"organizer_preferences","summary":"Unsafe"}'],
    ['non_canonical', '{ "kind": "organizer_preferences", "summary": "Safe" }'],
  ])('fails closed on %s persisted content corruption', async (suffix, persistedContent) => {
    const memory = new AgentMemoryRepository(db);
    const scoped = { ...namespace(), scopeId: scopedEvents[suffix] };
    const id = `memory_${suffix}`;
    await memory.create({ id, namespace: scoped, key: 'tone.default',
      content: { kind: 'organizer_preferences', summary: 'Prefer a direct tone', tone: 'direct' },
      provenance: provenance(), retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      audit: audit(`create_${suffix}`) });
    await db.updateTable('agent_memory_entries').set({ content: persistedContent })
      .where('id', '=', id).execute();
    await expect(memory.inspect(scoped, audit(`inspect_${suffix}`)))
      .rejects.toThrow('AGENT_MEMORY_INTEGRITY_INVALID');
  });

  it('physically deletes and expires corrupt rows without exposing their content', async () => {
    const memory = new AgentMemoryRepository(db);
    await db.updateTable('agent_memory_entries').set({ content_sha256: 'buyer@example.test' })
      .where('id', '=', 'memory_malformed').execute();
    await expect(memory.remove({ namespace: { ...namespace(), scopeId: scopedEvents.malformed },
      entryId: 'memory_malformed', expectedVersion: 1,
      audit: audit('delete_corrupt') })).resolves.toBe(true);
    await db.updateTable('agent_memory_entries').set({
      content_sha256: 'sk_live_must_never_reach_audit',
      updated_at: new Date(Date.now() - 2_000),
      retention_expires_at: new Date(Date.now() - 1_000),
    }).where('id', '=', 'memory_digest').execute();
    await expect(memory.sweepExpired()).resolves.toBe(1);
    expect(await db.selectFrom('agent_memory_entries').select('id')
      .where('id', 'in', ['memory_malformed', 'memory_digest']).execute()).toHaveLength(0);
    const cleanupEvents = await db.selectFrom('agent_memory_events')
      .select(['operation', 'previous_sha256']).where('operation', 'in',
        ['delete_corrupt', 'expire_corrupt']).execute();
    expect(cleanupEvents).toHaveLength(2);
    expect(cleanupEvents.every(({ previous_sha256 }) => /^[a-f0-9]{64}$/u.test(previous_sha256!)))
      .toBe(true);
    expect(JSON.stringify(cleanupEvents)).not.toContain('buyer@example.test');
    expect(JSON.stringify(cleanupEvents)).not.toContain('sk_live_');
  });
});
