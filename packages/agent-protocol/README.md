# `@tixkit/agent-protocol`

## Purpose

Framework-neutral safety contracts for Tixkit agents and external orchestrators: explicit principals, scoped delegation, typed actions and plans, deterministic digests, fresh single-use approvals, fail-closed authorization, durable execution, audit envelopes, and bounded organizer memory.

## Consumers

The shared Tixkit API and Self-Hosted runtime, third-party Platform API agents, bring-your-own Self-Hosted orchestrators, and managed Cloud orchestration that consumes the same immutable public protocol.

## Status

Experimental organizer-first action protocol at version `2026-07-22`, with additive plan and action-registry contracts at platform protocol version `2026-07-27`. The package is a public-release candidate, but publication and MIT licensing remain subject to the repository's pending legal and protected-release gates.

## Installation

Use `bun add @tixkit/agent-protocol` after an approved public release, or add it as a `workspace:*` dependency inside this repository.

## Example

Use `buildAgentPlanDefinition` for new plans. It hashes immutable assumptions, exact action identities, projected changes, bounded integer-minor-unit costs, readiness impact, fresh per-action approval requirements and honest reversibility. Persist mutable execution progress separately as `AgentPlanState`, and accept state changes only after `validateAgentPlanStateTransition` succeeds with authoritative approval and execution evidence.

## Public exports

The root exports protocol versions and the digest-bound action registry; principal, delegation, action, immutable plan definition, mutable plan state, approval, authorization and audit contracts; canonical hashing and validation helpers; `DurableAgentExecutionService`; execution-store and invoker interfaces; and scoped memory normalization and validation contracts. `./schema` remains the immutable `2026-07-22` Agent Action schema. The additive plan and action-contract schemas use explicit `./schemas/agent-plan/2026-07-27` and `./schemas/agent-action-contracts/2026-07-27` exports.

## Runtime

Side-effect-free TypeScript ES modules for Node.js 22 or newer. The package performs no database, network, model, prompt, or provider I/O; consumers implement the declared stores, authorization state provider, and action invoker through existing APIs and workflows.

## Configuration

No environment variables are read. JavaScript JSON Schema consumers must call `installAgentProtocolSchemaKeywords(ajv)` before compiling the schema; other runtimes must enforce the equivalent canonical-byte and depth keywords.

## Security

Authorization is the intersection of agent capability, sponsor permission, delegation, tenant policy, action risk policy, and resource state. Approval binds an immutable action digest and consequential execution requires fresh approval. Agents must never impersonate hidden users, write directly to databases, bypass APIs/workflows, or obtain buyer-purchasing or unrestricted delegated authority.

## Validation

`bun run --filter @tixkit/agent-protocol typecheck && bun run --filter @tixkit/agent-protocol lint && bun run --filter @tixkit/agent-protocol test:unit && bun run --filter @tixkit/agent-protocol build`

## Compatibility

Managed Cloud releases must pin action protocol version `2026-07-22`, platform protocol version `2026-07-27`, and the registry/schema digests through their Cloud/core compatibility manifest. Changes to canonical bytes, action or plan digests, authorization inputs, approval semantics, registry policy, audit envelopes, schema keywords, or memory scope are protocol changes and require compatibility evidence. The immutable `2026-07-11` and `2026-07-22` action schemas remain exported byte-for-byte; `./schema` intentionally continues to resolve to `2026-07-22`.

HTTP API release `2026-07-28` is a compatible enforcement release for the existing platform protocol: serialized `2026-07-27` plan definitions, states and digests remain byte-for-byte readable. It carries the already-required plan digest through approval, execution and audit evidence and permits an evidence-validated direct terminal transition for synchronous adapters; it does not change canonical plan bytes or the immutable JSON schemas.

## Related guides

[API permissions](../../docs/public/developers/api-fundamentals/permissions.mdx) · [Platform API overview](../../docs/public/platform/index.mdx)
