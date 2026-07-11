import { describe, expect, it } from "vitest";
import {
  normalizeOperations,
  resolveContractVersion,
} from "../components/openapi-reference-model";

describe("versioned OpenAPI reference", () => {
  it("restores a supported contract version from query state", () => {
    expect(
      resolveContractVersion(
        "?locale=ar&api-version=2027-01-01",
        ["2026-01-01", "2027-01-01"],
        "2026-01-01",
      ),
    ).toBe("2027-01-01");
  });

  it.each(["?api-version=unknown", "?api-version=", "?locale=ar"])(
    "falls back to the current contract for unsupported query state: %s",
    (search) => {
      expect(
        resolveContractVersion(
          search,
          ["2026-01-01", "2027-01-01"],
          "2026-01-01",
        ),
      ).toBe("2026-01-01");
    },
  );

  it("builds reference operations from the selected version document", () => {
    expect(
      normalizeOperations(
        {
          info: { version: "2027-01-01" },
          security: [{ ApiKey: [] }],
          paths: {
            "/events/{eventId}": {
              parameters: [{ in: "path", name: "eventId", required: true }],
              get: {
                operationId: "getEventV2",
                tags: ["Events"],
                summary: "Get an event from v2",
                parameters: [{ in: "query", name: "locale" }],
                responses: { 200: { description: "OK" } },
                "x-required-permissions": ["events.read"],
              },
            },
          },
        },
        "2027-01-01",
      ),
    ).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/events/{eventId}",
        operationId: "getEventV2",
        summary: "Get an event from v2",
        security: [{ ApiKey: [] }],
        requiredPermissions: ["events.read"],
        parameters: [
          { in: "path", name: "eventId", required: true },
          { in: "query", name: "locale" },
        ],
      }),
    ]);
  });

  it("fails closed when the downloaded artifact does not match the selected version", () => {
    expect(() =>
      normalizeOperations(
        { info: { version: "2026-01-01" }, paths: { "/health": {} } },
        "2027-01-01",
      ),
    ).toThrow("not 2027-01-01");
  });

  it("rejects malformed operations instead of rendering a partial reference", () => {
    expect(() =>
      normalizeOperations(
        {
          info: { version: "2027-01-01" },
          paths: { "/events": { get: { responses: {} } } },
        },
        "2027-01-01",
      ),
    ).toThrow("requires an operationId");
  });
});
