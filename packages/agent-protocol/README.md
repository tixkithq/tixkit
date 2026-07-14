# `@tixkit/agent-protocol`

## Purpose

Framework-neutral safety contracts for Tixkit agents and external orchestrators: explicit principals, scoped delegation, typed actions and plans, deterministic digests, fresh single-use approvals, fail-closed authorization, durable execution, audit envelopes, and bounded organizer memory.

## Consumers

The shared Tixkit API and Self-Hosted runtime, third-party Platform API agents, bring-your-own Self-Hosted orchestrators, and managed Cloud orchestration that consumes the same immutable public protocol.

## Status

Experimental organizer-first protocol at version `2026-07-25`. The package is a public-release candidate, but publication and MIT licensing remain subject to the repository's pending legal and protected-release gates.

## Installation

Use `bun add @tixkit/agent-protocol` after an approved public release, or add it as a `workspace:*` dependency inside this repository.

## Example

`import { AGENT_PROTOCOL_VERSION, buildAgentPlan } from '@tixkit/agent-protocol'; const plan = buildAgentPlan({ id, protocolVersion: AGENT_PROTOCOL_VERSION, agentPrincipalId, tenantId, purpose: 'Prepare an event launch', actionDigests, createdAt, expiresAt });`

## Public exports

The root exports protocol version and action descriptors; principal, delegation, action, plan, approval, authorization and audit contracts; canonical hashing and validation helpers; `DurableAgentExecutionService`; execution-store and invoker interfaces; and scoped memory normalization and validation contracts. `./schema` exports the versioned JSON Schema.

## Runtime

Side-effect-free TypeScript ES modules for Node.js 22 or newer. The package performs no database, network, model, prompt, or provider I/O; consumers implement the declared stores, authorization state provider, and action invoker through existing APIs and workflows.

## Configuration

No environment variables are read. JavaScript JSON Schema consumers must call `installAgentProtocolSchemaKeywords(ajv)` before compiling the schema; other runtimes must enforce the equivalent canonical-byte and depth keywords.

## Security

Authorization is the intersection of agent capability, sponsor permission, delegation, tenant policy, action risk policy, and resource state. Approval binds an immutable action digest and consequential execution requires fresh approval. Agents must never impersonate hidden users, write directly to databases, bypass APIs/workflows, or obtain buyer-purchasing or unrestricted delegated authority.

## Validation

`bun run --filter @tixkit/agent-protocol typecheck && bun run --filter @tixkit/agent-protocol lint && bun run --filter @tixkit/agent-protocol test:unit && bun run --filter @tixkit/agent-protocol build`

## Compatibility

Managed Cloud releases must pin protocol version `2026-07-25` through their Cloud/core compatibility manifest. Changes to canonical bytes, action digests, execution idempotency, authorization inputs, approval semantics, audit envelopes, schema keywords, or memory scope are protocol changes and require compatibility evidence. The immutable `2026-07-11` and `2026-07-22` schemas remain exported for compatibility; `2026-07-22` added the readiness digest required by `event.publish` actions, and `2026-07-25` scopes durable execution idempotency to the explicit agent principal.

## Related guides

[API permissions](../../docs/public/developers/api-fundamentals/permissions.mdx) · [Platform API overview](../../docs/public/platform/index.mdx)
