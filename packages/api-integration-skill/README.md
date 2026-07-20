# `@tixkit/api-integration-skill`

## Purpose

Generates an optional coding-agent skill from a checksummed, immutable Tixkit API release. The generated artifact is additive to the public SDKs, OpenAPI release, contract tests, and human documentation; it is not an authorization mechanism or application runtime.

## Consumers

Integration developers and coding agents evaluating a pinned Tixkit API release in a local or CI workspace.

## Status

Experimental local-evaluation tooling. No public registry publication or hosted Cloud availability is claimed.

## Installation

Install the packed package from an authoritative Tixkit release workspace. Public registry installation remains unavailable until the protected publication gate is complete.

## Example

```bash
tixkit-api-skill \
  --release-root ./artifacts/api \
  --api-version 2026-08-24 \
  --output ./generated-skills
```

## Public exports

The root export provides the typed skill generator and its result types. The `tixkit-api-skill` binary exposes the same generator for local automation.

## Runtime

The generator reads an immutable API release directory, validates its release manifest and checksums, and writes a self-contained skill with pinned OpenAPI and example references.

## Configuration

Supply the release root, exact API version, output directory, and expected release-manifest SHA-256. Unpublished release evidence additionally requires the explicit local-evaluation flag.

## Security

Generated output is documentation and contract evidence, never a credential or authorization grant. Existing output is replaced only when its generator marker, source digest, inventory, paths and checksums prove ownership and integrity. Credentials, secrets and private Cloud source must not be included.

Unpublished local release evidence requires the explicit `--allow-local-evaluation` flag. Do not use that flag to claim a published or hosted integration.

## Validation

Run package typecheck, lint, unit tests, the hostile distribution/staging suite, public-distribution validation, and the clean packed external-consumer test.

## Compatibility

Each generated skill is bound to one immutable API version and exact release-manifest digest. It must fail rather than silently rebind to another API release.

## Related guides

- [Platform API agent integration](../../docs/public/platform/agent-platform.mdx)
- [API release train](../../docs/public/reference/api-release-train.mdx)
- [JavaScript SDK](../../docs/public/sdks/javascript.mdx)
