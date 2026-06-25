## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Make graphify queries repo-specific. Prefer package/app anchors and exact symbols over broad nouns:
  - Good: `graphify query "checkout.ts createCheckoutSessionSchema checkoutRoutes CheckoutRepository createCheckoutSession"`
  - Good: `graphify query "apps/admin-dashboard events EventDetailPage event tickets attendees"`
  - Good: `graphify query "packages/workflows checkout createHoldActivity expireStaleHoldsActivity payment reconciliation"`
  - Weak: `graphify query "checkout flow"` or `graphify query "orders"` because this repo has many duplicate labels such as `index.ts`, `page.tsx`, `Order`, `routes`, and `signature()`.
- If the first query starts from a generic or wrong node, immediately rerun a narrower query with one or more of:
  - package/app path prefixes: `packages/api`, `packages/domain`, `packages/db`, `packages/workflows`, `apps/admin-dashboard`, `apps/checkout`
  - concrete file names: `checkout.ts`, `event-detail-view.tsx`, `scan-view.tsx`, `api.ts`
  - exported symbols from the graph output: route builders, repositories, activities, workflows, domain types, React components
- For implementation traces, run both directions when useful: a broad `graphify query` for the local cluster, then `graphify path "<UI/component/symbol>" "<API/domain/repository symbol>"` for cross-layer relationships. If `graphify path` reports ambiguity or no path, fall back to targeted `graphify query` calls on each endpoint and compare the source files manually.
- Prefer `--dfs` for “trace how X reaches Y” questions and default BFS for “what is connected to X?” questions. Increase `--budget` to 3000-5000 only after the query has been narrowed.
- Treat Graphify output as a scoped map, not a complete answer. Use it to choose the files and symbols to inspect next with `rg`, `sed`, or tests, especially for runtime flows where HTTP URLs, query keys, or database table names may not appear as graph edges.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
