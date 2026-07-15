# `@tixkit/agent-protocol`

## Purpose

Framework-neutral safety contracts for Tixkit agents and external orchestrators: explicit principals, scoped delegation, typed actions and plans, deterministic digests, fresh single-use approvals, fail-closed authorization, durable execution, audit envelopes, and bounded organizer memory.

## Consumers

The shared Tixkit API and Self-Hosted runtime, third-party Platform API agents, bring-your-own Self-Hosted orchestrators, and managed Cloud orchestration that consumes the same immutable public protocol.

## Status

Experimental organizer-first action protocol at version `2026-07-22`, with immutable plans at platform protocol version `2026-07-27` and additive action-registry contracts at version `2026-07-31`. The package is a public-release candidate, but publication and MIT licensing remain subject to the repository's pending legal and protected-release gates.

## Installation

Use `bun add @tixkit/agent-protocol` after an approved public release, or add it as a `workspace:*` dependency inside this repository.

## Example

Use `buildAgentPlanDefinition` for new plans. It hashes immutable assumptions, exact action identities, projected changes, bounded integer-minor-unit costs, readiness impact, fresh per-action approval requirements and honest reversibility. Persist mutable execution progress separately as `AgentPlanState`, and accept state changes only after `validateAgentPlanStateTransition` succeeds with authoritative approval and execution evidence.

## Public exports

The root exports protocol versions and the digest-bound action registry; principal, delegation, action, immutable plan definition, mutable plan state, approval, authorization and audit contracts; canonical hashing and validation helpers; `DurableAgentExecutionService`; execution-store and invoker interfaces; and scoped memory normalization and validation contracts. `./schema` resolves to the current `2026-07-31` full-action validation overlay, which retains the `2026-07-22` wire protocol and enforces exact autonomy by action kind. Retained action schemas use explicit `./schemas/2026-07-11`, `./schemas/2026-07-22` and `./schemas/2026-07-31` exports; immutable platform schemas use explicit `./schemas/agent-plan/2026-07-27`, `./schemas/agent-action-contracts/2026-07-27`, `./schemas/agent-action-contracts/2026-07-29`, `./schemas/agent-action-contracts/2026-07-30` and `./schemas/agent-action-contracts/2026-07-31` exports. The registry marks `event.publish` as plan-supported and `event.read`, `readiness.read` and `event.prepare` as direct-only; reserved actions remain unavailable.

## Runtime

Side-effect-free TypeScript ES modules for Node.js 22 or newer. The package performs no database, network, model, prompt, or provider I/O; consumers implement the declared stores, authorization state provider, and action invoker through existing APIs and workflows.

## Configuration

No environment variables are read. The current action schema is an overlay on the retained wire schema, so JavaScript JSON Schema consumers must register the retained schema before compiling the current export:

```js
import { installAgentProtocolSchemaKeywords } from '@tixkit/agent-protocol';
import currentSchema from '@tixkit/agent-protocol/schema' with { type: 'json' };
import retainedSchema from '@tixkit/agent-protocol/schemas/2026-07-22' with { type: 'json' };
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
installAgentProtocolSchemaKeywords(ajv);
ajv.addSchema(retainedSchema);
const validateAction = ajv.compile(currentSchema);
```

To validate action-specific payload and result semantics, also register `./schemas/agent-action-contracts/2026-07-27` before `./schemas/agent-action-contracts/2026-07-31`, then resolve the registry-selected `prepareInputSchema`, `resolvedPayloadSchema`, or `resultSchema` JSON Pointer. The current action overlay enforces kind/autonomy/target structure; the action-contract registry enforces the typed event preparation payload and mutation-ready media boundary. Other runtimes must enforce equivalent canonical-byte and depth keywords and the same two-stage validation.

## Security

Authorization is the intersection of agent capability, sponsor permission, delegation, tenant policy, action risk policy, and resource state. Approval binds an immutable action digest and consequential execution requires fresh approval. Agents must never impersonate hidden users, write directly to databases, bypass APIs/workflows, or obtain buyer-purchasing or unrestricted delegated authority.

## Validation

`bun run --filter @tixkit/agent-protocol typecheck && bun run --filter @tixkit/agent-protocol lint && bun run --filter @tixkit/agent-protocol test:unit && bun run --filter @tixkit/agent-protocol build`

## Compatibility

Managed Cloud releases must pin action protocol version `2026-07-22`, current action validation schema version `2026-07-31`, platform plan protocol version `2026-07-27`, action-registry contract version `2026-07-31`, and the registry/schema digests through their Cloud/core compatibility manifest. Changes to canonical bytes, action or plan digests, authorization inputs, approval semantics, registry policy, audit envelopes, schema keywords, or memory scope are protocol changes and require compatibility evidence. The immutable `2026-07-11` and `2026-07-22` action schemas remain exported byte-for-byte at their versioned paths; `./schema` advances to the `2026-07-31` overlay so default consumers enforce the runtime's fail-closed autonomy contract.

HTTP API release `2026-07-29` retains byte-for-byte readability for serialized `2026-07-27` plan definitions, states and digests. It adds the direct-only `readiness.read` adapter and immutable action-registry schema without changing action protocol bytes or allowing direct reads into a plan. Readiness results are canonical, digest-bound and durable, but do not create approval or execution records.

HTTP API release `2026-07-30` retains the `2026-07-29` action and readiness response schemas byte-for-byte and adds the direct-only `event.read` adapter. Its strict version-bound projection identifies organizer-authored title and description as untrusted tool output, binds the projection to the action digest, and never creates approval, execution or plan authority.

HTTP API release `2026-07-31` retains every `2026-07-30` schema byte-for-byte and adds direct-only `event.prepare`. It binds the complete normalized non-status event PATCH preview to the exact event version and digest, identifies every projected `before` and `after` field as untrusted tool output, and performs no event or media mutation.

## Related guides

[API permissions](../../docs/public/developers/api-fundamentals/permissions.mdx) · [Platform API overview](../../docs/public/platform/index.mdx)
