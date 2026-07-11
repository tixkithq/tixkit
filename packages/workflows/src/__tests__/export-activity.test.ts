import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PERFORMANCE_METRICS_PATH = process.env.PERFORMANCE_METRICS_PATH;

async function recordPerformanceMetric(
  metric: string,
  value: number,
): Promise<void> {
  if (!PERFORMANCE_METRICS_PATH) return;
  const target = path.resolve(PERFORMANCE_METRICS_PATH);
  await mkdir(path.dirname(target), { recursive: true });

  let existing: Record<string, number> = {};
  try {
    const decoded = JSON.parse(await readFile(target, "utf8"));
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      existing = decoded as Record<string, number>;
    }
  } catch {
    existing = {};
  }

  existing[metric] = Number(value.toFixed(2));
  await writeFile(target, `${JSON.stringify(existing, null, 2)}\n`);
}

const temporalState = vi.hoisted(() => ({
  workflowStart: vi.fn(async () => undefined),
}));

// Mock @temporalio/client so notification workflow start doesn't try to connect.
vi.mock("@temporalio/client", () => ({
  Connection: { connect: vi.fn(async () => ({ close: vi.fn() })) },
  Client: vi.fn(function Client() {
    return { workflow: { start: temporalState.workflowStart } };
  }),
}));

const s3Mock = vi.hoisted(() => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- vi.hoisted factories cannot reference outer runtime bindings.
  async function defaultSend(command: unknown) {
    const body = (command as { input?: { Body?: unknown } }).input?.Body;
    if (
      body &&
      typeof body === "object" &&
      "on" in body &&
      "once" in body &&
      "resume" in body &&
      typeof body.on === "function" &&
      typeof body.once === "function" &&
      typeof body.resume === "function"
    ) {
      await new Promise<void>((resolve, reject) => {
        const stream = body as unknown as {
          once: (event: string, callback: (error?: Error) => void) => void;
          resume: () => void;
        };
        stream.once("error", (error) => reject(error));
        stream.once("end", () => resolve());
        stream.resume();
      });
    }
    return {};
  }

  return {
    constructorConfigs: [] as unknown[],
    putObjectInputs: [] as Record<string, unknown>[],
    defaultSend,
    send: vi.fn(defaultSend),
  };
});

const excelMock = vi.hoisted(() => ({
  failImport: false,
  writeBuffer: vi.fn(async () =>
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x78, 0x6c, 0x73, 0x78]),
  ),
}));

vi.mock("exceljs", () => {
  if (excelMock.failImport) {
    throw new Error("exceljs unavailable");
  }

  class Worksheet {
    addRow = vi.fn();
  }

  class Workbook {
    readonly xlsx = {
      writeBuffer: excelMock.writeBuffer,
    };

    addWorksheet = vi.fn(() => new Worksheet());
  }

  return { default: { Workbook } };
});

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(config: unknown) {
      s3Mock.constructorConfigs.push(config);
    }

    send(command: unknown) {
      return s3Mock.send(command);
    }
  }

  class PutObjectCommand {
    readonly input: Record<string, unknown>;

    constructor(input: Record<string, unknown>) {
      this.input = input;
      s3Mock.putObjectInputs.push(input);
    }
  }

  return { S3Client, PutObjectCommand };
});

const dbState = vi.hoisted(() => ({
  exportJob: {
    id: "exp_1",
    tenant_id: "tnt_1",
    event_id: "evt_1",
    type: "attendees",
    format: "csv",
    status: "processing",
    filters: null,
    file_url: null,
    completed_at: null,
  } as Record<string, unknown>,
  event: {
    id: "evt_1",
    tenant_id: "tnt_1",
    organization_id: "org_1",
    brand_id: "brd_1",
  } as Record<string, unknown> | null,
  updateCalls: [] as Record<string, unknown>[],
  user: { email: "admin@test.com", tenant_id: "tnt_1" } as Record<
    string,
    unknown
  > | null,
  providerRoute: { id: "epr_1", brand_id: "brd_1" } as Record<
    string,
    unknown
  > | null,
  templateVersion: { id: "ntv_1" } as Record<string, unknown> | null,
  existingJob: undefined as Record<string, unknown> | undefined,
  createdJobs: [] as Record<string, unknown>[],
  updatedJobs: [] as Array<{ id: string; input: Record<string, unknown> }>,
  emailJobCreateError: null as Error | null,
  exportEvents: [] as Record<string, unknown>[],
  scanLogSelects: [] as unknown[][],
  scanLogOrderBys: [] as Array<{ column: string; direction: string }>,
  // Configurable row sets so each test can stage its own export dataset.
  attendees: [
    {
      id: "att_1",
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@test.com",
      phone: "+15550000001",
      status: "registered",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      order_id: "ord_1",
      ticket_type_id: "tt_1",
      custom_answers: null,
      checked_in_at: null,
      created_at: new Date("2026-06-01"),
    },
  ] as Record<string, unknown>[],
  orders: [
    {
      id: "ord_1",
      order_number: "TK-1001",
      status: "paid",
      total_cents: 10000,
      refunded_cents: 0,
      tax_cents: 500,
      fee_cents: 200,
      subtotal_cents: 9300,
      discount_cents: 0,
      currency: "USD",
      buyer_email: "buyer@test.com",
      buyer_first_name: "Ada",
      buyer_last_name: "Lovelace",
      paid_at: new Date("2026-06-01"),
      tenant_id: "tnt_1",
      organization_id: "org_1",
      brand_id: "brd_1",
      event_id: "evt_1",
      created_at: new Date("2026-06-01"),
    },
  ] as Record<string, unknown>[],
  tickets: [
    {
      id: "tkt_1",
      code: "TIX-1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      order_id: "ord_1",
      attendee_id: "att_1",
      ticket_type_id: "tt_1",
      status: "active",
      transferred_to_email: null,
      checked_in_at: null,
      created_at: new Date("2026-06-01"),
    },
  ] as Record<string, unknown>[],
  questions: [] as Record<string, unknown>[],
  scanLogs: [
    {
      id: "slog_1",
      check_in_list_id: "cil_1",
      device_id: "scanner_1",
      ticket_id: "tkt_1",
      qr_hash: "hash_1",
      outcome: "accepted",
      offline: false,
      tenant_id: "tnt_1",
      check_in_list_event_id: "evt_1",
      scanned_at: new Date("2026-06-01T12:00:00Z"),
      created_at: new Date("2026-06-01T12:00:01Z"),
    },
  ] as Record<string, unknown>[],
  destroy: vi.fn(),
}));

vi.mock("@tixkit/db", () => {
  class EmailJobRepository {
    async create(input: Record<string, unknown>) {
      if (dbState.emailJobCreateError) throw dbState.emailJobCreateError;
      dbState.createdJobs.push(input);
      return { id: "emj_1", status: "pending", ...input };
    }
    async findByIdempotencyKey() {
      return dbState.existingJob;
    }
    async update(id: string, input: Record<string, unknown>) {
      dbState.updatedJobs.push({ id, input });
      if (dbState.existingJob?.id === id) {
        Object.assign(dbState.existingJob, input);
        return dbState.existingJob;
      }
      return { id, ...input };
    }
  }

  function createQuery(table: string) {
    const conditions: Array<{ column: string; op: string; value: unknown }> =
      [];
    const joins: string[] = [];
    let selectedColumns: unknown[] | null = null;
    const orderBys: Array<{ column: string; direction: string }> = [];
    let rowLimit: number | null = null;
    let rowOffset = 0;
    const matchesConditions = (row: Record<string, unknown>) =>
      conditions.every((condition) => {
        const column = condition.column.includes(".")
          ? condition.column.split(".").at(-1)!
          : condition.column;
        let actual =
          condition.column === "check_in_lists.event_id"
            ? (row.check_in_list_event_id ?? row.event_id)
            : Object.prototype.hasOwnProperty.call(row, condition.column)
              ? row[condition.column]
              : row[column];
        if (
          actual === undefined &&
          condition.column === "organization_id" &&
          table === "orders"
        ) {
          actual = dbState.event?.organization_id;
        }
        if (
          actual === undefined &&
          condition.column === "brand_id" &&
          table === "orders"
        ) {
          actual = dbState.event?.brand_id;
        }
        if (
          actual === undefined &&
          (condition.column === "is_test" ||
            condition.column === "orders.is_test")
        ) {
          actual = false;
        }
        if (condition.op === "=") return actual === condition.value;
        if (condition.op === "in" && Array.isArray(condition.value)) {
          return condition.value.includes(actual);
        }
        if (condition.op === ">=" || condition.op === "<=") {
          const left =
            actual instanceof Date
              ? actual.getTime()
              : new Date(String(actual)).getTime();
          const right =
            condition.value instanceof Date
              ? condition.value.getTime()
              : new Date(String(condition.value)).getTime();
          if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
          return condition.op === ">=" ? left >= right : left <= right;
        }
        return true;
      });
    const applyQueryWindow = (rows: Record<string, unknown>[]) => {
      const start = rowOffset;
      const end = rowLimit == null ? undefined : start + rowLimit;
      return rows.slice(start, end);
    };
    const withJoinedOrder = (row: Record<string, unknown>) => {
      if (!joins.includes("orders")) return row;
      const order = dbState.orders.find(
        (candidate) => candidate.id === row.order_id,
      ) ?? {
        tenant_id: row.tenant_id,
        organization_id: dbState.event?.organization_id,
        brand_id: dbState.event?.brand_id,
      };
      return {
        ...row,
        ...Object.fromEntries(
          Object.entries(order).map(([key, value]) => [`orders.${key}`, value]),
        ),
      };
    };
    const withJoinedEvent = (row: Record<string, unknown>) => {
      if (!joins.includes("events")) return row;
      if (!dbState.event) return row;
      return {
        ...row,
        ...Object.fromEntries(
          Object.entries(dbState.event).map(([key, value]) => [
            `events.${key}`,
            value,
          ]),
        ),
      };
    };
    const query = {
      innerJoin(joinTable: string) {
        joins.push(joinTable);
        return query;
      },
      select(columns: unknown[]) {
        if (table === "scan_logs") {
          selectedColumns = columns;
          dbState.scanLogSelects.push(columns);
        }
        return query;
      },
      selectAll() {
        return query;
      },
      where(column: string, op: string, value: unknown) {
        conditions.push({ column, op, value });
        return query;
      },
      orderBy(column: string, direction = "asc") {
        orderBys.push({ column, direction });
        if (table === "scan_logs")
          dbState.scanLogOrderBys.push({ column, direction });
        return query;
      },
      limit(limit: number) {
        rowLimit = limit;
        return query;
      },
      offset(offset: number) {
        rowOffset = offset;
        return query;
      },
      async executeTakeFirst() {
        if (table === "export_jobs") return dbState.exportJob;
        if (table === "events") return dbState.event;
        if (table === "user_profiles") return dbState.user;
        if (table === "email_provider_routes") return dbState.providerRoute;
        if (table === "notification_templates as template")
          return dbState.templateVersion;
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === "export_jobs") return dbState.exportJob;
        if (table === "events" && dbState.event) return dbState.event;
        if (table === "user_profiles") return dbState.user;
        if (table === "email_provider_routes") return dbState.providerRoute;
        if (table === "notification_templates as template")
          return dbState.templateVersion;
        throw new Error(`No mock row for table ${table}`);
      },
      async execute() {
        if (table === "attendees")
          return applyQueryWindow(
            dbState.attendees.map(withJoinedOrder).filter(matchesConditions),
          );
        if (table === "orders")
          return applyQueryWindow(dbState.orders.filter(matchesConditions));
        if (table === "questions") return dbState.questions;
        if (table === "scan_logs") {
          const rows = applyQueryWindow(
            dbState.scanLogs
              .map(withJoinedEvent)
              .filter(matchesConditions)
              // oxlint-disable-next-line unicorn/no-array-sort -- filter creates a copy, and this package intentionally targets an ES2022 runtime without Array.prototype.toSorted.
              .sort((a, b) => {
                for (const orderBy of orderBys) {
                  const column = orderBy.column.includes(".")
                    ? orderBy.column.split(".").at(-1)!
                    : orderBy.column;
                  const aValue = a[column];
                  const bValue = b[column];
                  const aComparable =
                    aValue instanceof Date
                      ? aValue.getTime()
                      : String(aValue ?? "");
                  const bComparable =
                    bValue instanceof Date
                      ? bValue.getTime()
                      : String(bValue ?? "");
                  if (aComparable === bComparable) continue;
                  const direction = orderBy.direction === "desc" ? -1 : 1;
                  return aComparable > bComparable ? direction : -direction;
                }
                return 0;
              }),
          );

          if (!selectedColumns) return rows;
          const columns = selectedColumns;
          return rows.map((row) =>
            Object.fromEntries(
              columns.map((selection) => {
                const selectionText = String(selection);
                const [source, alias] = selectionText.split(/\s+as\s+/i);
                const sourceColumn = source.includes(".")
                  ? source.split(".").at(-1)!
                  : source;
                return [alias ?? sourceColumn, row[sourceColumn]];
              }),
            ),
          );
        }
        if (table === "tickets") {
          return applyQueryWindow(
            dbState.tickets.map(withJoinedOrder).filter(matchesConditions),
          );
        }
        return [];
      },
    };
    return query;
  }

  function createMockDb() {
    const db = {
      selectFrom: createQuery,
      updateTable: (table: string) => ({
        set: (values: Record<string, unknown>) => {
          dbState.updateCalls.push({ table, ...values });
          // Simulate the DB update by mutating the in-memory export job.
          if (table === "export_jobs") {
            Object.assign(dbState.exportJob, values);
          }
          return {
            where: () => ({
              execute: async () => [],
            }),
          };
        },
      }),
      insertInto: (table: string) => ({
        values: (values: Record<string, unknown>) => ({
          execute: async () => {
            if (table === "export_job_events") {
              dbState.exportEvents.push(values);
            }
          },
        }),
      }),
      transaction: () => ({
        execute: async (fn: (trx: typeof db) => Promise<unknown>) => fn(db),
      }),
      destroy: dbState.destroy,
    };
    return db;
  }

  return {
    createDb: createMockDb,
    EmailJobRepository,
  };
});

const {
  generateExportActivity,
  generateAndUploadExportActivity,
  uploadFileActivity,
  markExportFailedActivity,
  notifyExportCompleteActivity,
} = await import("../activities/export.js");

describe("generateExportActivity", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.event = {
      id: "evt_1",
      tenant_id: "tnt_1",
      organization_id: "org_1",
      brand_id: "brd_1",
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.questions = [];
    dbState.scanLogs = [
      {
        id: "slog_1",
        check_in_list_id: "cil_1",
        device_id: "scanner_1",
        ticket_id: "tkt_1",
        qr_hash: "hash_1",
        outcome: "accepted",
        offline: false,
        tenant_id: "tnt_1",
        check_in_list_event_id: "evt_1",
        scanned_at: new Date("2026-06-01T12:00:00Z"),
        created_at: new Date("2026-06-01T12:00:01Z"),
      },
    ];
    dbState.attendees = [
      {
        id: "att_1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@test.com",
        phone: "+15550000001",
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_1",
        ticket_type_id: "tt_1",
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
    ];
    dbState.orders = [
      {
        id: "ord_1",
        order_number: "TK-1001",
        status: "paid",
        total_cents: 10000,
        refunded_cents: 0,
        tax_cents: 500,
        fee_cents: 200,
        subtotal_cents: 9300,
        discount_cents: 0,
        currency: "USD",
        buyer_email: "buyer@test.com",
        buyer_first_name: "Ada",
        buyer_last_name: "Lovelace",
        paid_at: new Date("2026-06-01"),
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
        created_at: new Date("2026-06-01"),
      },
    ];
    dbState.tickets = [
      {
        id: "tkt_1",
        code: "TIX-1",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_1",
        attendee_id: "att_1",
        ticket_type_id: "tt_1",
        status: "active",
        transferred_to_email: null,
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
    ];
  });

  it("generates a CSV export for attendees", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.data).toContain("Ada");
      expect(result.value.data).toContain("ada@test.com");
    }
  });

  it("sets status to processing when generation starts", async () => {
    await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({ table: "export_jobs", status: "processing" }),
    );
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: "tnt_1",
      export_job_id: "exp_1",
      status: "processing",
    });
  });

  it("excludes same-event attendee rows outside the event organization and brand scope", async () => {
    dbState.attendees.push({
      id: "att_wrong_scope",
      first_name: "Mallory",
      last_name: "Mismatch",
      email: "mallory@test.com",
      phone: "+15550000002",
      status: "registered",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      order_id: "ord_wrong_scope",
      ticket_type_id: "tt_1",
      custom_answers: null,
      checked_in_at: null,
      created_at: new Date("2026-06-01"),
    });
    dbState.orders.push({
      ...dbState.orders[0],
      id: "ord_wrong_scope",
      order_number: "TK-1002",
      organization_id: "org_other",
      brand_id: "brd_other",
      buyer_email: "wrong-scope-buyer@test.com",
    });

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.data).toContain("ada@test.com");
      expect(result.value.data).not.toContain("mallory@test.com");
    }
  });

  it("excludes same-event order, sales, and tax rows outside the event organization and brand scope", async () => {
    dbState.orders.push({
      ...dbState.orders[0],
      id: "ord_wrong_scope",
      order_number: "TK-1002",
      organization_id: "org_other",
      brand_id: "brd_other",
      buyer_email: "wrong-scope-buyer@test.com",
    });

    for (const type of ["orders", "sales", "tax"]) {
      dbState.exportJob = { ...dbState.exportJob, type };
      const result = await generateExportActivity({
        exportId: "exp_1",
        type,
        format: "csv",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.rowCount).toBe(1);
        expect(result.value.data).toContain("TK-1001");
        expect(result.value.data).not.toContain("TK-1002");
        expect(result.value.data).not.toContain("wrong-scope-buyer@test.com");
      }
    }
  });

  it("excludes same-event ticket rows outside the event organization and brand scope", async () => {
    dbState.orders.push({
      ...dbState.orders[0],
      id: "ord_wrong_scope",
      order_number: "TK-1002",
      organization_id: "org_1",
      brand_id: "brd_other",
    });
    dbState.tickets.push({
      ...dbState.tickets[0],
      id: "tkt_wrong_scope",
      code: "TIX-WRONG",
      order_id: "ord_wrong_scope",
      attendee_id: "att_wrong_scope",
    });

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "tickets",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.data).toContain("TIX-1");
      expect(result.value.data).not.toContain("TIX-WRONG");
    }
  });

  it("excludes scan logs when the check-in list event does not match the export event scope", async () => {
    dbState.scanLogs.push({
      id: "slog_wrong_event",
      check_in_list_id: "cil_wrong",
      device_id: "scanner_2",
      ticket_id: "tkt_wrong_scope",
      qr_hash: "hash_wrong",
      outcome: "accepted",
      offline: false,
      tenant_id: "tnt_1",
      check_in_list_event_id: "evt_other",
      scanned_at: new Date("2026-06-01T12:01:00Z"),
      created_at: new Date("2026-06-01T12:01:01Z"),
    });

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.data).toContain("hash_1");
      expect(result.value.data).not.toContain("hash_wrong");
    }
  });
});

describe("uploadFileActivity", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    s3Mock.constructorConfigs.length = 0;
    s3Mock.putObjectInputs.length = 0;
    s3Mock.send.mockReset();
    s3Mock.send.mockImplementation(s3Mock.defaultSend);
    excelMock.failImport = false;
    excelMock.writeBuffer.mockReset();
    excelMock.writeBuffer.mockResolvedValue(
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x78, 0x6c, 0x73, 0x78]),
    );
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.EXPORT_PAGE_SIZE;
    delete process.env.EXPORT_STORAGE_MODE;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_FORCE_PATH_STYLE;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_BUCKET;
    delete process.env.S3_REGION;
    delete process.env.S3_EXPORT_BUCKET;
    delete process.env.S3_EXPORT_REGION;
  });

  it("returns a file URL based on bucket and key", async () => {
    const result = await uploadFileActivity({
      exportId: "exp_1",
      data: "id,name\n1,Test",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toContain("exp_1.csv");
      expect(result.value.fileUrl).toMatch(/^https:\/\//);
    }
  });

  it("uploads export data to the default S3 endpoint in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.S3_EXPORT_BUCKET = "exports-bucket";
    process.env.S3_EXPORT_REGION = "us-west-2";

    const result = await uploadFileActivity({
      exportId: "exp_1",
      data: "id,name\n1,Test",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    expect(s3Mock.send).toHaveBeenCalledTimes(1);
    expect(s3Mock.constructorConfigs[0]).toEqual({ region: "us-west-2" });
    expect(s3Mock.putObjectInputs[0]).toMatchObject({
      Bucket: "exports-bucket",
      Key: "exports/exp_1.csv",
      Body: "id,name\n1,Test",
      ContentType: "text/csv",
    });
  });

  it("builds file URLs from path-style S3-compatible endpoints", async () => {
    process.env.NODE_ENV = "production";
    process.env.S3_EXPORT_BUCKET = "exports-bucket";
    process.env.S3_EXPORT_REGION = "auto";
    process.env.S3_ENDPOINT = "https://storage.example.test/object-api";
    process.env.S3_FORCE_PATH_STYLE = "true";

    const result = await uploadFileActivity({
      exportId: "exp_1",
      data: "id,name\n1,Test",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toBe(
        "https://storage.example.test/object-api/exports-bucket/exports/exp_1.csv",
      );
    }
    expect(s3Mock.constructorConfigs[0]).toEqual({
      region: "auto",
      endpoint: "https://storage.example.test/object-api",
      forcePathStyle: true,
    });
    expect(s3Mock.putObjectInputs[0]).toMatchObject({
      Bucket: "exports-bucket",
      Key: "exports/exp_1.csv",
    });
  });

  it("uses the existing shared S3 bucket and region env when export-specific values are unset", async () => {
    process.env.NODE_ENV = "production";
    process.env.S3_BUCKET = "shared-bucket";
    process.env.S3_REGION = "eu-west-1";

    const result = await uploadFileActivity({
      exportId: "exp_1",
      data: '[{"id":"1"}]',
      format: "json",
    });

    expect(result.ok).toBe(true);
    expect(s3Mock.send).toHaveBeenCalledTimes(1);
    expect(s3Mock.constructorConfigs[0]).toEqual({ region: "eu-west-1" });
    expect(s3Mock.putObjectInputs[0]).toMatchObject({
      Bucket: "shared-bucket",
      Key: "exports/exp_1.json",
      Body: '[{"id":"1"}]',
      ContentType: "application/json",
    });
  });

  it("returns a failed activity result when production S3 upload fails", async () => {
    process.env.NODE_ENV = "production";
    s3Mock.send.mockRejectedValueOnce(new Error("Access denied"));

    const result = await uploadFileActivity({
      exportId: "exp_1",
      data: "id,name\n1,Test",
      format: "csv",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("FILE_UPLOAD_FAILED");
      expect(result.message).toBe("Access denied");
    }
  });

  it("streams generated CSV exports to S3 in the combined production activity", async () => {
    process.env.NODE_ENV = "production";
    process.env.S3_EXPORT_BUCKET = "exports-bucket";
    process.env.S3_EXPORT_REGION = "us-west-2";

    const result = await generateAndUploadExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.fileUrl).toContain("exp_1.csv");
    }
    expect(s3Mock.send).toHaveBeenCalledTimes(1);
    expect(s3Mock.putObjectInputs[0]).toMatchObject({
      Bucket: "exports-bucket",
      Key: "exports/exp_1.csv",
      ContentType: "text/csv",
    });
    expect(typeof s3Mock.putObjectInputs[0].Body).not.toBe("string");
    expect(s3Mock.putObjectInputs[0].Body).toEqual(
      expect.objectContaining({ pipe: expect.any(Function) }),
    );
  });

  it("uploads generated XLSX exports as binary ZIP data", async () => {
    process.env.NODE_ENV = "production";
    process.env.S3_EXPORT_BUCKET = "exports-bucket";
    process.env.S3_EXPORT_REGION = "us-west-2";

    const result = await generateAndUploadExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "xlsx",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.fileUrl).toContain("exp_1.xlsx");
    }
    expect(s3Mock.send).toHaveBeenCalledTimes(1);
    expect(s3Mock.putObjectInputs[0]).toMatchObject({
      Bucket: "exports-bucket",
      Key: "exports/exp_1.xlsx",
      ContentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const body = s3Mock.putObjectInputs[0].Body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).subarray(0, 2).toString("utf8")).toBe("PK");
  });

  it("fails XLSX generation instead of uploading CSV with XLSX metadata", async () => {
    process.env.NODE_ENV = "production";
    process.env.S3_EXPORT_BUCKET = "exports-bucket";
    process.env.S3_EXPORT_REGION = "us-west-2";
    excelMock.writeBuffer.mockRejectedValueOnce(
      new Error("excel writer unavailable"),
    );

    const result = await generateAndUploadExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "xlsx",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("EXPORT_GENERATION_FAILED");
      expect(result.message).toContain("XLSX export generation failed");
    }
    expect(s3Mock.send).not.toHaveBeenCalled();
    expect(s3Mock.putObjectInputs).toEqual([]);
  });

  it("records bounded heap growth for a streamed generated CSV export", async () => {
    process.env.NODE_ENV = "production";
    process.env.EXPORT_PAGE_SIZE = "100";
    process.env.S3_EXPORT_BUCKET = "exports-bucket";
    process.env.S3_EXPORT_REGION = "us-west-2";
    dbState.exportJob = {
      ...dbState.exportJob,
      id: "exp_memory",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
    };
    dbState.attendees = Array.from({ length: 2_500 }, (_, index) => ({
      id: `att_memory_${String(index).padStart(5, "0")}`,
      first_name: `First${index}`,
      last_name: `Last${index}`,
      email: `attendee-${index}@test.com`,
      phone: "+15550000001",
      status: "registered",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      order_id: `ord_memory_${index}`,
      ticket_type_id: "tt_1",
      custom_answers: null,
      checked_in_at: null,
      created_at: new Date("2026-06-01"),
    }));

    const heapBefore = process.memoryUsage().heapUsed;
    const result = await generateAndUploadExportActivity({
      exportId: "exp_memory",
      type: "attendees",
      format: "csv",
    });
    const heapDeltaBytes = Math.max(
      0,
      process.memoryUsage().heapUsed - heapBefore,
    );
    await recordPerformanceMetric("exportStreamHeapDeltaBytes", heapDeltaBytes);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(2_500);
      expect(result.value.fileUrl).toContain("exp_memory.csv");
    }
    expect(s3Mock.send).toHaveBeenCalledTimes(1);
    expect(typeof s3Mock.putObjectInputs[0].Body).not.toBe("string");
  });
});

describe("markExportFailedActivity", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
  });

  it("updates export job status to failed with a terminal timestamp", async () => {
    const result = await markExportFailedActivity({
      exportId: "exp_1",
      reason: "Upload failed",
    });

    expect(result.ok).toBe(true);
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: "export_jobs",
        status: "failed",
      }),
    );
    const failedUpdate = dbState.updateCalls.find(
      (c) => c.table === "export_jobs" && c.status === "failed",
    );
    expect(failedUpdate?.completed_at).toBeInstanceOf(Date);
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: "tnt_1",
      export_job_id: "exp_1",
      status: "failed",
    });
    expect(String(dbState.exportEvents[0].payload)).toContain("Upload failed");
  });
});

describe("notifyExportCompleteActivity", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.user = { email: "admin@test.com", tenant_id: "tnt_1" };
    dbState.providerRoute = { id: "epr_1", brand_id: "brd_1" };
    dbState.templateVersion = { id: "ntv_1" };
    dbState.createdJobs = [];
    dbState.updatedJobs = [];
    dbState.existingJob = undefined;
    dbState.emailJobCreateError = null;
    temporalState.workflowStart.mockReset();
    temporalState.workflowStart.mockResolvedValue(undefined);
  });

  it("updates export job status to completed and sets file_url", async () => {
    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notified).toBe(true);
    }

    // Verify the DB was updated to completed status with file URL.
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: "export_jobs",
        status: "completed",
        file_url: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      }),
    );
    // completed_at should be set to a Date.
    const completedUpdate = dbState.updateCalls.find(
      (c) => c.table === "export_jobs" && c.status === "completed",
    );
    expect(completedUpdate?.completed_at).toBeInstanceOf(Date);
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: "tnt_1",
      export_job_id: "exp_1",
      status: "completed",
    });
    expect(String(dbState.exportEvents[0].payload)).toContain(
      "/v1/exports/exp_1/download",
    );
    expect(String(dbState.exportEvents[0].payload)).not.toContain("fileUrl");
    expect(String(dbState.exportEvents[0].payload)).not.toContain(
      "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
    );
  });

  it("rejects unsafe completed export file URLs before persistence", async () => {
    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "javascript:alert(1)",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("INVALID_EXPORT_FILE_URL");
      expect(result.retryable).toBe(false);
    }
    expect(dbState.updateCalls).toHaveLength(0);
    expect(dbState.exportEvents).toHaveLength(0);
    expect(dbState.createdJobs).toHaveLength(0);
  });

  it("accepts loopback S3-compatible export file URLs for local object storage", async () => {
    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "http://localhost:9000/exports-bucket/exports/exp_1.csv",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(result.ok).toBe(true);
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: "export_jobs",
        status: "completed",
        file_url: "http://localhost:9000/exports-bucket/exports/exp_1.csv",
      }),
    );
  });

  it("queues an admin notification email with the scoped download route", async () => {
    await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(dbState.createdJobs).toHaveLength(1);
    expect(dbState.createdJobs[0]).toMatchObject({
      tenantId: "tnt_1",
      brandId: "brd_1",
      templateKey: "staff-order-notification",
      toEmail: "admin@test.com",
      providerRouteId: "epr_1",
      idempotencyKey: "export-complete:exp_1",
    });
    expect(dbState.createdJobs[0].variables).toMatchObject({
      exportId: "exp_1",
      downloadUrl: "/v1/exports/exp_1/download",
    });
    expect(dbState.createdJobs[0].variables).not.toHaveProperty("fileUrl");
    expect(dbState.updatedJobs).toContainEqual({
      id: "emj_1",
      input: { status: "queued", workflow_id: "notification:emj_1" },
    });
  });

  it("keeps the completed export and reports retryable notification failure when queueing fails", async () => {
    dbState.emailJobCreateError = new Error("email job database unavailable");

    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "EXPORT_NOTIFICATION_FAILED",
      retryable: true,
    });
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: "export_jobs",
        status: "completed",
        file_url: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      }),
    );
    expect(dbState.exportEvents).toContainEqual(
      expect.objectContaining({
        tenant_id: "tnt_1",
        export_job_id: "exp_1",
        status: "completed",
      }),
    );
    expect(dbState.createdJobs).toHaveLength(0);
  });

  it("marks the export email job start_failed when Temporal rejects the handoff", async () => {
    temporalState.workflowStart.mockRejectedValue(
      new Error("Temporal unavailable"),
    );

    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "EXPORT_NOTIFICATION_FAILED",
      retryable: true,
    });
    expect(dbState.createdJobs).toHaveLength(1);
    expect(dbState.updatedJobs).toContainEqual({
      id: "emj_1",
      input: { status: "start_failed", workflow_id: null },
    });
  });

  it("restarts an existing queued export email with no durable workflow id", async () => {
    dbState.existingJob = {
      id: "emj_existing",
      tenant_id: "tnt_1",
      brand_id: "brd_1",
      template_key: "staff-order-notification",
      template_version_id: "ntv_1",
      to_email: "admin@test.com",
      to_name: null,
      variables: JSON.stringify({
        notificationType: "staff",
        exportId: "exp_1",
      }),
      provider_route_id: "epr_1",
      status: "queued",
      workflow_id: null,
      scheduled_at: null,
    };

    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    expect(result).toEqual({ ok: true, value: { notified: true } });
    expect(dbState.createdJobs).toHaveLength(0);
    expect(temporalState.workflowStart).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ workflowId: "notification:emj_existing" }),
    );
    expect(dbState.updatedJobs).toContainEqual({
      id: "emj_existing",
      input: { status: "queued", workflow_id: "notification:emj_existing" },
    });
  });

  it("still marks export as completed when no user email is found", async () => {
    dbState.user = null;

    const result = await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: "https://bucket.s3.amazonaws.com/exports/exp_1.csv",
      requestedBy: "usr_unknown",
      tenantId: "tnt_1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notified).toBe(true);
    }
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: "export_jobs",
        status: "completed",
      }),
    );
    // No email job should be created.
    expect(dbState.createdJobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T30: Export file content validation
// These suites validate the actual generated CSV content (headers, data rows,
// field counts, financial totals, question/consent answer columns, and failure
// recovery) rather than only the workflow status transitions.
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into a 2D array of cells. Handles quoted fields containing
 * commas, doubled-quote escapes, and newlines. Splits on `\n` (the export
 * activity joins rows with `\n`).
 */
function parseCsv(csv: string | Buffer): string[][] {
  if (Buffer.isBuffer(csv)) {
    throw new Error("Expected CSV export data to be text");
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Trailing field/row (no final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("T30 export content validation - attendee CSV", () => {
  beforeEach(() => {
    delete process.env.EXPORT_PAGE_SIZE;
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.questions = [];
    dbState.attendees = [
      {
        id: "att_1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@test.com",
        phone: "+15550000001",
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_1",
        ticket_type_id: "tt_1",
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date("2026-06-01T10:00:00Z"),
      },
      {
        id: "att_2",
        first_name: "Grace",
        last_name: "Hopper",
        email: "grace@test.com",
        phone: "+15550000002",
        status: "checked_in",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_2",
        ticket_type_id: "tt_1",
        custom_answers: null,
        checked_in_at: new Date("2026-06-01T11:00:00Z"),
        created_at: new Date("2026-06-01T09:00:00Z"),
      },
    ];
  });

  it("emits the expected attendee export headers in order", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    expect(headers).toEqual([
      "id",
      "email",
      "firstName",
      "lastName",
      "phone",
      "status",
      "eventId",
      "orderId",
      "checkedInAt",
      "createdAt",
    ]);
  });

  it("produces one data row per attendee plus a header row", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    // header + 2 data rows
    expect(rows).toHaveLength(3);
    // Every data row has the same number of fields as the header row.
    for (const row of rows) {
      expect(row).toHaveLength(rows[0].length);
    }
  });

  it("streams attendee export rows across multiple query pages", async () => {
    process.env.EXPORT_PAGE_SIZE = "1";

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    expect(rows.map((row) => row[1])).toEqual([
      "email",
      "ada@test.com",
      "grace@test.com",
    ]);
  });

  it("includes rows through the end of a date-only to filter", async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: JSON.stringify({ from: "2026-06-01", to: "2026-06-01" }),
    };

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    expect(rows.map((row) => row[1])).toEqual([
      "email",
      "ada@test.com",
      "grace@test.com",
    ]);
  });

  it("includes attendee field values in the correct columns", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const emailCol = headers.indexOf("email");
    const firstNameCol = headers.indexOf("firstName");
    const lastNameCol = headers.indexOf("lastName");
    const statusCol = headers.indexOf("status");

    // First attendee (Ada)
    expect(rows[1][emailCol]).toBe("ada@test.com");
    expect(rows[1][firstNameCol]).toBe("Ada");
    expect(rows[1][lastNameCol]).toBe("Lovelace");
    expect(rows[1][statusCol]).toBe("registered");

    // Second attendee (Grace)
    expect(rows[2][emailCol]).toBe("grace@test.com");
    expect(rows[2][firstNameCol]).toBe("Grace");
    expect(rows[2][statusCol]).toBe("checked_in");
  });

  it("returns an empty CSV body (no header) when there are zero attendees", async () => {
    dbState.attendees = [];
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(0);
    // toCsv returns '' for empty row sets.
    expect(result.value.data).toBe("");
  });
});

describe("T30 export content validation - sales report CSV", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "sales",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.questions = [];
    dbState.orders = [
      {
        id: "ord_1",
        order_number: "TK-1001",
        status: "paid",
        total_cents: 10000,
        refunded_cents: 0,
        tax_cents: 500,
        fee_cents: 200,
        currency: "USD",
        buyer_email: "buyer@test.com",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        created_at: new Date("2026-06-01"),
      },
      {
        id: "ord_2",
        order_number: "TK-1002",
        status: "partially_refunded",
        total_cents: 5000,
        refunded_cents: 1500,
        tax_cents: 250,
        fee_cents: 100,
        currency: "USD",
        buyer_email: "buyer2@test.com",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        created_at: new Date("2026-06-02"),
      },
    ];
  });

  it("emits the expected sales report headers in order", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "sales",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    expect(rows[0]).toEqual([
      "orderId",
      "orderNumber",
      "status",
      "currency",
      "grossCents",
      "refundedCents",
      "netCents",
      "taxCents",
      "feeCents",
      "buyerEmail",
      "createdAt",
    ]);
  });

  it("produces one data row per order plus a header row with consistent field counts", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "sales",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    expect(rows).toHaveLength(3);
    const headerLen = rows[0].length;
    for (const row of rows) {
      expect(row).toHaveLength(headerLen);
    }
  });

  it("computes gross, refunded, and net financial totals correctly per row", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "sales",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const grossCol = headers.indexOf("grossCents");
    const refundedCol = headers.indexOf("refundedCents");
    const netCol = headers.indexOf("netCents");
    const taxCol = headers.indexOf("taxCents");
    const feeCol = headers.indexOf("feeCents");

    // Order 1: gross 10000, refunded 0, net 10000
    expect(Number(rows[1][grossCol])).toBe(10000);
    expect(Number(rows[1][refundedCol])).toBe(0);
    expect(Number(rows[1][netCol])).toBe(10000);
    expect(Number(rows[1][taxCol])).toBe(500);
    expect(Number(rows[1][feeCol])).toBe(200);

    // Order 2: gross 5000, refunded 1500, net 3500
    expect(Number(rows[2][grossCol])).toBe(5000);
    expect(Number(rows[2][refundedCol])).toBe(1500);
    expect(Number(rows[2][netCol])).toBe(3500);
  });

  it("aggregates financial totals across all rows match the sum of the dataset", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "sales",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const grossCol = headers.indexOf("grossCents");
    const refundedCol = headers.indexOf("refundedCents");
    const netCol = headers.indexOf("netCents");

    let totalGross = 0;
    let totalRefunded = 0;
    let totalNet = 0;
    for (let i = 1; i < rows.length; i++) {
      totalGross += Number(rows[i][grossCol]);
      totalRefunded += Number(rows[i][refundedCol]);
      totalNet += Number(rows[i][netCol]);
    }

    expect(totalGross).toBe(15000);
    expect(totalRefunded).toBe(1500);
    expect(totalNet).toBe(13500);
    // net must equal gross - refunded
    expect(totalNet).toBe(totalGross - totalRefunded);
  });
});

describe("T30 export content validation - checkout question answers", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.event = {
      id: "evt_1",
      tenant_id: "tnt_1",
      organization_id: "org_1",
      brand_id: "brd_1",
    };
    dbState.orders = [
      {
        id: "ord_1",
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
      },
      {
        id: "ord_2",
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
      },
    ];
    dbState.questions = [
      {
        id: "q_company",
        label: "Company Name",
        is_consent_field: false,
        consent_text: null,
        consent_version: null,
        applies_to: "attendee",
        ticket_type_id: null,
        sort_order: 1,
      },
      {
        id: "q_shirt",
        label: "T-Shirt Size",
        is_consent_field: false,
        consent_text: null,
        consent_version: null,
        applies_to: "attendee",
        ticket_type_id: null,
        sort_order: 2,
      },
    ];
    dbState.attendees = [
      {
        id: "att_1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@test.com",
        phone: null,
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_1",
        ticket_type_id: "tt_1",
        custom_answers: JSON.stringify({
          q_company: "Analytical Engines Inc.",
          q_shirt: ["S", "M"],
        }),
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
      {
        id: "att_2",
        first_name: "Grace",
        last_name: "Hopper",
        email: "grace@test.com",
        phone: null,
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_2",
        ticket_type_id: "tt_1",
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
    ];
  });

  it("appends question label columns after the base attendee columns", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const baseHeaderCount = 10;
    expect(headers.slice(0, baseHeaderCount)).toEqual([
      "id",
      "email",
      "firstName",
      "lastName",
      "phone",
      "status",
      "eventId",
      "orderId",
      "checkedInAt",
      "createdAt",
    ]);
    // Question columns appended in sort order.
    expect(headers.slice(baseHeaderCount)).toEqual([
      "Company Name",
      "T-Shirt Size",
    ]);
  });

  it('populates question answer values from custom_answers, joining arrays with "; "', async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const companyCol = headers.indexOf("Company Name");
    const shirtCol = headers.indexOf("T-Shirt Size");

    // Ada answered both questions.
    expect(rows[1][companyCol]).toBe("Analytical Engines Inc.");
    expect(rows[1][shirtCol]).toBe("S; M");

    // Grace has no answers; cells should be empty.
    expect(rows[2][companyCol]).toBe("");
    expect(rows[2][shirtCol]).toBe("");
  });

  it("keeps all rows at the same field count including question columns", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headerLen = rows[0].length;
    expect(headerLen).toBe(12); // 10 base + 2 questions
    for (const row of rows) {
      expect(row).toHaveLength(headerLen);
    }
  });

  it("does not append question columns when no questions are configured", async () => {
    dbState.questions = [];
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    expect(rows[0]).toHaveLength(10);
  });
});

describe("T30 export content validation - consent field data", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.event = {
      id: "evt_1",
      tenant_id: "tnt_1",
      organization_id: "org_1",
      brand_id: "brd_1",
    };
    dbState.orders = [
      {
        id: "ord_1",
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
      },
      {
        id: "ord_2",
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
      },
      {
        id: "ord_3",
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
      },
    ];
    dbState.questions = [
      {
        id: "q_marketing",
        label: "Marketing Consent",
        is_consent_field: true,
        consent_text: "I agree to receive marketing emails.",
        consent_version: "v2",
        applies_to: "attendee",
        ticket_type_id: null,
        sort_order: 1,
      },
    ];
    dbState.attendees = [
      {
        id: "att_1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@test.com",
        phone: null,
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_1",
        ticket_type_id: "tt_1",
        custom_answers: JSON.stringify({
          q_marketing: {
            accepted: true,
            consentText: "I agree to receive marketing emails.",
            consentVersion: "v2",
            consentedAt: "2026-06-01T10:00:00.000Z",
          },
        }),
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
      {
        id: "att_2",
        first_name: "Grace",
        last_name: "Hopper",
        email: "grace@test.com",
        phone: null,
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_2",
        ticket_type_id: "tt_1",
        // Bare boolean true (no snapshot) - should fall back to question definition.
        custom_answers: JSON.stringify({ q_marketing: true }),
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
      {
        id: "att_3",
        first_name: "Alan",
        last_name: "Turing",
        email: "alan@test.com",
        phone: null,
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_3",
        ticket_type_id: "tt_1",
        // Declined (no answer key present).
        custom_answers: JSON.stringify({}),
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
    ];
  });

  it("emits two columns per consent field: acceptance and historical consent text", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    expect(headers).toContain("Marketing Consent");
    expect(headers).toContain("Marketing Consent (consent text)");
  });

  it('records "accepted" and the historical consent text/version snapshot for accepted attendees', async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const acceptCol = headers.indexOf("Marketing Consent");
    const textCol = headers.indexOf("Marketing Consent (consent text)");

    // Ada - full snapshot.
    expect(rows[1][acceptCol]).toBe("accepted");
    expect(rows[1][textCol]).toBe("I agree to receive marketing emails. (v2)");
  });

  it("falls back to the question definition consent text/version when the answer is a bare boolean", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const acceptCol = headers.indexOf("Marketing Consent");
    const textCol = headers.indexOf("Marketing Consent (consent text)");

    // Grace - bare true, falls back to question.consent_text / consent_version.
    expect(rows[2][acceptCol]).toBe("accepted");
    expect(rows[2][textCol]).toBe("I agree to receive marketing emails. (v2)");
  });

  it("leaves consent columns empty for attendees who did not accept", async () => {
    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const acceptCol = headers.indexOf("Marketing Consent");
    const textCol = headers.indexOf("Marketing Consent (consent text)");

    // Alan - declined.
    expect(rows[3][acceptCol]).toBe("");
    expect(rows[3][textCol]).toBe("");
  });
});

describe("T30 export content validation - scan log CSV", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_scan_logs",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "scan_logs",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.scanLogSelects = [];
    dbState.scanLogOrderBys = [];
    dbState.scanLogs = [
      {
        id: "slog_2",
        check_in_list_id: "cil_1",
        device_id: "scanner_gate_2",
        ticket_id: "tkt_duplicate",
        qr_hash: "hash_duplicate",
        outcome: "duplicate",
        offline: true,
        tenant_id: "tnt_1",
        check_in_list_event_id: "evt_1",
        scanned_at: new Date("2026-06-02T12:00:00Z"),
        created_at: new Date("2026-06-01T12:00:01Z"),
      },
      {
        id: "slog_1",
        check_in_list_id: "cil_1",
        device_id: "scanner_gate_1",
        ticket_id: "tkt_checked_in",
        qr_hash: "hash_checked_in",
        outcome: "accepted",
        offline: false,
        tenant_id: "tnt_1",
        check_in_list_event_id: "evt_1",
        scanned_at: new Date("2026-06-01T12:00:00Z"),
        created_at: new Date("2026-06-03T12:00:01Z"),
      },
      {
        id: "slog_other_tenant",
        check_in_list_id: "cil_other_tenant",
        device_id: "scanner_other_tenant",
        ticket_id: "tkt_other_tenant",
        qr_hash: "hash_other_tenant",
        outcome: "accepted",
        offline: false,
        tenant_id: "tnt_other",
        check_in_list_event_id: "evt_1",
        scanned_at: new Date("2026-06-01T12:30:00Z"),
        created_at: new Date("2026-06-01T12:30:01Z"),
      },
      {
        id: "slog_other_event",
        check_in_list_id: "cil_other_event",
        device_id: "scanner_other_event",
        ticket_id: "tkt_other_event",
        qr_hash: "hash_other_event",
        outcome: "accepted",
        offline: false,
        tenant_id: "tnt_1",
        check_in_list_event_id: "evt_other",
        scanned_at: new Date("2026-06-01T12:45:00Z"),
        created_at: new Date("2026-06-01T12:45:01Z"),
      },
    ];
  });

  it("emits the expected scan-log export headers in order", async () => {
    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    expect(dbState.scanLogSelects).toEqual([
      [
        "scan_logs.id as id",
        "scan_logs.check_in_list_id as check_in_list_id",
        "scan_logs.device_id as device_id",
        "scan_logs.ticket_id as ticket_id",
        "scan_logs.qr_hash as qr_hash",
        "scan_logs.outcome as outcome",
        "scan_logs.scanned_at as scanned_at",
        "scan_logs.offline as offline",
        "scan_logs.created_at as created_at",
      ],
    ]);
    expect(dbState.scanLogOrderBys).toEqual([
      { column: "scan_logs.scanned_at", direction: "asc" },
      { column: "scan_logs.id", direction: "asc" },
    ]);
    const rows = parseCsv(result.value.data);
    expect(rows[0]).toEqual([
      "id",
      "checkInListId",
      "deviceId",
      "ticketId",
      "qrHash",
      "outcome",
      "scannedAt",
      "offline",
      "createdAt",
    ]);
  });

  it("includes accepted and duplicate scan-log values in the correct columns", async () => {
    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    expect(rows).toHaveLength(3);
    const headers = rows[0];
    const deviceIdCol = headers.indexOf("deviceId");
    const ticketIdCol = headers.indexOf("ticketId");
    const qrHashCol = headers.indexOf("qrHash");
    const outcomeCol = headers.indexOf("outcome");
    const offlineCol = headers.indexOf("offline");

    expect(rows[1][deviceIdCol]).toBe("scanner_gate_1");
    expect(rows[1][ticketIdCol]).toBe("tkt_checked_in");
    expect(rows[1][qrHashCol]).toBe("hash_checked_in");
    expect(rows[1][outcomeCol]).toBe("accepted");
    expect(rows[1][offlineCol]).toBe("false");
    expect(rows[2][deviceIdCol]).toBe("scanner_gate_2");
    expect(rows[2][ticketIdCol]).toBe("tkt_duplicate");
    expect(rows[2][qrHashCol]).toBe("hash_duplicate");
    expect(rows[2][outcomeCol]).toBe("duplicate");
    expect(rows[2][offlineCol]).toBe("true");
  });

  it("excludes scan logs from other tenants and events", async () => {
    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    const ids = rows.slice(1).map((row) => row[0]);
    expect(ids).toEqual(["slog_1", "slog_2"]);
    expect(ids).not.toContain("slog_other_tenant");
    expect(ids).not.toContain("slog_other_event");
  });

  it("filters scan-log exports by outcome status", async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: JSON.stringify({ status: "accepted" }),
    };

    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(1);
    const rows = parseCsv(result.value.data);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("slog_1");
  });

  it("does not export unexpected raw QR payload or buyer PII properties in scan-log CSV content", async () => {
    dbState.scanLogs[0] = {
      ...dbState.scanLogs[0],
      qr_payload: "signed-qr-payload-should-not-export",
      buyer_email: "buyer@example.com",
    };

    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).toContain("hash_checked_in");
    expect(result.value.data).not.toContain(
      "signed-qr-payload-should-not-export",
    );
    expect(result.value.data).not.toContain("buyer@example.com");
  });

  it("applies date-only filters to scan-log export rows", async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: JSON.stringify({ from: "2026-06-01", to: "2026-06-01" }),
    };

    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(1);
    const rows = parseCsv(result.value.data);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe("slog_1");
  });

  it("returns an empty CSV body when there are zero scan logs", async () => {
    dbState.scanLogs = [];

    const result = await generateExportActivity({
      exportId: "exp_scan_logs",
      type: "scan_logs",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(0);
    expect(result.value.data).toBe("");
  });
});

describe("T30 export failure recovery", () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.event = {
      id: "evt_1",
      tenant_id: "tnt_1",
      organization_id: "org_1",
      brand_id: "brd_1",
    };
    dbState.orders = [
      {
        id: "ord_1",
        tenant_id: "tnt_1",
        organization_id: "org_1",
        brand_id: "brd_1",
        event_id: "evt_1",
      },
    ];
    dbState.questions = [];
    dbState.attendees = [
      {
        id: "att_1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@test.com",
        phone: null,
        status: "registered",
        tenant_id: "tnt_1",
        event_id: "evt_1",
        order_id: "ord_1",
        ticket_type_id: "tt_1",
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date("2026-06-01"),
      },
    ];
  });

  it("markExportFailedActivity records a terminal failed status with a reason", async () => {
    const result = await markExportFailedActivity({
      exportId: "exp_1",
      reason: "S3 upload timed out",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.failed).toBe(true);
    }
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({ table: "export_jobs", status: "failed" }),
    );
    const failedUpdate = dbState.updateCalls.find(
      (c) => c.table === "export_jobs" && c.status === "failed",
    );
    expect(failedUpdate?.completed_at).toBeInstanceOf(Date);
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      status: "failed",
      export_job_id: "exp_1",
    });
    expect(String(dbState.exportEvents[0].payload)).toContain(
      "S3 upload timed out",
    );
  });

  it("generateExportActivity returns a non-retryable error result for malformed persisted filters", async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: "{not valid json",
    };

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("EXPORT_FAILED");
      expect(result.message).toBe("Invalid export filters");
      expect(result.retryable).toBe(false);
    }
  });

  it("generateExportActivity returns a non-retryable error result for unsupported persisted filters", async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      type: "tax",
      filters: JSON.stringify({ status: "paid" }),
    };

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "tax",
      format: "csv",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("EXPORT_FAILED");
      expect(result.message).toBe("Invalid export filters");
      expect(result.retryable).toBe(false);
    }
    expect(dbState.updateCalls).not.toContainEqual(
      expect.objectContaining({ table: "export_jobs", status: "completed" }),
    );
  });

  it("generateExportActivity returns a non-retryable error result for invalid persisted date filters", async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: JSON.stringify({ from: "2026-02-31" }),
    };

    const result = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("EXPORT_FAILED");
      expect(result.message).toBe("Invalid export filters");
      expect(result.retryable).toBe(false);
    }
    expect(dbState.updateCalls).not.toContainEqual(
      expect.objectContaining({ table: "export_jobs", status: "completed" }),
    );
  });

  it("a failed export can be retried by re-running generateExportActivity after the job is reset to processing", async () => {
    // First attempt: simulate a failure by corrupting filters.
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: "{bad",
    };
    const failedResult = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });
    expect(failedResult.ok).toBe(false);

    // Mark the export as failed in the DB (as the workflow would).
    const markResult = await markExportFailedActivity({
      exportId: "exp_1",
      reason: "Generation failed",
    });
    expect(markResult.ok).toBe(true);

    // Reset the job to processing with valid filters for retry.
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];

    const retryResult = await generateExportActivity({
      exportId: "exp_1",
      type: "attendees",
      format: "csv",
    });

    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) {
      expect(retryResult.value.rowCount).toBe(1);
      expect(retryResult.value.data).toContain("ada@test.com");
    }
    // The retry should record a fresh processing event.
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({ status: "processing" });
  });
});

describe("T30 export download file URL", () => {
  // The HTTP download endpoint (GET /exports/:exportId/download) is covered by
  // packages/api/src/__tests__/integration/orders-reporting-routes.test.ts.
  // These tests validate that uploadFileActivity produces the file URL that the
  // download endpoint redirects to, and that the URL points at the generated
  // export artifact for the correct format.

  it("produces a download URL ending in .csv for CSV exports", async () => {
    const result = await uploadFileActivity({
      exportId: "exp_download",
      data: "id,email\natt_1,ada@test.com",
      format: "csv",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toMatch(/^https:\/\//);
      expect(result.value.fileUrl).toContain("exp_download.csv");
    }
  });

  it("produces a download URL ending in .json for JSON exports", async () => {
    const result = await uploadFileActivity({
      exportId: "exp_json",
      data: '[{"id":"att_1"}]',
      format: "json",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toMatch(/^https:\/\//);
      expect(result.value.fileUrl).toContain("exp_json.json");
    }
  });

  it("the completed export job file_url matches the uploaded artifact URL used by the download endpoint", async () => {
    // Upload the generated file.
    const uploadResult = await uploadFileActivity({
      exportId: "exp_1",
      data: "id,email\natt_1,ada@test.com",
      format: "csv",
    });
    expect(uploadResult.ok).toBe(true);
    if (!uploadResult.ok) return;

    // Notify completion, which persists file_url on the export job.
    dbState.exportJob = {
      id: "exp_1",
      tenant_id: "tnt_1",
      event_id: "evt_1",
      type: "attendees",
      format: "csv",
      status: "processing",
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.user = null;
    dbState.providerRoute = null;
    dbState.templateVersion = null;

    await notifyExportCompleteActivity({
      exportId: "exp_1",
      fileUrl: uploadResult.value.fileUrl,
      requestedBy: "usr_1",
      tenantId: "tnt_1",
    });

    // The persisted file_url is what GET /exports/:exportId/download redirects to.
    const completedUpdate = dbState.updateCalls.find(
      (c) => c.table === "export_jobs" && c.status === "completed",
    );
    expect(completedUpdate?.file_url).toBe(uploadResult.value.fileUrl);
    expect(completedUpdate?.file_url).toContain("exp_1.csv");
  });
});
