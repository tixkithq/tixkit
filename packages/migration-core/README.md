# `@tixkit/migration-core`

## Purpose

Framework-neutral contracts and deterministic safety primitives for migration adapters.

## Consumers

Tixkit API, workers, CLI, admin dashboard, supported importers, and bespoke adapter authors.

## Status

Public beta. Publication is held at the Phase 8 external release gate.

## Installation

```sh
npm install @tixkit/migration-core
```

## Example

```ts
import { buildDryRunReport, canCommitDryRun } from '@tixkit/migration-core';

const report = buildDryRunReport({ rows: normalizedRows });
if (canCommitDryRun(report)) submitReviewedJob(jobId);
```

## Public exports

The package exports adapter, canonical entity, validation, dry-run, rollback, credential-reference, importer registry, preparation configuration, fixture, and conformance contracts from its root entry point.

## Runtime

The package performs no database or network I/O. Adapters own source discovery, extraction, normalization, and source validation; server components own durable tenant state and side effects.

## Configuration

`migrationAdapterCatalog()` exposes the ordered Generic CSV, pretix, Hi.Events, Eventbrite, and Ticket Tailor contracts. Official API configurations are source-discriminated and require explicit scopes. Bespoke integrations use `defineBespokeAdapter` and the offline conformance runner.

## Security

`buildDryRunReport` reports `domainWrites: 0`. Historical financial snapshots suppress provider-success, fulfillment, notification, and webhook side effects. Rollback fails closed when activity evidence is missing or any sale, scan, transfer, edit, provider event, or downstream reference exists. Credentials are represented only by scoped secret-manager references.

## Validation

Run `bun run typecheck`, `bun run lint`, and `bun run test:unit` in this package. The release workflow also builds, packs, checksums, and imports the tarball from a clean external directory.

## Compatibility

Importer supported-version matrices and known losses are versioned in the adapter catalog. Breaking public-contract changes require an API/SDK compatibility review and synchronized release artifacts.

## Related guides

- [Migration operations](../../docs/public/operators/migration-operations.mdx)
- [Bespoke adapters](../../docs/public/operators/migrations/bespoke-adapters.mdx)
