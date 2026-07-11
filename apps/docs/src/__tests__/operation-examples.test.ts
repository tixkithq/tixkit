import { describe, expect, it } from "vitest";
import { buildOperationExamples } from "../components/operation-example-builder";

describe("buildOperationExamples", () => {
  it("uses the declared operation parameters, request body, and idempotency header", () => {
    const examples = buildOperationExamples({
      method: "POST",
      path: "/events/{eventId}/orders",
      operationId: "createOrder",
      version: "2026-01-01",
      parameters: [
        { in: "path", name: "eventId", required: true },
        { in: "query", name: "expand" },
        { in: "header", name: "Idempotency-Key", required: true },
        { in: "header", name: "X-Request-Mode" },
      ],
      requestBody: { required: true },
      security: [{ BearerAuth: [] }],
    });

    expect(examples.curl).toMatchInlineSnapshot(`
      "curl --request POST \"$TIXKIT_API_URL/v1/events/$EVENT_ID/orders\" \\
        --url-query \"expand=$EXPAND\" \\
        --header \"Authorization: Bearer $TIXKIT_ACCESS_TOKEN\" \\
        --header \"X-Tixkit-Version: 2026-01-01\" \\
        --header \"X-Request-Mode: $X_REQUEST_MODE\" \\
        --header \"Idempotency-Key: $IDEMPOTENCY_KEY\" \\
        --header \"Content-Type: application/json\" \\
        --data @request.json"
    `);
    expect(examples.typescript).toContain(
      "client.request('POST', path, { headers: { \"X-Request-Mode\": String(xRequestMode) }, idempotencyKey: idempotencyKey, body: requestBody })",
    );
    expect(examples.typescript).toContain(
      'const query = new URLSearchParams({ "expand": String(expand) });',
    );
  });

  it("does not invent a body or idempotency key for a bodyless operation", () => {
    const examples = buildOperationExamples({
      method: "DELETE",
      path: "/webhook-endpoints/{endpointId}",
      operationId: "deleteWebhookEndpoint",
      version: "2026-01-01",
      parameters: [{ in: "path", name: "endpointId", required: true }],
      requestBody: null,
      security: [{ BearerAuth: [] }],
    });

    expect(examples.curl).not.toContain("Idempotency-Key");
    expect(examples.curl).not.toContain("--data");
    expect(examples.typescript).toContain("client.request('DELETE', path);");
  });

  it("distinguishes API keys from bearer access tokens", () => {
    const examples = buildOperationExamples({
      method: "GET",
      path: "/events",
      operationId: "listEvents",
      version: "2026-01-01",
      parameters: [],
      requestBody: null,
      security: [{ ApiKey: ["events.read"] }],
    });

    expect(examples.curl).toContain("Bearer $TIXKIT_API_KEY");
    expect(examples.curl).not.toContain("TIXKIT_ACCESS_TOKEN");
  });

  it.each([
    ["StripeSignature", ["Stripe-Signature"]],
    ["SvixSignature", ["svix-id", "svix-timestamp", "svix-signature"]],
    ["TelnyxSignature", ["telnyx-timestamp", "telnyx-signature-ed25519"]],
    ["EmailProviderSignature", ["x-tixkit-provider-signature"]],
  ])(
    "renders %s callbacks with every runtime-required header",
    (scheme, requiredHeaders) => {
      const examples = buildOperationExamples({
        method: "POST",
        path: "/webhooks/provider",
        operationId: "receiveProviderWebhook",
        version: "2026-01-01",
        parameters: [],
        requestBody: { required: true },
        security: [{ [scheme]: [] }],
      });

      expect(examples.curl).toContain("Receiver example only");
      for (const header of requiredHeaders) {
        expect(examples.curl).toContain(`--header \"${header}: $`);
      }
      expect(examples.typescript).toContain(
        "providerCallbackReceiver.verify(request)",
      );
      expect(examples.typescript).not.toContain("client.request");
    },
  );

  it("URL-encodes reserved query values with curl --url-query", () => {
    const examples = buildOperationExamples({
      method: "GET",
      path: "/events",
      operationId: "searchEvents",
      version: "2026-01-01",
      parameters: [{ in: "query", name: "search", required: false }],
      requestBody: null,
      security: [],
    });

    expect(examples.curl).toContain('--url-query "search=$SEARCH"');
    expect(examples.javascript).toContain("new URLSearchParams");
  });

  it("does not invent authentication for an anonymous operation", () => {
    const examples = buildOperationExamples({
      method: "GET",
      path: "/public/events/{eventId}",
      operationId: "getPublicEvent",
      version: "2026-01-01",
      parameters: [{ in: "path", name: "eventId", required: true }],
      requestBody: null,
      security: [],
    });

    expect(examples.curl).not.toContain("Authorization");
    expect(examples.typescript).toContain(
      "anonymousClient.request('GET', path)",
    );
  });
});
