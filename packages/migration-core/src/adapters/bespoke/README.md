# Bespoke migration adapters

Bespoke adapters connect a vendor-supported API or export to the Tixkit migration domain. They must not scrape web pages or retain resolved credentials. The core owns tenant scoping, durable row storage, dry-run/commit state, idempotency, rollback checks, and audit events.

## Contract

Implement `MigrationAdapter<Configuration, Cursor>` and register it with `defineBespokeAdapter`. The stable adapter ID is also the `sourceSystem`; changing it breaks external-reference idempotency. Declare exact supported source versions, a feature map, known losses, and the source's documented pagination/rate-limit behavior.

`discover` reports coverage without domain writes. `extract` must use official API/export data, honor `AbortSignal`, return a durable opaque cursor, and produce the same page for the same input. Every row needs a stable vendor external ID and source position. `normalize` preserves those identity fields, declares dependencies using Tixkit entity types, and must represent payments/refunds only with `createHistoricalFinancialSnapshot`. `validate` emits actionable issues without buyer PII in messages.

Run `runBespokeAdapterConformance` against sanitized fixtures for every supported version. Also test pagination boundaries, 429/`Retry-After`, interrupted resume, dry-run zero writes, commit, re-import idempotency, and rollback refusal after live activity. Credential material may only be resolved inside a non-replayable activity and must never enter configuration, rows, logs, reports, or workflow history.

## Release evidence

An adapter is release-ready only with a supported-version matrix, feature mapping, known-loss report, sanitized fixture corpus, rate-limit tests, dry-run and commit tests, re-import and rollback tests, and an operator guide. Source API changes require a new fixture and compatibility entry; never silently reinterpret an existing supported version.
