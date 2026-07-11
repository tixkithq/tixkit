import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@tixkit/db";
import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  type MigrationEntityType,
  type NormalizedMigrationEntity,
} from "@tixkit/migration-core";
import type {
  MigrationCommitOutcome,
  MigrationCommitterRegistry,
  MigrationDomainCommitter,
} from "./migration-repository-service.js";

const REQUIRED_ATTRIBUTES: Record<MigrationEntityType, readonly string[]> = {
  organization: ["name"],
  brand: ["name"],
  venue: ["name"],
  event: ["title", "currency", "timezone"],
  occurrence: ["startsAt", "endsAt", "timezone"],
  "inventory-pool": ["name", "totalCapacity"],
  "ticket-type": ["name", "currency", "priceMinor"],
  product: ["name", "currency", "priceMinor"],
  question: ["label", "type"],
  discount: ["code", "type", "value"],
  "access-code": ["code"],
  buyer: ["email"],
  attendee: ["email"],
  "historical-order": ["orderNumber", "currency", "totalMinor", "buyerEmail"],
  ticket: ["code"],
  "historical-payment": [],
  "historical-refund": [],
  "check-in": ["occurredAt"],
};

const HISTORICAL_TYPES = new Set<MigrationEntityType>([
  "historical-order",
  "historical-payment",
  "historical-refund",
  "check-in",
]);

function assertRequiredAttributes(entity: NormalizedMigrationEntity): void {
  for (const name of REQUIRED_ATTRIBUTES[entity.entityType]) {
    const value = entity.attributes[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `MIGRATION_ATTRIBUTE_REQUIRED:${entity.entityType}:${name}`,
      );
    }
  }
  if (
    (entity.entityType === "historical-payment" ||
      entity.entityType === "historical-refund") &&
    !entity.financialSnapshot
  ) {
    throw new Error(
      `MIGRATION_FINANCIAL_SNAPSHOT_REQUIRED:${entity.entityType}`,
    );
  }
}

function assertSuppressedSideEffects(
  input: Parameters<MigrationDomainCommitter["commit"]>[0],
): void {
  const policy = input.sideEffects;
  if (
    policy.fulfillment !== "suppressed" ||
    policy.notifications !== "suppressed" ||
    policy.webhooks !== "suppressed" ||
    policy.providerSuccessEvents !== "suppressed" ||
    policy.financialRecords !== "historical_snapshots_only"
  ) {
    throw new Error("MIGRATION_SIDE_EFFECT_POLICY_REJECTED");
  }
}

type DependencyIds = ReadonlyMap<MigrationEntityType, string>;

const CANONICAL_TABLE: Record<MigrationEntityType, string> = {
  organization: "organizations",
  brand: "brands",
  venue: "venues",
  event: "events",
  occurrence: "event_occurrences",
  "inventory-pool": "inventory_pools",
  "ticket-type": "ticket_types",
  product: "products",
  question: "questions",
  discount: "discount_codes",
  "access-code": "access_rules",
  buyer: "buyers",
  attendee: "attendees",
  "historical-order": "orders",
  ticket: "tickets",
  "historical-payment": "historical_financial_snapshots",
  "historical-refund": "historical_financial_snapshots",
  "check-in": "historical_check_ins",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function canonicalHash(
  tx: any,
  type: MigrationEntityType,
  id: string,
  lock = false,
): Promise<string | undefined> {
  let query = tx
    .selectFrom(CANONICAL_TABLE[type])
    .selectAll()
    .where("id", "=", id);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify(row, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    )
    .digest("hex");
}

function textAttribute(
  entity: NormalizedMigrationEntity,
  name: string,
  fallback = "",
): string {
  const value = entity.attributes[name];
  return value === undefined || value === null ? fallback : String(value);
}

function numberAttribute(
  entity: NormalizedMigrationEntity,
  name: string,
  fallback = 0,
): number {
  const value = Number(entity.attributes[name] ?? fallback);
  if (!Number.isFinite(value))
    throw new Error(`MIGRATION_ATTRIBUTE_INVALID:${entity.entityType}:${name}`);
  return value;
}

function dependency(ids: DependencyIds, type: MigrationEntityType): string {
  const id = ids.get(type);
  if (!id) throw new Error(`MIGRATION_DEPENDENCY_REQUIRED:${type}`);
  return id;
}

// Kysely cannot express a switch whose branches target unrelated tables as one generic type.
// Every branch below remains a concrete, parameterized query inside the caller's transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeCanonicalEntity(
  tx: any,
  input: {
    tenantId: string;
    jobId: string;
    organizationId: string;
    id: string;
    entity: NormalizedMigrationEntity;
    dependencies: DependencyIds;
    existing: boolean;
    provenance: string;
    now: Date;
  },
): Promise<void> {
  const { entity, dependencies: deps, id, now } = input;
  const organizationId = input.organizationId;
  const updateOrInsert = async (
    table: string,
    values: Record<string, unknown>,
  ) => {
    if (input.existing) {
      let update = tx.updateTable(table).set(values).where("id", "=", id);
      if (
        new Set([
          "brands",
          "venues",
          "events",
          "buyers",
          "orders",
          "historical_financial_snapshots",
          "historical_check_ins",
        ]).has(table)
      ) {
        update = update.where("organization_id", "=", input.organizationId);
      }
      if (new Set(["venues", "buyers", "orders"]).has(table)) {
        update = update.where("tenant_id", "=", input.tenantId);
      }
      const result = await update.executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new Error(
          `MIGRATION_CANONICAL_ENTITY_MISSING:${entity.entityType}:${id}`,
        );
    } else {
      await tx
        .insertInto(table)
        .values({ id, ...values })
        .execute();
    }
  };

  switch (entity.entityType) {
    case "organization":
      if (!input.existing || id !== input.organizationId) {
        throw new Error("MIGRATION_ORGANIZATION_TARGET_REQUIRED");
      }
      if (
        Number(
          (
            await tx
              .updateTable("organizations")
              .set({
                name: textAttribute(entity, "name"),
                updated_at: now,
              })
              .where("tenant_id", "=", input.tenantId)
              .where("id", "=", input.organizationId)
              .executeTakeFirst()
          ).numUpdatedRows,
        ) !== 1
      )
        throw new Error("MIGRATION_ORGANIZATION_TARGET_NOT_FOUND");
      return;
    case "brand":
      await updateOrInsert("brands", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        name: textAttribute(entity, "name"),
        slug: textAttribute(entity, "slug", `import-${id}`),
        status: "active",
        theme: "{}",
        email_identity_id: null,
        sms_identity_id: null,
        payment_account_id: null,
        support_url: null,
        legal_urls: "{}",
        white_label: false,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "venue":
      await updateOrInsert("venues", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        name: textAttribute(entity, "name"),
        address: textAttribute(entity, "address") || null,
        timezone: textAttribute(entity, "timezone") || null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "event":
      await updateOrInsert("events", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        brand_id: dependency(deps, "brand"),
        venue_id: deps.get("venue") ?? null,
        slug: textAttribute(entity, "slug", `import-${id}`),
        title: textAttribute(entity, "title"),
        description: textAttribute(entity, "description") || null,
        status: "draft",
        currency: textAttribute(entity, "currency"),
        timezone: textAttribute(entity, "timezone"),
        starts_at: new Date(
          textAttribute(entity, "startsAt", now.toISOString()),
        ),
        ends_at: null,
        venue: null,
        visibility: "private",
        seo: "{}",
        capacity: null,
        minimum_age: null,
        cover_image_url: null,
        external_url: null,
        last_setup_section: null,
        cover_image_alt: null,
        resale_max_absolute_cents: null,
        code_format: null,
        public_revision: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "occurrence":
      await updateOrInsert("event_occurrences", {
        event_id: dependency(deps, "event"),
        title: textAttribute(entity, "title", "Imported occurrence"),
        starts_at: new Date(textAttribute(entity, "startsAt")),
        ends_at: new Date(textAttribute(entity, "endsAt")),
        timezone: textAttribute(entity, "timezone"),
        venue: null,
        venue_id: deps.get("venue") ?? null,
        capacity: null,
        sort_order: 0,
        status: "active",
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "inventory-pool":
      await updateOrInsert("inventory_pools", {
        event_id: dependency(deps, "event"),
        name: textAttribute(entity, "name"),
        total_capacity: numberAttribute(entity, "totalCapacity"),
        hold_ttl_seconds: 900,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "ticket-type":
      await updateOrInsert("ticket_types", {
        event_id: dependency(deps, "event"),
        name: textAttribute(entity, "name"),
        description: null,
        kind: "paid",
        status: "active",
        visibility: "visible",
        currency: textAttribute(entity, "currency"),
        price_cents: numberAttribute(entity, "priceMinor"),
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: dependency(deps, "inventory-pool"),
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: deps.get("occurrence") ?? null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "product":
      await updateOrInsert("products", {
        event_id: dependency(deps, "event"),
        name: textAttribute(entity, "name"),
        description: null,
        price_cents: numberAttribute(entity, "priceMinor"),
        currency: textAttribute(entity, "currency"),
        category_id: null,
        max_per_order: 10,
        available_from: null,
        available_until: null,
        status: "active",
        sort_order: 0,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "question":
      await updateOrInsert("questions", {
        event_id: dependency(deps, "event"),
        ticket_type_id: deps.get("ticket-type") ?? null,
        type: textAttribute(entity, "type"),
        label: textAttribute(entity, "label"),
        description: null,
        required: false,
        applies_to: "attendee",
        options: null,
        placeholder: null,
        validation_pattern: null,
        conditional_visibility: null,
        hidden_at: null,
        deleted_at: null,
        sort_order: 0,
        is_consent_field: false,
        consent_text: null,
        consent_version: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "discount":
      await updateOrInsert("discount_codes", {
        event_id: dependency(deps, "event"),
        code: textAttribute(entity, "code"),
        type: textAttribute(entity, "type"),
        value: numberAttribute(entity, "value"),
        currency: textAttribute(entity, "currency", "USD"),
        max_uses: numberAttribute(entity, "maxUses", 0),
        valid_from: null,
        valid_until: null,
        min_order_cents: null,
        max_discount_cents: null,
        ticket_type_ids: null,
        status: "active",
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "access-code":
      await updateOrInsert("access_rules", {
        ticket_type_id: dependency(deps, "ticket-type"),
        type: "code",
        value: textAttribute(entity, "code"),
        max_uses: null,
        expires_at: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "buyer":
      await updateOrInsert("buyers", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        email: textAttribute(entity, "email"),
        first_name: textAttribute(entity, "firstName") || null,
        last_name: textAttribute(entity, "lastName") || null,
        phone: textAttribute(entity, "phone") || null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "attendee":
      await updateOrInsert("attendees", {
        tenant_id: input.tenantId,
        order_id: deps.get("historical-order") ?? null,
        event_id: dependency(deps, "event"),
        event_occurrence_id: deps.get("occurrence") ?? null,
        ticket_type_id: dependency(deps, "ticket-type"),
        ticket_id: null,
        first_name: textAttribute(entity, "firstName") || null,
        last_name: textAttribute(entity, "lastName") || null,
        email: textAttribute(entity, "email"),
        phone: null,
        date_of_birth: null,
        status: "active",
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case "historical-order": {
      const sessionId = `ims_${id.slice(0, 28)}`;
      if (!input.existing)
        await tx
          .insertInto("checkout_sessions")
          .values({
            id: sessionId,
            tenant_id: input.tenantId,
            event_id: dependency(deps, "event"),
            brand_id: dependency(deps, "brand"),
            status: "completed",
            hold_id: null,
            currency: textAttribute(entity, "currency"),
            cart: "[]",
            buyer: JSON.stringify({
              email: textAttribute(entity, "buyerEmail"),
            }),
            quote: "{}",
            payment_intent_id: null,
            order_id: id,
            success_url: null,
            cancel_url: null,
            expires_at: now,
            idempotency_key: `import:${input.jobId}:${entity.externalId}`,
            client_token: randomUUID(),
            created_at: now,
            updated_at: now,
          })
          .execute();
      await updateOrInsert("orders", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        brand_id: dependency(deps, "brand"),
        event_id: dependency(deps, "event"),
        checkout_session_id: sessionId,
        order_number: textAttribute(entity, "orderNumber"),
        status: "historical",
        currency: textAttribute(entity, "currency"),
        subtotal_cents: numberAttribute(
          entity,
          "subtotalMinor",
          numberAttribute(entity, "totalMinor"),
        ),
        discount_cents: numberAttribute(entity, "discountMinor"),
        tax_cents: numberAttribute(entity, "taxMinor"),
        fee_cents: numberAttribute(entity, "feeMinor"),
        total_cents: numberAttribute(entity, "totalMinor"),
        buyer_email: textAttribute(entity, "buyerEmail"),
        buyer_first_name: null,
        buyer_last_name: null,
        buyer_phone: null,
        buyer_date_of_birth: null,
        payment_intent_id: null,
        payment_provider: null,
        operator_id: null,
        tender_type: null,
        paid_at: null,
        refunded_at: null,
        cancelled_at: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      await tx
        .updateTable("attendees")
        .set({ order_id: id, updated_at: now })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", deps.get("attendee") ?? "")
        .execute();
      await tx
        .updateTable("imported_domain_entities")
        .set({
          canonical_hash: await canonicalHash(
            tx,
            "attendee",
            dependency(deps, "attendee"),
          ),
        })
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", dependency(deps, "attendee"))
        .execute();
      return;
    }
    case "ticket":
      await updateOrInsert("tickets", {
        tenant_id: input.tenantId,
        order_id: dependency(deps, "historical-order"),
        attendee_id: dependency(deps, "attendee"),
        event_id: dependency(deps, "event"),
        event_occurrence_id: deps.get("occurrence") ?? null,
        ticket_type_id: dependency(deps, "ticket-type"),
        status: "valid",
        code: textAttribute(entity, "code"),
        qr_payload: textAttribute(entity, "code"),
        qr_hash: textAttribute(entity, "code"),
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      await tx
        .updateTable("attendees")
        .set({ ticket_id: id, updated_at: now })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", dependency(deps, "attendee"))
        .execute();
      await tx
        .updateTable("imported_domain_entities")
        .set({
          canonical_hash: await canonicalHash(
            tx,
            "attendee",
            dependency(deps, "attendee"),
          ),
        })
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", dependency(deps, "attendee"))
        .execute();
      return;
    case "historical-payment":
    case "historical-refund": {
      const snapshot = entity.financialSnapshot!;
      await updateOrInsert("historical_financial_snapshots", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        order_id: dependency(deps, "historical-order"),
        kind: snapshot.kind,
        amount_minor: snapshot.amountMinor,
        currency: snapshot.currency,
        provider_reference: snapshot.providerReference ?? null,
        occurred_at: new Date(snapshot.occurredAt),
        provenance: JSON.stringify(snapshot.provenance),
        reconciliation_status: snapshot.reconciliationStatus,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    }
    case "check-in":
      await updateOrInsert("historical_check_ins", {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        ticket_id: dependency(deps, "ticket"),
        occurred_at: new Date(textAttribute(entity, "occurredAt")),
        result: textAttribute(entity, "result", "accepted"),
        provenance: input.provenance,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deleteCanonicalEntity(
  tx: any,
  input: {
    tenantId: string;
    organizationId: string;
    id: string;
    type: MigrationEntityType;
  },
): Promise<boolean> {
  const table: Record<MigrationEntityType, string> = {
    organization: "organizations",
    brand: "brands",
    venue: "venues",
    event: "events",
    occurrence: "event_occurrences",
    "inventory-pool": "inventory_pools",
    "ticket-type": "ticket_types",
    product: "products",
    question: "questions",
    discount: "discount_codes",
    "access-code": "access_rules",
    buyer: "buyers",
    attendee: "attendees",
    "historical-order": "orders",
    ticket: "tickets",
    "historical-payment": "historical_financial_snapshots",
    "historical-refund": "historical_financial_snapshots",
    "check-in": "historical_check_ins",
  };
  if (input.type === "ticket") {
    await tx
      .updateTable("attendees")
      .set({ ticket_id: null })
      .where("tenant_id", "=", input.tenantId)
      .where("ticket_id", "=", input.id)
      .execute();
  }
  if (input.type === "historical-order") {
    await tx
      .updateTable("attendees")
      .set({ order_id: null })
      .where("tenant_id", "=", input.tenantId)
      .where("order_id", "=", input.id)
      .execute();
  }
  let deletion = tx.deleteFrom(table[input.type]).where("id", "=", input.id);
  if (
    new Set<MigrationEntityType>([
      "brand",
      "venue",
      "event",
      "buyer",
      "historical-order",
      "historical-payment",
      "historical-refund",
      "check-in",
    ]).has(input.type)
  ) {
    deletion = deletion.where("organization_id", "=", input.organizationId);
  }
  if (
    new Set<MigrationEntityType>([
      "venue",
      "buyer",
      "historical-order",
      "ticket",
    ]).has(input.type)
  ) {
    deletion = deletion.where("tenant_id", "=", input.tenantId);
  }
  const result = await deletion.executeTakeFirst();
  if (Number(result.numDeletedRows) !== 1) return false;
  if (input.type === "historical-order") {
    await tx
      .deleteFrom("checkout_sessions")
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", `ims_${input.id.slice(0, 28)}`)
      .execute();
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hasAuthoritativeRollbackBlocker(
  tx: any,
  input: {
    tenantId: string;
    jobId: string;
    id: string;
    type: MigrationEntityType;
    canonicalHash: string;
  },
): Promise<boolean> {
  const count = async (table: string, column: string) =>
    Number(
      (
        await tx
          .selectFrom(table)
          .select(({ fn }: any) => fn.countAll().as("count"))
          .where(column, "=", input.id)
          .executeTakeFirstOrThrow()
      ).count,
    ) > 0;
  const hasExternalRows = async (table: string, column: string) => {
    const rows = await tx
      .selectFrom(table)
      .select(["id"])
      .where(column, "=", input.id)
      .execute();
    if (rows.length === 0) return false;
    const imported = await tx
      .selectFrom("imported_domain_entities")
      .select(["id"])
      .where("tenant_id", "=", input.tenantId)
      .where("created_by_import_job_id", "=", input.jobId)
      .where(
        "id",
        "in",
        rows.map((row: { id: string }) => row.id),
      )
      .execute();
    const importedIds = new Set(imported.map((row: { id: string }) => row.id));
    return rows.some((row: { id: string }) => !importedIds.has(row.id));
  };
  if (
    (await canonicalHash(tx, input.type, input.id, true)) !==
    input.canonicalHash
  )
    return true;
  if (input.type === "event" && (await hasExternalRows("orders", "event_id")))
    return true;
  if (
    input.type === "ticket-type" &&
    (await count("order_line_items", "ticket_type_id"))
  )
    return true;
  if (
    input.type === "product" &&
    (await count("order_line_items", "product_id"))
  )
    return true;
  if (input.type === "ticket") {
    const ticket = await tx
      .selectFrom("tickets")
      .select(["transferred_at", "checked_in_at", "updated_at"])
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!ticket || ticket.transferred_at || ticket.checked_in_at) return true;
    if (
      (await count("scan_logs", "ticket_id")) ||
      (await count("ticket_listings", "ticket_id"))
    )
      return true;
  }
  if (
    input.type === "historical-order" &&
    ((await count("payment_intents", "order_id")) ||
      (await count("refunds", "order_id")) ||
      (await count("order_timeline_events", "order_id")))
  )
    return true;
  if (input.type === "attendee") {
    const attendee = await tx
      .selectFrom("attendees")
      .select(["updated_at", "checked_in_at"])
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!attendee || attendee.checked_in_at) return true;
  }
  return false;
}

class ProductionMigrationCommitter implements MigrationDomainCommitter {
  constructor(
    private readonly db: Database,
    private readonly entityType: MigrationEntityType,
  ) {}

  async assessUntouched(
    input: Parameters<MigrationDomainCommitter["assessUntouched"]>[0],
  ) {
    return this.db.transaction().execute(async (transaction) => {
      const entity = await transaction
        .selectFrom("imported_domain_entities")
        .select(["created_by_import_job_id", "canonical_hash"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", input.tixkitId)
        .where("entity_type", "=", this.entityType)
        .executeTakeFirst();
      if (!entity || entity.created_by_import_job_id !== input.jobId)
        return {
          eligible: false,
          reason: "Import provenance does not own canonical entity",
        };
      const evidence = await transaction
        .selectFrom("import_job_rows")
        .select(["domain_activity_at", "rollback_blocked_reason"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("import_job_id", "=", input.jobId)
        .where("entity_type", "=", this.entityType)
        .where("tixkit_id", "=", input.tixkitId)
        .executeTakeFirst();
      if (
        !evidence ||
        evidence.domain_activity_at ||
        evidence.rollback_blocked_reason
      ) {
        return {
          eligible: false,
          reason:
            evidence?.rollback_blocked_reason ??
            "Domain activity recorded after import",
        };
      }
      if (
        await hasAuthoritativeRollbackBlocker(transaction, {
          tenantId: input.tenantId,
          jobId: input.jobId,
          id: input.tixkitId,
          type: this.entityType,
          canonicalHash: entity.canonical_hash,
        })
      ) {
        return {
          eligible: false,
          reason: "Authoritative domain activity or canonical edit detected",
        };
      }
      return { eligible: true };
    });
  }

  async commit(
    input: Parameters<MigrationDomainCommitter["commit"]>[0],
  ): Promise<MigrationCommitOutcome> {
    if (input.entity.entityType !== this.entityType)
      throw new Error("MIGRATION_COMMITTER_TYPE_MISMATCH");
    assertRequiredAttributes(input.entity);
    assertSuppressedSideEffects(input);

    return this.db.transaction().execute(async (transaction) => {
      const job = await transaction
        .selectFrom("import_jobs")
        .select(["source_system"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", input.jobId)
        .executeTakeFirst();
      if (!job) throw new Error("MIGRATION_JOB_NOT_FOUND");

      const dependencies = new Map<MigrationEntityType, string>();
      for (const dependency of input.entity.dependencies ?? []) {
        const reference = await transaction
          .selectFrom("external_references")
          .select(["tixkit_id"])
          .where("tenant_id", "=", input.tenantId)
          .where("organization_id", "=", input.organizationId)
          .where("source_system", "=", job.source_system)
          .where("entity_type", "=", dependency.entityType)
          .where("external_id", "=", dependency.externalId)
          .executeTakeFirst();
        if (!reference) {
          throw new Error(
            `MIGRATION_DEPENDENCY_UNRESOLVED:${dependency.entityType}:${dependency.externalId}`,
          );
        }
        dependencies.set(dependency.entityType, reference.tixkit_id);
      }

      const existingReference = await transaction
        .selectFrom("external_references")
        .select(["tixkit_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("source_system", "=", job.source_system)
        .where("entity_type", "=", this.entityType)
        .where("external_id", "=", input.entity.externalId)
        .executeTakeFirst();
      const existing = existingReference
        ? await transaction
            .selectFrom("imported_domain_entities")
            .selectAll()
            .where("tenant_id", "=", input.tenantId)
            .where("organization_id", "=", input.organizationId)
            .where("id", "=", existingReference.tixkit_id)
            .executeTakeFirst()
        : await transaction
            .selectFrom("imported_domain_entities")
            .selectAll()
            .where("tenant_id", "=", input.tenantId)
            .where("organization_id", "=", input.organizationId)
            .where("source_system", "=", job.source_system)
            .where("entity_type", "=", this.entityType)
            .where("source_external_id", "=", input.entity.externalId)
            .executeTakeFirst();
      const attributes = JSON.stringify(input.entity.attributes);
      const snapshot = input.entity.financialSnapshot
        ? JSON.stringify(input.entity.financialSnapshot)
        : null;
      const provenance = JSON.stringify({
        sourceSystem: job.source_system,
        sourceExternalId: input.entity.externalId,
        sourcePosition: input.entity.sourcePosition,
        importJobId: input.jobId,
      });
      const now = new Date();
      const id =
        existing?.id ??
        (this.entityType === "organization"
          ? input.organizationId
          : randomUUID().replaceAll("-", ""));
      const unchanged =
        existing?.attributes === attributes &&
        existing.financial_snapshot === snapshot;
      const canonicalExisting =
        Boolean(existing) || this.entityType === "organization";

      if (existing && unchanged) {
        await transaction
          .updateTable("imported_domain_entities")
          .set({ last_seen_import_job_id: input.jobId })
          .where("tenant_id", "=", input.tenantId)
          .where("organization_id", "=", input.organizationId)
          .where("id", "=", id)
          .execute();
        return { disposition: "skipped", tixkitId: id };
      }
      if (
        existing &&
        (this.entityType === "historical-payment" ||
          this.entityType === "historical-refund")
      ) {
        return { disposition: "conflict", tixkitId: id };
      }

      await writeCanonicalEntity(transaction, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        id,
        entity: input.entity,
        dependencies,
        existing: canonicalExisting,
        provenance,
        now,
      });
      const persistedCanonicalHash = await canonicalHash(
        transaction,
        this.entityType,
        id,
      );
      if (!persistedCanonicalHash)
        throw new Error(
          `MIGRATION_CANONICAL_ENTITY_MISSING:${this.entityType}:${id}`,
        );

      if (existing) {
        await transaction
          .updateTable("imported_domain_entities")
          .set({
            attributes,
            financial_snapshot: snapshot,
            source_provenance: provenance,
            canonical_hash: persistedCanonicalHash,
            last_seen_import_job_id: input.jobId,
            updated_at: now,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("organization_id", "=", input.organizationId)
          .where("id", "=", id)
          .execute();
        await transaction
          .deleteFrom("imported_entity_dependencies")
          .where("tenant_id", "=", input.tenantId)
          .where("organization_id", "=", input.organizationId)
          .where("entity_id", "=", id)
          .execute();
      } else {
        await transaction
          .insertInto("imported_domain_entities")
          .values({
            id,
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            created_by_import_job_id: input.jobId,
            last_seen_import_job_id: input.jobId,
            source_system: job.source_system,
            entity_type: this.entityType,
            source_external_id: input.entity.externalId,
            attributes,
            financial_snapshot: snapshot,
            source_provenance: provenance,
            canonical_hash: persistedCanonicalHash,
            side_effects_suppressed: HISTORICAL_TYPES.has(this.entityType),
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      if (dependencies.size > 0) {
        await transaction
          .insertInto("imported_entity_dependencies")
          .values(
            [...new Set(dependencies.values())].map((dependsOnId) => ({
              tenant_id: input.tenantId,
              organization_id: input.organizationId,
              entity_id: id,
              depends_on_entity_id: dependsOnId,
              created_at: now,
            })),
          )
          .execute();
      }
      return {
        disposition: canonicalExisting
          ? existing && unchanged
            ? "skipped"
            : "updated"
          : "created",
        tixkitId: id,
      };
    });
  }

  async deleteUntouched(
    input: Parameters<MigrationDomainCommitter["deleteUntouched"]>[0],
  ): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const entity = await transaction
        .selectFrom("imported_domain_entities")
        .select(["id", "created_by_import_job_id", "canonical_hash"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", input.tixkitId)
        .where("entity_type", "=", this.entityType)
        .forUpdate()
        .executeTakeFirst();
      if (!entity || entity.created_by_import_job_id !== input.jobId)
        return false;
      const evidence = await transaction
        .selectFrom("import_job_rows")
        .select(["domain_activity_at", "rollback_blocked_reason"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("import_job_id", "=", input.jobId)
        .where("entity_type", "=", this.entityType)
        .where("tixkit_id", "=", input.tixkitId)
        .executeTakeFirst();
      if (
        !evidence ||
        evidence.domain_activity_at ||
        evidence.rollback_blocked_reason
      )
        return false;
      if (
        await hasAuthoritativeRollbackBlocker(transaction, {
          tenantId: input.tenantId,
          jobId: input.jobId,
          id: input.tixkitId,
          type: this.entityType,
          canonicalHash: entity.canonical_hash,
        })
      )
        return false;
      const dependent = await transaction
        .selectFrom("imported_entity_dependencies")
        .select(["entity_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("depends_on_entity_id", "=", input.tixkitId)
        .executeTakeFirst();
      if (dependent) return false;
      await transaction
        .deleteFrom("imported_entity_dependencies")
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("entity_id", "=", input.tixkitId)
        .execute();
      if (
        !(await deleteCanonicalEntity(transaction, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          id: input.tixkitId,
          type: this.entityType,
        }))
      )
        return false;
      await transaction
        .deleteFrom("external_references")
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("entity_type", "=", this.entityType)
        .where("tixkit_id", "=", input.tixkitId)
        .where("created_by_import_job_id", "=", input.jobId)
        .execute();
      const rowResult = await transaction
        .updateTable("import_job_rows")
        .set({ status: "rolled-back", updated_at: new Date() })
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("import_job_id", "=", input.jobId)
        .where("entity_type", "=", this.entityType)
        .where("tixkit_id", "=", input.tixkitId)
        .where("status", "=", "created")
        .executeTakeFirst();
      if (Number(rowResult.numUpdatedRows) !== 1) return false;
      const result = await transaction
        .deleteFrom("imported_domain_entities")
        .where("tenant_id", "=", input.tenantId)
        .where("organization_id", "=", input.organizationId)
        .where("id", "=", input.tixkitId)
        .where("created_by_import_job_id", "=", input.jobId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    });
  }
}

export function createProductionMigrationCommitters(
  db: Database,
): MigrationCommitterRegistry {
  return new Map(
    MIGRATION_ENTITY_DEPENDENCY_ORDER.map((type) => [
      type,
      new ProductionMigrationCommitter(db, type),
    ]),
  );
}
