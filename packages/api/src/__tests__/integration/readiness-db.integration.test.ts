import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
} from "kysely";
import {
  BrandRepository,
  createDb,
  EventRepository,
  InventoryPoolRepository,
  OrganizationRepository,
  TenantRepository,
  TicketTypeRepository,
  type Database,
} from "@tixkit/db";
import { ulid } from "ulid";
import {
  EVENT_READINESS_QUERY_BUDGET,
  WORKSPACE_READINESS_QUERY_BUDGET,
  ReadinessService,
} from "../../services/readiness.js";
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from "./integration-database.js";

describeWithIntegrationDatabase(
  "readiness service query and isolation budget",
  () => {
    let db: Database;
    let previousDriver: string | undefined;

    beforeAll(() => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
    });

    afterAll(async () => {
      await db?.destroy();
      restoreDatabaseDriver(previousDriver);
    });

    it("uses a bounded statement count and enforces the full event hierarchy", async () => {
      const runId = ulid().slice(-10).toLowerCase();
      const tenant = await new TenantRepository(db).create({
        name: `Readiness ${runId}`,
      });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Readiness ${runId}`,
        slug: `readiness-${runId}`,
      });
      const brand = await new BrandRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        name: `Readiness ${runId}`,
        slug: `readiness-${runId}`,
      });
      const event = await new EventRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `readiness-${runId}`,
        title: "Readiness integration event",
        description: "Authoritative readiness test",
        currency: "USD",
        timezone: "UTC",
        startsAt: new Date("2027-01-01T18:00:00.000Z"),
      });
      const pool = await new InventoryPoolRepository(db).create({
        eventId: event.id,
        name: "Free RSVP inventory",
        totalCapacity: 50,
      });
      await new TicketTypeRepository(db).create({
        eventId: event.id,
        inventoryPoolId: pool.id,
        name: "Free RSVP",
        kind: "free",
        status: "active",
        currency: "USD",
        priceCents: 0,
      });

      let statementCount = 0;
      const countingPlugin: KyselyPlugin = {
        transformQuery(args: PluginTransformQueryArgs) {
          statementCount += 1;
          return args.node;
        },
        async transformResult(args: PluginTransformResultArgs) {
          return args.result;
        },
      };
      const countingDb = db.withPlugin(countingPlugin);
      const service = new ReadinessService(countingDb, "capture");
      const permissions = new Set([
        "events.read",
        "events.write",
        "tickets.write",
        "orders.write",
        "messages.write",
        "billing.write",
        "checkins.write",
      ] as const);

      const readiness = await service.getEventLaunchReadiness({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        eventId: event.id,
        permissions,
      });

      expect(statementCount).toBeLessThanOrEqual(EVENT_READINESS_QUERY_BUDGET);
      expect(
        readiness.steps.find((step) => step.id === "payment_readiness"),
      ).toMatchObject({
        status: "not_applicable",
        reasonCodes: ["payment_not_required"],
      });
      statementCount = 0;
      const workspace = await service.getWorkspaceReadiness({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        permissions,
      });
      expect(statementCount).toBeLessThanOrEqual(
        WORKSPACE_READINESS_QUERY_BUDGET,
      );
      expect(workspace.organizationId).toBe(organization.id);
      await expect(
        service.getEventLaunchReadiness({
          tenantId: `wrong_${tenant.id}`,
          organizationId: organization.id,
          brandId: brand.id,
          eventId: event.id,
          permissions,
        }),
      ).rejects.toThrow("Event readiness scope was not found");
    });
  },
);
