import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  OrganizationRepository,
  ProviderIncidentCapacityError,
  ProviderIncidentEvidenceRepository,
  TenantRepository,
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
  it.skip('provider incident evidence integration (skipped: no PostgreSQL/MySQL URL)', () => {});
}

describe.sequential.each(driverCases)(
  'provider incident evidence integration: $driver',
  ({ driver, url }) => {
    let db: Database;
    let tenantId: string;
    let organizationId: string;
    const capturedAt = new Date('2026-07-16T12:00:00.000Z');

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
    }, 120_000);

    beforeEach(async () => {
      await truncateAllData(db);
      const tenant = await new TenantRepository(db).create({ name: 'Provider Incident Tenant' });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: 'Provider Incident Organization',
        slug: `provider-incident-${driver}`,
      });
      tenantId = tenant.id;
      organizationId = organization.id;
    }, 60_000);

    afterAll(async () => {
      await db?.destroy();
    }, 60_000);

    function captureInput(index: number, maxActivePerTenant = 1_000) {
      return {
        id: `pie_${String(index).padStart(26, '0')}`,
        tenantId,
        organizationId,
        provider: 'resend',
        operation: 'send-email',
        correlationSha256: `sha256:${index.toString(16).padStart(64, '0')}`,
        encrypted: {
          keyId: 'incident-2026-07',
          ivB64: 'AAAAAAAAAAAAAAAA',
          tagB64: 'AAAAAAAAAAAAAAAAAAAAAA',
          ciphertextB64: `Y2lwaGVydGV4dF8${index}`,
        },
        capturedAt,
        expiresAt: new Date(capturedAt.getTime() + 60 * 60 * 1_000),
        maxActivePerTenant,
      };
    }

    it('deduplicates correlation, enforces the tenant cap, reveals with audit, and sweeps expiry', async () => {
      const repository = new ProviderIncidentEvidenceRepository(db);
      const first = await repository.capture(captureInput(1, 1));
      const duplicate = await repository.capture({
        ...captureInput(1, 1),
        id: `pie_${'9'.repeat(26)}`,
      });
      expect(duplicate.id).toBe(first.id);
      await expect(repository.capture(captureInput(2, 1))).rejects.toBeInstanceOf(
        ProviderIncidentCapacityError,
      );

      const revealed = await repository.revealWithAudit({
        id: first.id,
        tenantId,
        organizationId,
        now: capturedAt,
        audit: { actorType: 'user', actorId: 'user_01', reason: 'Provider support escalation' },
        decrypt: () => 'req_exact_support_01',
      });
      expect(revealed).toBe('req_exact_support_01');
      const audit = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('resource_id', '=', first.id)
        .executeTakeFirstOrThrow();
      expect(audit.action).toBe('provider_incident.request_id.revealed');
      expect(JSON.stringify(audit)).not.toContain('req_exact_support_01');

      let decryptRanBeforeAuditFailure = false;
      await expect(
        repository.revealWithAudit({
          id: first.id,
          tenantId,
          organizationId,
          now: capturedAt,
          audit: {
            actorType: 'user',
            actorId: 'user_01',
            reason: 'Audit insert failure proof',
            userAgent: 'x'.repeat(513),
          },
          decrypt: () => {
            decryptRanBeforeAuditFailure = true;
            return 'must_not_return_without_audit_commit';
          },
        }),
      ).rejects.toThrow();
      expect(decryptRanBeforeAuditFailure).toBe(true);
      const auditCount = await db
        .selectFrom('audit_logs')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('resource_id', '=', first.id)
        .executeTakeFirstOrThrow();
      expect(Number(auditCount.count)).toBe(1);

      expect(
        await repository.revealWithAudit({
          id: first.id,
          tenantId,
          organizationId: `org_${'0'.repeat(26)}`,
          now: capturedAt,
          audit: { actorType: 'user', actorId: 'user_01', reason: 'Cross scope' },
          decrypt: () => 'must_not_reveal',
        }),
      ).toBeUndefined();
      expect(await repository.sweepExpired(new Date(capturedAt.getTime() + 60 * 60 * 1_000))).toBe(
        1,
      );
    });

    it('serializes concurrent captures against the tenant cap', async () => {
      const repository = new ProviderIncidentEvidenceRepository(db);
      const settled = await Promise.allSettled([
        repository.capture(captureInput(3, 1)),
        repository.capture(captureInput(4, 1)),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    });

    it('isolates duplicate correlation by organization and recaptures after expiry', async () => {
      const repository = new ProviderIncidentEvidenceRepository(db);
      const secondOrganization = await new OrganizationRepository(db).create({
        tenantId,
        name: 'Second Provider Incident Organization',
        slug: `provider-incident-second-${driver}`,
      });
      const first = await repository.capture(captureInput(5, 10));
      const second = await repository.capture({
        ...captureInput(5, 10),
        id: `pie_${'6'.repeat(26)}`,
        organizationId: secondOrganization.id,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.organization_id).toBe(secondOrganization.id);
      await expect(
        repository.findActiveByCorrelation({
          tenantId,
          organizationId,
          correlationSha256: first.correlation_sha256,
          now: capturedAt,
        }),
      ).resolves.toEqual([expect.objectContaining({ id: first.id })]);
      await expect(
        repository.findActiveByCorrelation({
          tenantId,
          organizationId: secondOrganization.id,
          correlationSha256: first.correlation_sha256,
          now: capturedAt,
        }),
      ).resolves.toEqual([expect.objectContaining({ id: second.id })]);

      // MySQL DATETIME stores whole seconds for this cross-engine contract. Cross
      // the expiry boundary by one full storage quantum so the assertion proves
      // recapture semantics instead of depending on engine-specific precision.
      const recapturedAt = new Date(captureInput(5).expiresAt.getTime() + 1_000);
      const recaptured = await repository.capture({
        ...captureInput(5, 10),
        id: `pie_${'7'.repeat(26)}`,
        capturedAt: recapturedAt,
        expiresAt: new Date(recapturedAt.getTime() + 60 * 60 * 1_000),
      });
      expect(recaptured.id).not.toBe(first.id);
      expect(recaptured.captured_at).toEqual(recapturedAt);
    });
  },
);
