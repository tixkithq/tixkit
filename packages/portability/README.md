# `@tixkit/portability`

## Purpose

Operating-model-neutral contracts for signed, checksummed, versioned logical bundles that move tenant configuration, content, and owned media between Tixkit Cloud and Self-Hosted deployments without raw database replication.

## Consumers

Cloud export/import services, Compact and Production Self-Hosted runtimes, migration workers, compatibility tooling, and third-party operators implementing the public portability contract.

## Status

Manifest v2 (`2026-07-14`) is the current contract; immutable v1 (`2026-07-12`) remains available for legacy verification. The package is a public-release candidate, but publication and MIT licensing remain subject to pending legal and protected-release gates.

## Installation

Use `bun add @tixkit/portability` after an approved public release, or add it as a `workspace:*` dependency inside this repository.

## Example

`const preflight = verifyAndPreflightPortableImport(envelope, destination, bundleKeys, payloadKeys, payloadPolicies, mediaKeys, mediaPolicies);`

## Public exports

The root exports logical manifest, signature, lineage, historical authorization, media and cutover contracts; canonical JSON and signing helpers; payload/media scanners and attestations; export builders; compatibility preflight; dry-run receipts; resume and provenance validation; reconciliation; safe JSON parsing; and the closed configuration policy. Subpaths expose v1/v2 schemas, signature schema, canonical test vectors, and package metadata.

## Runtime

Side-effect-free TypeScript ES modules for Node.js 22 or newer. Cryptographic helpers use Ed25519 and SHA-256; callers supply storage, transport, malware/media processing, key custody, persistence, and workflow execution.

## Configuration

The library reads no environment variables. Callers provide trusted public-key registries, exact payload and media policy allowlists, destination compatibility, signed historical authorization when applicable, and destination resource rebindings. Keep private signing keys in the deployment's approved secret or managed-key system.

## Security

Bundles never contain plaintext credentials, secret keys, payment tokens, private signing keys, or infrastructure credentials. Importers must verify exact bytes, signatures, checksums, closed schemas, media safety attestations, destination scope, lineage, cutover freshness, replay identity, resume provenance, required rebindings, and reconciliation before activation.

## Validation

`bun run --filter @tixkit/portability typecheck && bun run --filter @tixkit/portability lint && bun run --filter @tixkit/portability test:unit && bun run --filter @tixkit/portability build`

## Compatibility

The default `./schema` and explicit `./schema-v1` retain v1 compatibility; new exporters use `./schema-v2` and require `portable-bundle-v2` plus `portable-rebinding-kinds-v2`. Canonical byte rules, signature inputs, schema version, section policy, capability names, and provenance digests are immutable compatibility boundaries.

## Related guides

[Migration operations](../../docs/public/operators/migration-operations.mdx) · [API migration to 2026-07-14](../../docs/public/reference/migrations/2026-07-13-to-2026-07-14.mdx)
