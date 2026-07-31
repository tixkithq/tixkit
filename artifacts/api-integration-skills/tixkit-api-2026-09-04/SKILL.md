---
name: tixkit-api-2026-09-04
description: Implement and review Tixkit Platform API integrations against immutable API 2026-09-04. Use for authentication, scoped principals, endpoint selection, idempotent mutations, cursor pagination, webhook handling, retries, and agent-safe action or approval flows that must remain contract-version accurate.
---

# Tixkit API 2026-09-04

Use only the bundled, checksummed 2026-09-04 references for endpoint and contract decisions.

## Workflow

1. Read `references/contract.json` and reject a server, SDK, example, or requested contract with a different API version.
2. Search `references/operations.json` by method, path, or operation ID. Respect its permission and idempotency metadata.
3. Keep credentials in server-side environment or secret storage. Never paste secrets into source, URLs, browser storage, logs, traces, examples, or agent memory.
4. Use the least-authority principal and scopes. An agent principal never receives or impersonates its human sponsor's token.
5. Reuse one `Idempotency-Key` for retries of one logical mutation. Generate a new key when the intent or payload changes.
6. Follow cursor fields returned by the API. Do not invent offsets or infer another tenant's resource existence from denial responses.
7. Verify webhook signatures over the exact raw body before parsing. Treat delivery as at-least-once and ordering as not guaranteed.
8. Retry only failures declared retryable by the contract or a bounded `Retry-After`; never retry an ambiguous side effect with a new idempotency key.
9. For agent actions, bind approval to the immutable action digest and current resource version. Material changes require fresh approval.
10. Prefer a supported public Tixkit SDK when it covers the operation. This skill does not replace SDK or contract-test evidence.

## References

- `references/contract.json`: source release identity, checksums, auth schemes, and generation mode.
- `references/operations.json`: bounded endpoint metadata generated from OpenAPI.
- `references/openapi.json`: exact checksummed request, response, parameter, server, and error schemas; load only the operation and referenced schemas needed for the task.
- `references/examples.json`: sanitized release examples.
- `references/webhook-events.json`: versioned webhook catalog.

> Local evaluation artifact: this generator does not verify publication provenance. Do not represent this skill as a published, hosted, or production-certified contract.
