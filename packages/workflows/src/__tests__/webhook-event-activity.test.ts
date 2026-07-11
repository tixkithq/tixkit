import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  destroy: vi.fn(),
  endpoints: [
    {
      id: "wh_1",
      tenant_id: "tnt_1",
      organization_id: "org_1",
      url: "https://example.test/webhook",
      secret: "secret_1",
      events: JSON.stringify(["order.paid"]),
      status: "active",
    },
  ],
  events: [] as Array<{
    id: string;
    tenant_id: string;
    organization_id: string;
    type: string;
    payload: string;
    idempotency_key?: string;
    status: string;
    created_at: Date;
  }>,
}));

vi.mock("@tixkit/db", () => {
  class WebhookEndpointRepository {
    async findActiveByEvent(orgId: string, eventType: string) {
      return dbState.endpoints.filter((endpoint) => {
        const events = JSON.parse(endpoint.events) as string[];
        return (
          endpoint.organization_id === orgId &&
          endpoint.status === "active" &&
          events.includes(eventType)
        );
      });
    }
  }

  class WebhookEventRepository {
    async create(input: {
      tenantId: string;
      organizationId: string;
      type: string;
      payload: Record<string, unknown>;
      idempotencyKey?: string;
    }) {
      if (input.idempotencyKey) {
        const existing = dbState.events.find(
          (event) =>
            event.tenant_id === input.tenantId &&
            event.organization_id === input.organizationId &&
            event.type === input.type &&
            event.idempotency_key === input.idempotencyKey,
        );
        if (existing) return existing;
      }
      const event = {
        id: `whe_${dbState.events.length + 1}`,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        type: input.type,
        payload: JSON.stringify(input.payload),
        idempotency_key: input.idempotencyKey,
        status: "pending",
        created_at: new Date("2026-06-01T00:00:00Z"),
      };
      dbState.events.push(event);
      return event;
    }
  }

  return {
    createDb: () => ({ destroy: dbState.destroy }),
    WebhookEndpointRepository,
    WebhookEventRepository,
  };
});

const { emitWebhookEventActivity } =
  await import("../activities/webhook-event.js");

describe("emitWebhookEventActivity", () => {
  beforeEach(() => {
    dbState.destroy.mockClear();
    dbState.events = [];
  });

  it("returns delivery metadata without endpoint signing secrets", async () => {
    const result = await emitWebhookEventActivity({
      tenantId: "tnt_1",
      organizationId: "org_1",
      eventType: "order.paid",
      payload: {
        orderId: "ord_1",
        eventId: "evt_1",
        checkoutSessionId: "cs_1",
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        eventId: "whe_1",
        deliveries: [
          {
            endpointId: "wh_1",
            eventId: "whe_1",
            url: "https://example.test/webhook",
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns the same durable webhook event for a repeated idempotency key", async () => {
    const input = {
      tenantId: "tnt_1",
      organizationId: "org_1",
      eventType: "order.paid",
      payload: {
        orderId: "ord_1",
        eventId: "evt_1",
        checkoutSessionId: "cs_1",
      },
      idempotencyKey: "payment-reconciliation:stripe:evt_1:order.paid",
    };

    const first = await emitWebhookEventActivity(input);
    const second = await emitWebhookEventActivity(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: {
        eventId: "whe_1",
        deliveries: [{ endpointId: "wh_1", eventId: "whe_1" }],
      },
    });
    expect(dbState.events).toHaveLength(1);
  });

  it("fails closed before persistence when emitted data drifts from the public schema", async () => {
    const result = await emitWebhookEventActivity({
      tenantId: "tnt_1",
      organizationId: "org_1",
      eventType: "order.paid",
      payload: { orderId: "ord_1" },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "WEBHOOK_EVENT_INVALID",
      retryable: false,
    });
    expect(dbState.events).toHaveLength(0);
  });
});
