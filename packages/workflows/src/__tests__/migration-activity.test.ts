import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATION_SIDE_EFFECT_POLICY,
  processMigrationStageActivity,
  registerMigrationActivityService,
  type MigrationActivityService,
} from "../activities/migration.js";
import { assertMigrationCommittersRegistered } from "../activities/migration-repository-service.js";
import { createProductionMigrationCommitters } from "../activities/migration-domain-committers.js";
import { MIGRATION_ENTITY_DEPENDENCY_ORDER } from "@tixkit/migration-core";
import type { Database } from "@tixkit/db";

const unregisters: Array<() => void> = [];
afterEach(() => {
  while (unregisters.length > 0) unregisters.pop()?.();
});

function service(): MigrationActivityService {
  return {
    beginCommit: vi.fn(async () => undefined),
    processStage: vi.fn(async () => ({
      processed: 1,
      created: 1,
      updated: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      complete: true,
    })),
    recordProgress: vi.fn(async () => undefined),
    markPaused: vi.fn(async () => undefined),
    cancelCommit: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ repaired: 0, unresolved: 0 })),
    assessRollback: vi.fn(async () => ({
      eligible: true as const,
      mode: "pre_activation" as const,
      entityCount: 1,
    })),
    executeRollback: vi.fn(async () => ({ deleted: 1 })),
    completeCommit: vi.fn(async () => undefined),
    failCommit: vi.fn(async () => undefined),
  };
}

describe("migration activities", () => {
  it("refuses configuration unless every migration entity has a real committer", () => {
    expect(() => assertMigrationCommittersRegistered(new Map())).toThrow(
      `MIGRATION_COMMITTERS_MISSING:${MIGRATION_ENTITY_DEPENDENCY_ORDER.join(",")}`,
    );
  });

  it("builds an exhaustive production committer registry", () => {
    const registry = createProductionMigrationCommitters({} as Database);
    expect([...registry.keys()]).toEqual(MIGRATION_ENTITY_DEPENDENCY_ORDER);
    expect(() => assertMigrationCommittersRegistered(registry)).not.toThrow();
  });

  it("rejects incomplete entities and unsafe historical side effects before database writes", async () => {
    const committer = createProductionMigrationCommitters({} as Database).get(
      "historical-payment",
    );
    await expect(
      committer?.commit({
        tenantId: "tenant_1",
        organizationId: "org_1",
        jobId: "job_1",
        entity: {
          entityType: "historical-payment",
          externalId: "payment_1",
          sourcePosition: "payments.csv:2",
          attributes: {},
        },
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow(
      "MIGRATION_FINANCIAL_SNAPSHOT_REQUIRED:historical-payment",
    );

    await expect(
      committer?.commit({
        tenantId: "tenant_1",
        organizationId: "org_1",
        jobId: "job_1",
        entity: {
          entityType: "historical-payment",
          externalId: "payment_1",
          sourcePosition: "payments.csv:2",
          attributes: {},
          financialSnapshot: {
            kind: "historical-payment",
            amountMinor: 1000,
            currency: "USD",
            occurredAt: "2026-01-01T00:00:00.000Z",
            provenance: {
              sourceSystem: "csv",
              sourceExternalId: "payment_1",
              importedAt: "2026-01-02T00:00:00.000Z",
            },
            reconciliationStatus: "unreconciled",
            sideEffects: "suppressed",
          },
        },
        sideEffects: {
          ...MIGRATION_SIDE_EFFECT_POLICY,
          webhooks: "enabled",
        } as never,
      }),
    ).rejects.toThrow("MIGRATION_SIDE_EFFECT_POLICY_REJECTED");
  });
  it("passes tenant scope and the immutable no-side-effect policy to commit code", async () => {
    const implementation = service();
    unregisters.push(registerMigrationActivityService(implementation));

    await processMigrationStageActivity({
      tenantId: "tenant_1",
      organizationId: "org_1",
      jobId: "import_1",
      stage: "historical_payments_refunds",
      claimOwner: "test-owner",
      chunkSize: 250,
    });

    expect(implementation.processStage).toHaveBeenCalledWith(
      {
        tenantId: "tenant_1",
        organizationId: "org_1",
        jobId: "import_1",
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      },
      {
        stage: "historical_payments_refunds",
        cursor: undefined,
        claimOwner: "test-owner",
        chunkSize: 250,
      },
    );
    expect(MIGRATION_SIDE_EFFECT_POLICY).toEqual({
      fulfillment: "suppressed",
      notifications: "suppressed",
      webhooks: "suppressed",
      providerSuccessEvents: "suppressed",
      financialRecords: "historical_snapshots_only",
    });
    expect(Object.isFrozen(MIGRATION_SIDE_EFFECT_POLICY)).toBe(true);
  });

  it("fails closed without a registered tenant-scoped implementation", async () => {
    await expect(
      processMigrationStageActivity({
        tenantId: "tenant_1",
        organizationId: "org_1",
        jobId: "import_1",
        stage: "venues",
        claimOwner: "test-owner",
        chunkSize: 100,
      }),
    ).rejects.toThrow("MIGRATION_ACTIVITY_SERVICE_UNAVAILABLE");
  });

  it("rejects invalid chunk sizes before invoking commit code", async () => {
    const implementation = service();
    unregisters.push(registerMigrationActivityService(implementation));
    await expect(
      processMigrationStageActivity({
        tenantId: "tenant_1",
        organizationId: "org_1",
        jobId: "import_1",
        stage: "venues",
        claimOwner: "test-owner",
        chunkSize: 0,
      }),
    ).rejects.toThrow("MIGRATION_CHUNK_SIZE_INVALID");
    expect(implementation.processStage).not.toHaveBeenCalled();
  });
});
