import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  OrganizationRepository,
  TenantRepository,
  WebhookEventRepository,
  WebhookReplayRequestRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
];
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver
    ? allDriverCases.filter((entry) => entry.driver === requestedDriver)
    : allDriverCases
).filter((entry) => entry.url.length > 0);

if (driverCases.length === 0) {
  it.skip('webhook replay request integration (skipped: no PostgreSQL/MySQL URL)', () => {});
}

describe.sequential.each(driverCases)(
  'webhook replay request integration: $driver',
  ({ driver, url }) => {
    let db: Database;
    let previousDriver: string | undefined;
    let tenantId: string;
    let organizationId: string;
    let eventId: string;

    beforeAll(async () => {
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
    }, 120_000);

    beforeEach(async () => {
      await truncateAllData(db);
      const tenant = await new TenantRepository(db).create({ name: 'Webhook Replay Tenant' });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: 'Webhook Replay Organization',
        slug: `webhook-replay-${driver}`,
      });
      const event = await new WebhookEventRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        type: 'order.paid',
        payload: { orderId: 'ord_replay' },
      });
      tenantId = tenant.id;
      organizationId = organization.id;
      eventId = event.id;
    }, 60_000);

    afterAll(async () => {
      await db?.destroy();
      if (previousDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previousDriver;
    }, 60_000);

    function reserveInput(key: string, requestSha256 = 'a'.repeat(64)) {
      return {
        tenantId,
        organizationId,
        eventId,
        idempotencyKeySha256: createHash('sha256').update(key).digest('hex'),
        requestSha256,
        endpointIds: ['wh_z', 'wh_a'].sort(),
        response: { queued: true, eventId, endpoints: 2 },
        audit: {
          actorType: 'user',
          actorId: 'usr_replay',
          action: 'webhook_event.replay_requested',
          diffSummary: { replayScope: 'organization', queuedEndpointCount: 2 },
        },
      };
    }

    it('atomically reserves, replays, and completes one durable request', async () => {
      const repository = new WebhookReplayRequestRepository(db);
      const first = await repository.reserve(reserveInput('durable-key'));
      const replay = await repository.reserve(reserveInput('durable-key'));

      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.request.id).toBe(first.request.id);
      expect(JSON.parse(first.request.endpoint_ids_json)).toEqual(['wh_a', 'wh_z']);
      expect(JSON.stringify(first.request)).not.toContain('durable-key');

      const otherOrganization = await new OrganizationRepository(db).create({
        tenantId,
        name: 'Wrong Replay Organization',
        slug: `wrong-webhook-replay-${driver}`,
      });
      await repository.complete({
        id: first.request.id,
        tenantId,
        organizationId: otherOrganization.id,
        actorType: 'user',
        actorId: 'usr_replay',
      });
      expect(
        (await repository.findByKeyHash(tenantId, first.request.idempotency_key_sha256))?.status,
      ).toBe('prepared');

      await expect(
        repository.complete({
          id: first.request.id,
          tenantId,
          organizationId,
          actorType: 'user',
          actorId: 'usr_replay',
          userAgent: 'x'.repeat(10_000),
        }),
      ).rejects.toThrow();
      expect(
        (await repository.findByKeyHash(tenantId, first.request.idempotency_key_sha256))?.status,
      ).toBe('prepared');
      expect(
        await db
          .selectFrom('audit_logs')
          .select('id')
          .where('resource_id', '=', first.request.id)
          .execute(),
      ).toHaveLength(1);

      await repository.complete({
        id: first.request.id,
        tenantId,
        organizationId,
        actorType: 'user',
        actorId: 'usr_replay',
      });
      await repository.complete({
        id: first.request.id,
        tenantId,
        organizationId,
        actorType: 'user',
        actorId: 'usr_replay',
      });

      const stored = await repository.findByKeyHash(
        tenantId,
        reserveInput('durable-key').idempotencyKeySha256,
      );
      expect(stored?.status).toBe('completed');
      const audits = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('resource_id', '=', first.request.id)
        .orderBy('created_at', 'asc')
        .execute();
      expect(audits.map((audit) => audit.action)).toEqual([
        'webhook_event.replay_requested',
        'webhook_event.replay_queued',
      ]);
    });

    it('rejects tenant, organization, and event scope substitution atomically', async () => {
      const otherTenant = await new TenantRepository(db).create({ name: 'Other Replay Tenant' });
      const otherOrganization = await new OrganizationRepository(db).create({
        tenantId: otherTenant.id,
        name: 'Other Replay Organization',
        slug: `other-webhook-replay-${driver}`,
      });
      const input = reserveInput('scope-substitution');
      const repository = new WebhookReplayRequestRepository(db);
      await expect(
        repository.reserve({ ...input, organizationId: otherOrganization.id }),
      ).rejects.toThrow();
      await expect(
        repository.findByKeyHash(tenantId, input.idempotencyKeySha256),
      ).resolves.toBeUndefined();
      expect(
        await db
          .selectFrom('audit_logs')
          .select('id')
          .where('resource_type', '=', 'WebhookReplayRequest')
          .execute(),
      ).toHaveLength(0);
    });

    it('rolls back the replay intent when the requested audit cannot be stored', async () => {
      const repository = new WebhookReplayRequestRepository(db);
      const input = reserveInput('audit-failure');
      await expect(
        repository.reserve({
          ...input,
          audit: { ...input.audit, userAgent: 'x'.repeat(10_000) },
        }),
      ).rejects.toThrow();
      await expect(
        repository.findByKeyHash(tenantId, input.idempotencyKeySha256),
      ).resolves.toBeUndefined();
    });

    it('converges concurrent identical reservations to one intent and one requested audit', async () => {
      const repository = new WebhookReplayRequestRepository(db);
      const input = reserveInput('concurrent-key');
      const reservations = await Promise.all([
        repository.reserve(input),
        repository.reserve(input),
        repository.reserve(input),
      ]);
      expect(new Set(reservations.map(({ request }) => request.id)).size).toBe(1);
      expect(reservations.filter(({ created }) => created)).toHaveLength(1);
      const requestId = reservations[0]!.request.id;
      const audits = await db
        .selectFrom('audit_logs')
        .select('id')
        .where('resource_id', '=', requestId)
        .execute();
      expect(audits).toHaveLength(1);
    });
  },
);
