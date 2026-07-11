# `@tixkit/migration-core`

Public, framework-neutral contracts and deterministic safety primitives for migration adapters. Adapters own source discovery, extraction, normalization, and source-specific validation. Tixkit owns tenant-scoped durable state, mapping, dry-run analysis, commit orchestration, audit, cancellation, and rollback.

The package deliberately performs no database or network I/O. `buildDryRunReport` always identifies itself as `mode: "dry-run"` and `domainWrites: 0`; callers must keep dry-run execution on a read-only application path. Financial imports use `createHistoricalFinancialSnapshot` and remain historical snapshots with `sideEffects: "suppressed"`. They must never emit provider-success events or trigger fulfillment, notification, or webhook side effects.

Rollback is fail closed: every live-activity counter must be supplied and zero. Missing activity evidence, activation, sales, scans, transfers, edits, provider events, or downstream references returns a corrective-plan result instead of destructive deletion.

```ts
import { buildDryRunReport, canCommitDryRun } from '@tixkit/migration-core';

const report = buildDryRunReport({ rows: normalizedRows });
if (canCommitDryRun(report)) {
  // Submit the durable job ID to the server-side commit workflow.
}
```
