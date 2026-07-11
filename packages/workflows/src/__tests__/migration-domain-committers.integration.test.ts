import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  BrandRepository,
  ImportRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
  type Database,
} from "@tixkit/db";
import {
  eventbriteApiV3Fixture,
  GenericCsvMigrationAdapter,
  SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
  SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
  ticketTailorApiV1Fixture,
  migrationAdapter,
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  sortEntitiesByDependency,
  type MigrationAdapter,
  type MigrationEntityType,
  type NormalizedMigrationEntity,
} from "@tixkit/migration-core";
import {
  MIGRATION_COMMIT_STAGES,
  MIGRATION_SIDE_EFFECT_POLICY,
} from "../activities/migration.js";
import { createProductionMigrationCommitters } from "../activities/migration-domain-committers.js";
import { createRepositoryMigrationActivityService } from "../activities/migration-repository-service.js";
import { createMigrationPreparationService } from "../activities/migration-preparation.js";

const url = process.env.DATABASE_URL ?? "";
const describeDatabase = url ? describe.sequential : describe.skip;

const attributes: Record<MigrationEntityType, Record<string, unknown>> = {
  organization: { name: "Imported organization" },
  brand: { name: "Imported brand" },
  venue: { name: "Imported venue" },
  event: {
    title: "Imported event",
    currency: "USD",
    timezone: "America/Chicago",
  },
  occurrence: {
    startsAt: "2026-10-01T18:00:00Z",
    endsAt: "2026-10-01T20:00:00Z",
    timezone: "America/Chicago",
  },
  "inventory-pool": { name: "General", totalCapacity: 100 },
  "ticket-type": {
    name: "General admission",
    currency: "USD",
    priceMinor: 2500,
  },
  product: { name: "Poster", currency: "USD", priceMinor: 1000 },
  question: { label: "Dietary requirements", type: "text" },
  discount: { code: "SAVE10", type: "percentage", value: 10 },
  "access-code": { code: "LOCKED" },
  buyer: { email: "buyer@example.test" },
  attendee: { email: "attendee@example.test" },
  "historical-order": {
    orderNumber: "OLD-1",
    currency: "USD",
    totalMinor: 2500,
    buyerEmail: "buyer@example.test",
  },
  ticket: { code: "OLD-TICKET-1" },
  "historical-payment": {},
  "historical-refund": {},
  "check-in": { occurredAt: "2026-10-01T18:30:00Z" },
};

function entity(
  type: MigrationEntityType,
  index: number,
): NormalizedMigrationEntity {
  const financialSnapshot =
    type === "historical-payment" || type === "historical-refund"
      ? {
          kind: type,
          amountMinor: type === "historical-payment" ? 2500 : 500,
          currency: "USD",
          occurredAt: "2026-10-01T18:00:00Z",
          provenance: {
            sourceSystem: "generic-csv",
            sourceExternalId: `${type}-1`,
            importedAt: "2026-10-02T00:00:00Z",
          },
          reconciliationStatus: "unreconciled" as const,
          sideEffects: "suppressed" as const,
        }
      : undefined;
  return {
    entityType: type,
    externalId: `${type}-1`,
    sourcePosition: `fixture:${index + 1}`,
    attributes: attributes[type],
    dependencies: MIGRATION_ENTITY_DEPENDENCY_ORDER.slice(0, index).map(
      (entityType) => ({
        entityType,
        externalId: `${entityType}-1`,
      }),
    ),
    ...(financialSnapshot ? { financialSnapshot } : {}),
  };
}

describeDatabase("production migration committers", () => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;
  let brandId: string;

  beforeAll(async () => {
    process.env.DB_DRIVER =
      process.env.DB_INTEGRATION_DRIVER === "mysql" ? "mysql" : "postgres";
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (
      await new TenantRepository(db).create({
        name: "Migration committer test",
      })
    ).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: "Migration organization",
        slug: "migration-organization",
      })
    ).id;
    brandId = (
      await new BrandRepository(db).create({
        tenantId,
        organizationId,
        name: "Existing migration target brand",
        slug: "existing-migration-target-brand",
      })
    ).id;
  });

  afterAll(async () => db?.destroy());

  async function importChain(idempotencyKey: string) {
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: "generic-csv",
      adapterVersion: "1.0.0",
      mode: "commit",
      idempotencyKey,
      requestedBy: "test-user",
    });
    const entities = MIGRATION_ENTITY_DEPENDENCY_ORDER.map(entity);
    await repository.addRows(
      tenantId,
      organizationId,
      job.id,
      entities.map((normalized, index) => ({
        entityType: normalized.entityType,
        externalId: normalized.externalId,
        rowNumber: index + 1,
        sourceData: normalized.attributes,
        normalizedData: normalized,
        status: "validated",
      })),
    );
    await repository.transitionJob({
      tenantId,
      organizationId,
      jobId: job.id,
      from: ["pending"],
      to: "ready",
    });
    const service = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    const context = {
      tenantId,
      organizationId,
      jobId: job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    };
    await service.beginCommit(context);
    let processed = 0;
    for (const [stageIndex, stage] of MIGRATION_COMMIT_STAGES.entries()) {
      const result = await service.processStage(context, {
        stage,
        claimOwner: `test-owner:${stage}`,
        chunkSize: 100,
      });
      processed += result.processed;
      await service.recordProgress(context, {
        stage,
        stageIndex,
        stageCount: MIGRATION_COMMIT_STAGES.length,
        processed,
        created: processed,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
      });
    }
    await service.reconcile(context);
    await service.completeCommit(context);
    return job;
  }

  it("imports the canonical dependency chain idempotently without commerce side effects", async () => {
    const firstJob = await importChain("chain:first");
    const imports = new ImportRepository(db);
    const eventReference = await imports.findExternalReference({
      tenantId,
      organizationId,
      sourceSystem: "generic-csv",
      entityType: "event",
      externalId: "event-1",
    });
    const eventBefore = await db
      .selectFrom("events")
      .select(["updated_at"])
      .where("id", "=", eventReference!.tixkit_id)
      .executeTakeFirstOrThrow();
    await importChain("chain:reimport");
    const lifecycleEvents = await imports.listEvents(
      tenantId,
      organizationId,
      firstJob.id,
    );
    expect(lifecycleEvents.map((event) => event.sequence)).toEqual(
      lifecycleEvents.map((_event, index) => index + 1),
    );
    expect(lifecycleEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "commit.begin",
        "commit.progress",
        "commit.reconciled",
        "commit.completed",
      ]),
    );
    const eventAfter = await db
      .selectFrom("events")
      .select(["updated_at"])
      .where("id", "=", eventReference!.tixkit_id)
      .executeTakeFirstOrThrow();
    expect(new Date(eventAfter.updated_at).toISOString()).toBe(
      new Date(eventBefore.updated_at).toISOString(),
    );
    await db
      .updateTable("events")
      .set({ title: "Edited after import", updated_at: eventAfter.updated_at })
      .where("id", "=", eventReference!.tixkit_id)
      .execute();
    await expect(
      createProductionMigrationCommitters(db).get("event")!.deleteUntouched({
        tenantId,
        organizationId,
        jobId: firstJob.id,
        tixkitId: eventReference!.tixkit_id,
      }),
    ).resolves.toBe(false);

    expect(
      Number(
        (
          await db
            .selectFrom("imported_domain_entities")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("tenant_id", "=", tenantId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(18);
    const snapshots = await db
      .selectFrom("imported_domain_entities")
      .select(["entity_type", "side_effects_suppressed", "financial_snapshot"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "in", ["historical-payment", "historical-refund"])
      .execute();
    expect(snapshots).toHaveLength(2);
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.side_effects_suppressed && snapshot.financial_snapshot,
      ),
    ).toBe(true);
    expect(
      Number(
        (
          await db
            .selectFrom("payment_events")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db
            .selectFrom("webhook_deliveries")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(0);

    const ticketReference = await imports.findExternalReference({
      tenantId,
      organizationId,
      sourceSystem: "generic-csv",
      entityType: "ticket",
      externalId: "ticket-1",
    });
    expect(ticketReference).toBeDefined();
    const ticketBeforeEdit = await db
      .selectFrom("tickets")
      .select(["updated_at"])
      .where("id", "=", ticketReference!.tixkit_id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("tickets")
      .set({
        code: "same-timestamp-edit",
        updated_at: ticketBeforeEdit.updated_at,
      })
      .where("id", "=", ticketReference!.tixkit_id)
      .execute();
    await expect(
      createProductionMigrationCommitters(db).get("ticket")!.assessUntouched({
        tenantId,
        organizationId,
        jobId: firstJob.id,
        tixkitId: ticketReference!.tixkit_id,
      }),
    ).resolves.toMatchObject({
      eligible: false,
      reason: "Authoritative domain activity or canonical edit detected",
    });
    await imports.markRollbackBlocked({
      tenantId,
      organizationId,
      entityType: "ticket",
      tixkitId: ticketReference!.tixkit_id,
      reason: "scan recorded after import",
    });
    const eligibility = await imports.getRollbackEligibility(
      tenantId,
      organizationId,
      firstJob.id,
    );
    expect(eligibility).toMatchObject({
      eligible: false,
      mode: "corrective-plan",
    });
    const rollbackService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    const assessment = await rollbackService.assessRollback({
      tenantId,
      organizationId,
      jobId: firstJob.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(assessment).toMatchObject({
      eligible: false,
      mode: "corrective_plan",
    });
    const correctivePlan = (
      await imports.listEvents(tenantId, organizationId, firstJob.id)
    ).find((event) => event.type === "rollback.corrective-plan");
    expect(correctivePlan?.id).toBe(
      assessment.eligible ? undefined : assessment.correctivePlanId,
    );
    expect(JSON.parse(correctivePlan!.data!)).toMatchObject({
      immutable: true,
      blockers: [{ reason: "scan recorded after import" }],
      safeActions: expect.arrayContaining([
        expect.stringContaining("corrective"),
      ]),
    });
    const replayedAssessment = await rollbackService.assessRollback({
      tenantId,
      organizationId,
      jobId: firstJob.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(replayedAssessment).toEqual(assessment);

    const changedSnapshotJob = await imports.createJob({
      tenantId,
      organizationId,
      sourceSystem: "generic-csv",
      adapterVersion: "1.0.0",
      mode: "commit",
      idempotencyKey: "financial:changed",
      requestedBy: "test-user",
    });
    const changedPayment = entity(
      "historical-payment",
      MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf("historical-payment"),
    );
    changedPayment.financialSnapshot = {
      ...changedPayment.financialSnapshot!,
      amountMinor: changedPayment.financialSnapshot!.amountMinor + 1,
    };
    await expect(
      createProductionMigrationCommitters(db)
        .get("historical-payment")!
        .commit({
          tenantId,
          organizationId,
          jobId: changedSnapshotJob.id,
          entity: changedPayment,
          sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
        }),
    ).resolves.toMatchObject({ disposition: "conflict" });
  });

  it("cannot resolve dependencies from another organization in the same tenant", async () => {
    await importChain("org-isolation:source");
    const otherOrganization = await new OrganizationRepository(db).create({
      tenantId,
      name: "Other migration organization",
      slug: "other-migration-organization",
    });
    const imports = new ImportRepository(db);
    const job = await imports.createJob({
      tenantId,
      organizationId: otherOrganization.id,
      sourceSystem: "generic-csv",
      adapterVersion: "1",
      mode: "commit",
      idempotencyKey: "org-isolation:target",
      requestedBy: "test",
    });
    const brand = createProductionMigrationCommitters(db).get("brand")!;
    await expect(
      brand.commit({
        tenantId,
        organizationId: otherOrganization.id,
        jobId: job.id,
        entity: {
          entityType: "brand",
          externalId: "cross-org-brand",
          sourcePosition: "fixture:cross-org",
          attributes: { name: "Cross org" },
          dependencies: [
            { entityType: "organization", externalId: "organization-1" },
          ],
        },
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow(
      "MIGRATION_DEPENDENCY_UNRESOLVED:organization:organization-1",
    );
  });

  it("resolves a live scoped credential before commit and sanitizes resolver failures", async () => {
    const imports = new ImportRepository(db);
    const credential = await imports.createCredential({
      tenantId,
      organizationId,
      sourceSystem: "pretix",
      secretReference: "vault://migrations/pretix/test",
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: "test",
    });
    const createJob = async (key: string) => {
      const job = await imports.createJob({
        tenantId,
        organizationId,
        sourceSystem: "pretix",
        adapterVersion: "1",
        mode: "commit",
        idempotencyKey: key,
        requestedBy: "test",
        configuration: { credentialId: credential.id },
      });
      await imports.transitionJob({
        tenantId,
        organizationId,
        jobId: job.id,
        from: ["pending"],
        to: "ready",
      });
      return job;
    };
    const failedJob = await createJob("credential:failure");
    const rejectingResolver = {
      resolve: vi.fn(async () => {
        throw new Error("vault token and secret details");
      }),
    };
    const failingService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      rejectingResolver,
    );
    await expect(
      failingService.beginCommit({
        tenantId,
        organizationId,
        jobId: failedJob.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow("MIGRATION_CREDENTIAL_UNAVAILABLE");
    expect(
      (await imports.findJob(tenantId, organizationId, failedJob.id))?.status,
    ).toBe("ready");

    const liveJob = await createJob("credential:success");
    const liveResolver = {
      resolve: vi.fn(async () => ({
        material: "ephemeral",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })),
    };
    const liveService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      liveResolver,
    );
    await liveService.beginCommit({
      tenantId,
      organizationId,
      jobId: liveJob.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(liveResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        organizationId,
        sourceSystem: "pretix",
        secretReference: "vault://migrations/pretix/test",
      }),
      {},
    );
    expect(
      (await imports.findJob(tenantId, organizationId, liveJob.id))?.status,
    ).toBe("committing");
  });

  it.each([
    {
      sourceSystem: "generic-csv" as const,
      configuration: {
        documents: [
          {
            name: "events.csv",
            content:
              "external_id,brand_external_id,name,starts_at,ends_at,timezone,currency\nevent-prod,brand-existing,Production import,2027-07-10T18:00:00Z,2027-07-10T22:00:00Z,UTC,USD\n",
          },
        ],
      },
    },
    {
      sourceSystem: "pretix" as const,
      configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
    },
    {
      sourceSystem: "hi-events" as const,
      configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
    },
    {
      sourceSystem: "eventbrite" as const,
      configuration: eventbriteApiV3Fixture,
    },
    {
      sourceSystem: "ticket-tailor" as const,
      configuration: ticketTailorApiV1Fixture,
    },
  ])(
    "persists the $sourceSystem official corpus through durable production rows and resumes at the exact cursor",
    async ({ sourceSystem, configuration }) => {
      const adapter =
        sourceSystem === "generic-csv"
          ? (new GenericCsvMigrationAdapter() as MigrationAdapter<
              unknown,
              string
            >)
          : (migrationAdapter(sourceSystem) as MigrationAdapter<
              unknown,
              string
            >);
      const context = { tenantId, organizationId };
      const discovery = await adapter.discover(configuration, context);
      const sourceEntities: NormalizedMigrationEntity[] = [];
      let cursor: string | undefined;
      do {
        const page = await adapter.extract({
          configuration,
          discovery,
          cursor,
          limit: 2,
          context,
        });
        for (const row of page.rows)
          sourceEntities.push(await adapter.normalize(row, context));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sourceEntities.length).toBeGreaterThan(0);
      const entities = sortEntitiesByDependency(sourceEntities);
      const sourceKeys = new Set(
        sourceEntities.map((item) => `${item.entityType}:${item.externalId}`),
      );

      const repository = new ImportRepository(db);
      const job = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem,
        adapterVersion: adapter.supportedVersions[0]!,
        mode: "commit",
        idempotencyKey: `production-corpus-${sourceSystem}`,
        requestedBy: "test-user",
      });
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: job.id,
        from: ["pending"],
        to: "preparing",
      });
      const split = Math.max(1, Math.floor(entities.length / 2));
      const persist = async (
        selected: readonly NormalizedMigrationEntity[],
        startRowNumber: number,
        cursorKey: string,
        completed: boolean,
      ) =>
        repository.persistPreparationChunk({
          tenantId,
          organizationId,
          jobId: job.id,
          startRowNumber,
          cursorKey,
          nextCursor: completed ? undefined : `${sourceSystem}:resume:${split}`,
          completed,
          rows: await Promise.all(
            selected.map(async (normalized) => ({
              entityType: normalized.entityType,
              externalId: normalized.externalId,
              sourceData: { sourcePosition: normalized.sourcePosition },
              normalizedData: normalized,
              issues: sourceKeys.has(
                `${normalized.entityType}:${normalized.externalId}`,
              )
                ? (await adapter.validate(normalized, context)).map(
                    ({ code, severity, message }) => ({
                      code,
                      severity,
                      message,
                    }),
                  )
                : [],
            })),
          ),
        });
      await persist(
        entities.slice(0, split),
        0,
        `${sourceSystem}:first`,
        false,
      );
      const recovered = await repository.preparationProgress(
        tenantId,
        organizationId,
        job.id,
      );
      expect(recovered).toEqual({
        cursor: `${sourceSystem}:resume:${split}`,
        rowNumber: split,
        completed: false,
      });
      await persist(
        entities.slice(split),
        recovered.rowNumber,
        `${sourceSystem}:second`,
        true,
      );
      await persist(
        entities.slice(split),
        recovered.rowNumber,
        `${sourceSystem}:second`,
        true,
      );
      const rows = await repository.listRows({
        tenantId,
        organizationId,
        jobId: job.id,
        limit: 500,
      });
      expect(rows).toHaveLength(entities.length);
      expect(rows.every((row) => row.normalized_data !== null)).toBe(true);
      expect(
        (await repository.findJob(tenantId, organizationId, job.id))?.status,
      ).toBe("prepared");
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: job.id,
        from: ["prepared"],
        to: "ready",
      });
      const committers = createRepositoryMigrationActivityService(
        db,
        createProductionMigrationCommitters(db),
      );
      const entityKeys = new Set(
        entities.map((item) => `${item.entityType}:${item.externalId}`),
      );
      for (const item of entities) {
        for (const dependency of item.dependencies ?? []) {
          if (
            dependency.entityType !== "brand" ||
            entityKeys.has(`brand:${dependency.externalId}`)
          )
            continue;
          await repository.recordExternalReference({
            tenantId,
            organizationId,
            sourceSystem,
            entityType: "brand",
            externalId: dependency.externalId,
            tixkitId: brandId,
            importJobId: job.id,
            createdByJob: false,
          });
        }
      }
      const commitJob = async (jobId: string) => {
        const scope = {
          tenantId,
          organizationId,
          jobId,
          sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
        };
        await committers.beginCommit(scope);
        const totals = { created: 0, updated: 0, skipped: 0, conflicts: 0 };
        for (const stage of MIGRATION_COMMIT_STAGES) {
          let stageCursor: string | undefined;
          for (;;) {
            const result = await committers.processStage(scope, {
              stage,
              cursor: stageCursor,
              claimOwner: `${jobId}:${stage}:${stageCursor ?? "first"}`,
              chunkSize: 2,
            });
            totals.created += result.created;
            totals.updated += result.updated;
            totals.skipped += result.skipped;
            totals.conflicts += result.conflicts;
            if (result.complete) break;
            stageCursor = result.nextCursor;
          }
          if (stage === "events_occurrences") {
            const missingPools = new Map<string, string>();
            for (const item of entities) {
              const eventDependency = item.dependencies?.find(
                ({ entityType }) => entityType === "event",
              );
              for (const dependency of item.dependencies ?? []) {
                if (
                  dependency.entityType === "inventory-pool" &&
                  !entityKeys.has(`inventory-pool:${dependency.externalId}`) &&
                  eventDependency
                )
                  missingPools.set(
                    dependency.externalId,
                    eventDependency.externalId,
                  );
              }
            }
            for (const [poolExternalId, eventExternalId] of missingPools) {
              const existingPool = await repository.findExternalReference({
                tenantId,
                organizationId,
                sourceSystem,
                entityType: "inventory-pool",
                externalId: poolExternalId,
              });
              if (existingPool) continue;
              const eventReference = await repository.findExternalReference({
                tenantId,
                organizationId,
                sourceSystem,
                entityType: "event",
                externalId: eventExternalId,
              });
              if (!eventReference)
                throw new Error("TEST_EVENT_MAPPING_REQUIRED");
              const poolId = `pool_${sourceSystem.replaceAll("-", "_")}_${missingPools.size}`;
              await db
                .insertInto("inventory_pools")
                .values({
                  id: poolId,
                  event_id: eventReference.tixkit_id,
                  name: "Existing mapped capacity",
                  total_capacity: 10_000,
                  reserved_count: 0,
                  sold_count: 0,
                  hold_ttl_seconds: 900,
                  created_at: new Date(),
                  updated_at: new Date(),
                })
                .execute();
              await repository.recordExternalReference({
                tenantId,
                organizationId,
                sourceSystem,
                entityType: "inventory-pool",
                externalId: poolExternalId,
                tixkitId: poolId,
                importJobId: jobId,
                createdByJob: false,
              });
            }
          }
        }
        await committers.completeCommit(scope);
        return totals;
      };
      const firstCommit = await commitJob(job.id);
      expect(firstCommit.conflicts).toBe(0);
      expect(
        firstCommit.created + firstCommit.updated + firstCommit.skipped,
      ).toBe(entities.length);

      const replay = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem,
        adapterVersion: adapter.supportedVersions[0]!,
        mode: "commit",
        idempotencyKey: `production-corpus-replay-${sourceSystem}`,
        requestedBy: "test-user",
      });
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: replay.id,
        from: ["pending"],
        to: "preparing",
      });
      await repository.persistPreparationChunk({
        tenantId,
        organizationId,
        jobId: replay.id,
        startRowNumber: 0,
        cursorKey: `${sourceSystem}:replay`,
        completed: true,
        rows: entities.map((normalized) => ({
          entityType: normalized.entityType,
          externalId: normalized.externalId,
          sourceData: { sourcePosition: normalized.sourcePosition },
          normalizedData: normalized,
          issues: [],
        })),
      });
      const replayRows = await repository.listRows({
        tenantId,
        organizationId,
        jobId: replay.id,
        limit: 500,
      });
      expect(replayRows.map(({ normalized_data }) => normalized_data)).toEqual(
        rows.map(({ normalized_data }) => normalized_data),
      );
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: replay.id,
        from: ["prepared"],
        to: "ready",
      });
      const secondCommit = await commitJob(replay.id);
      expect(secondCommit).toMatchObject({
        created: 0,
        updated: 0,
        skipped: entities.length,
        conflicts: 0,
      });
    },
    30_000,
  );

  it.each([
    {
      sourceSystem: "pretix" as const,
      configuration: {
        sourceMode: "official-api" as const,
        sourceSystem: "pretix" as const,
        organizerSlug: "sample-organizer",
        eventSlugs: ["sample-event"],
      },
      fixture: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
    },
    {
      sourceSystem: "hi-events" as const,
      configuration: {
        sourceMode: "official-api" as const,
        sourceSystem: "hi-events" as const,
        accountId: "sample-account",
        eventIds: ["event-1"],
      },
      fixture: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
    },
  ])(
    "acquires native $sourceSystem multi-resource API pages with exact durable resume",
    async ({ sourceSystem, configuration, fixture }) => {
      const repository = new ImportRepository(db);
      const credential = await repository.createCredential({
        tenantId,
        organizationId,
        sourceSystem,
        secretReference: `vault://migrations/${sourceSystem}/native-fixture`,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: "test-user",
      });
      const adapter = migrationAdapter(sourceSystem);
      const job = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem,
        adapterVersion: adapter.supportedVersions[0]!,
        mode: "commit",
        idempotencyKey: `native-api-preparation-${sourceSystem}`,
        requestedBy: "test-user",
        configuration: { ...configuration, credentialId: credential.id },
      });
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const page of fixture.pages) {
        for (const raw of page.records as readonly unknown[]) {
          const record = raw as {
            resource?: string;
            collection?: string;
            body: Record<string, unknown>;
          };
          const key = String(record.resource ?? record.collection);
          const values = grouped.get(key) ?? [];
          values.push(structuredClone(record.body));
          grouped.set(key, values);
        }
      }
      const order = grouped.get("orders")?.[0];
      if (order) {
        order.payments = grouped.get("payments") ?? [];
        order.refunds = grouped.get("refunds") ?? [];
        if (sourceSystem === "pretix") {
          const positions = order.positions as Array<Record<string, unknown>>;
          for (const position of positions) delete position.checkins;
        }
      }
      const requested: string[] = [];
      const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        requested.push(url.href);
        let key: string;
        if (sourceSystem === "pretix") {
          if (url.pathname.endsWith('/checkinlists/7/positions/')) {
            const checkins = grouped.get("checkins") ?? [];
            const continuation = url.searchParams.get("continuation");
            return new Response(
              JSON.stringify({
                results: continuation
                  ? [
                      {
                        id: String(
                          ((
                            order?.positions as
                              Array<Record<string, unknown>> | undefined
                          )?.[0]?.id as string | number | undefined) ??
                            "position-100",
                        ),
                        checkins,
                      },
                    ]
                  : [{ id: "position-empty", checkins: [] }],
                ...(!continuation
                  ? { pagination: { continuation: "checkin-position-page-2" } }
                  : {}),
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.pathname.endsWith('/checkinlists/')) {
            return new Response(
              JSON.stringify({ results: [{ id: 7, name: "Default" }] }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          const match = /\/(quotas|items|questions|vouchers|orders)\//u.exec(
            url.pathname,
          );
          key =
            match?.[1] ??
            (url.pathname.endsWith("/events/") ? "events" : "organizers");
        } else {
          const match =
            /\/(capacity-assignments|products|questions|promo-codes|orders|check-ins)$/u.exec(
              url.pathname,
            );
          key =
            match?.[1] ??
            (url.pathname === "/api/account"
              ? "accounts"
              : url.pathname === "/api/venues"
                ? "venues"
                : "events");
        }
        const bodies = grouped.get(key) ?? [];
        const continuation = url.searchParams.get("continuation");
        const paginate =
          (key === "items" || key === "products") && bodies.length > 1;
        const results = paginate
          ? continuation === "native-page-2"
            ? bodies.slice(1)
            : bodies.slice(0, 1)
          : bodies;
        return new Response(
          JSON.stringify({
            results,
            ...(paginate && !continuation
              ? { pagination: { continuation: "native-page-2" } }
              : {}),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const runtime = {
        fetch: fetcher as typeof fetch,
        resolveHost: vi.fn(async () => [
          { address: "8.8.8.8", family: 4 },
        ]) as never,
        signal: new AbortController().signal,
        heartbeat: vi.fn(),
        cursorEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      };
      const resolver = {
        resolve: vi.fn(async () => ({
          material: "ephemeral-native-fixture-token",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        })),
      };
      const firstWorker = createMigrationPreparationService(
        db,
        resolver,
        runtime,
      );
      const first = await firstWorker.prepare({
        tenantId,
        organizationId,
        jobId: job.id,
        chunkSize: 100,
      });
      expect(first.completed).toBe(false);
      const recoveredWorker = createMigrationPreparationService(
        db,
        resolver,
        runtime,
      );
      let result = await recoveredWorker.prepare({
        tenantId,
        organizationId,
        jobId: job.id,
        chunkSize: 100,
      });
      while (!result.completed) {
        result = await recoveredWorker.prepare({
          tenantId,
          organizationId,
          jobId: job.id,
          chunkSize: 100,
        });
      }
      const rows = await repository.listRows({
        tenantId,
        organizationId,
        jobId: job.id,
        limit: 500,
      });
      expect(rows).toHaveLength(18);
      const types = new Set(rows.map(({ entity_type }) => entity_type));
      expect(types.has("historical-payment")).toBe(true);
      expect(types.has("historical-refund")).toBe(true);
      expect(types.has("check-in")).toBe(true);
      expect(
        requested.some((url) => url.includes("continuation=native-page-2")),
      ).toBe(true);
      if (sourceSystem === "pretix") {
        expect(
          requested.some((url) => url.includes("/checkinlists/7/positions/")),
        ).toBe(true);
        expect(
          requested.some(
            (url) =>
              url.includes("/checkinlists/7/positions/") &&
              url.includes("continuation=checkin-position-page-2"),
          ),
        ).toBe(true);
      }
      expect(
        (await repository.preparationProgress(tenantId, organizationId, job.id))
          .completed,
      ).toBe(true);
      expect(resolver.resolve).toHaveBeenCalled();
    },
    30_000,
  );
});
