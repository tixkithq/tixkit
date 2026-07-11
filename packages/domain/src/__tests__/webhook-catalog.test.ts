import { describe, expect, it } from "vitest";
import {
  WEBHOOK_CANONICAL_DATA_FIXTURES,
  WEBHOOK_DATA_SCHEMAS,
  WEBHOOK_EVENT_CATALOG,
  WEBHOOK_EVENT_TYPES,
  validateWebhookEventData,
} from "../developer/index.js";

const fixtures = WEBHOOK_CANONICAL_DATA_FIXTURES;

describe("webhook event catalog", () => {
  it("has exact runtime parity and accepts every canonical emitted payload fixture", () => {
    expect(WEBHOOK_EVENT_CATALOG.map(({ type }) => type)).toEqual(
      WEBHOOK_EVENT_TYPES,
    );
    for (const type of WEBHOOK_EVENT_TYPES) {
      const schema = WEBHOOK_DATA_SCHEMAS[type];
      const fixture = fixtures[type];
      expect(
        schema.required.every((field) => field in fixture),
        type,
      ).toBe(true);
      expect(
        Object.keys(fixture).every((field) => field in schema.properties),
        type,
      ).toBe(true);
    }
  });

  it("validates every canonical fixture through the production emission validator", () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(validateWebhookEventData(type, fixtures[type])).toEqual({
        success: true,
      });
    }
  });

  it("models ticket issuance as an order plus ticket ID collection", () => {
    expect(WEBHOOK_DATA_SCHEMAS["ticket.issued"]).toMatchObject({
      required: ["orderId", "ticketIds"],
      properties: { ticketIds: { type: "array", items: { type: "string" } } },
    });
  });
});
