## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- Use `docs/graphify-usage.md` as the repo-specific playbook for query construction, recovery, examples, and limitations.
- For codebase questions, first run `graphify query "<anchored query>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for known endpoint relationships and `graphify explain "<concept>"` for focused symbols. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Make every Graphify query repo-specific. Include at least three concrete anchors from this stack: package/app path, exact file path, exported symbol, runtime surface, and test file.
  - Good: `graphify query "packages/api/src/routes/modules/checkout.ts checkoutRoutes createCheckoutSessionSchema packages/db/src/repositories/checkout.ts CheckoutRepository packages/workflows/src/workflows/checkout.ts checkoutSessionWorkflow" --budget 5000`
  - Good: `graphify query "apps/admin-dashboard/src/features/events/event-detail-view.tsx EventDetailView apps/admin-dashboard/src/lib/api.ts packages/api/src/routes/modules/events.ts eventRoutes ticket types attendees products" --budget 4000`
  - Good: `graphify query "packages/api/src/observability.ts createApiObservability registerMetricsRoute packages/shared/src/observability.ts createTixkitMetrics packages/workflows/src/observability.ts TixkitActivityMetricsInterceptor" --budget 5000`
  - Weak: `graphify query "checkout flow"`, `graphify query "orders"`, or `graphify query "observability workflows metrics"` because this repo has many docs and duplicate labels such as `index.ts`, `page.tsx`, `Order`, `routes`, `config`, `types`, and `Page()`.
- If the first query starts from generic docs or wrong nodes, immediately rerun a narrower query. Use `rg` only to discover exact anchors, then rerun Graphify with:
  - package/app path prefixes: `packages/api`, `packages/domain`, `packages/db`, `packages/workflows`, `packages/shared`, `apps/admin-dashboard`, `apps/checkout`
  - concrete file paths: `packages/api/src/routes/modules/checkout.ts`, `apps/admin-dashboard/src/features/events/event-detail-view.tsx`, `apps/admin-dashboard/src/features/check-in/scan-view.tsx`
  - exported symbols from source or graph output: route builders, repositories, activities, workflows, domain types, React components, schemas
  - runtime surfaces: HTTP routes, query keys, database table names, Temporal workflow/activity names, provider operation names
- For implementation traces, run both directions when useful: an anchored `graphify query` for the local cluster, then `graphify path "<UI/component/symbol>" "<API/domain/repository symbol>"` for cross-layer relationships. If `graphify path` reports ambiguity or no path, fall back to targeted `graphify query` calls on each endpoint and compare the source files manually.
- Prefer `--dfs` for “trace how X reaches Y” questions and default BFS for “what is connected to X?” questions. Increase `--budget` to 3000-5000 only after the query has been narrowed.
- Treat Graphify output as a scoped map, not a complete answer. Use it to choose the files and symbols to inspect next with `rg`, `sed`, or tests, especially for runtime flows where HTTP URLs, query keys, or database table names may not appear as graph edges.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## serena

This project has Serena configuration and memories under `.serena/`.

Rules:
- Activate Serena as `tixkit` or `/Users/itsnk/Desktop/Coding/tixkit`.
- Read `mem:core` for durable project orientation, then follow its links to topic memories only when relevant.
- Use Graphify first for cross-file/cross-package navigation, then Serena for precise symbol-level inspection.
- Before reading a source file end-to-end, prefer Serena `get_symbols_overview` for that file.
- Use Serena `find_symbol` with `relative_path` when the needed symbol is known.
- Use `rg` for runtime strings that symbolic tools do not model well: HTTP paths, query keys, env vars, table names, provider IDs, test titles.
- Do not add Serena memories for one-off task notes. Add or update memories only for stable, non-obvious project conventions.
