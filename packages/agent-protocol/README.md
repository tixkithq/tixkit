# `@tixkit/agent-protocol`

Framework-neutral public safety contracts for Tixkit agents and external orchestrators.

The package defines explicit agent principals, scoped delegation, typed actions and plans, deterministic action digests, fresh single-use approvals, fail-closed authorization decisions, and audit envelopes. It performs no database, network, model, prompt, or provider I/O.

The versioned JSON Schema uses the required `x-tixkit-maxCanonicalBytes` and `x-tixkit-maxDepth` conformance keywords. JavaScript validators must call `installAgentProtocolSchemaKeywords(ajv)` before compiling it; other implementations must enforce the same annotations. Ignoring those keywords is not protocol-conformant.

Initial autonomy is limited to read, recommend, prepare, and execute with explicit approval. Buyer purchasing, standing monetary authority, unrestricted execution, hidden memory, direct database access, and direct provider access are excluded.

Run `bun run typecheck`, `bun run lint`, and `bun run test:unit` from this package. Publication remains held by the repository's pending legal and public-release gates.
