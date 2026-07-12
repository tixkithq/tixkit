# Contributing to Tixkit

> Repository transition: the accepted target makes the public `tixkit/tixkit` repository authoritative for the shared product and complete Self-Hosted runtime. The current private-first tree and OSS exporter are transitional. Public contributions and shared fixes must never depend on the private `tixkit-cloud` repository or introduce proprietary Cloud assumptions into shared contracts.

Thank you for improving Tixkit. Contributions must preserve tenant isolation, contract parity, accessible user flows, and the public/private export boundary.

## Before you start

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and the [contributor documentation](docs/public/contributing/architecture.mdx).
2. Search existing issues before opening a new one. Security vulnerabilities follow [SECURITY.md](SECURITY.md), not a public issue.
3. Keep a change focused. Do not mix generated output, broad formatting, or unrelated cleanup into a feature fix.
4. Do not commit credentials, private payloads, customer data, or generated local runtime state.

## Local setup

```bash
bun install --frozen-lockfile
cp .env.local.example .env.local
bun run setup:check -- --mode local
bun run quickstart -- --no-open
```

The complete flow and port requirements are in the [local quickstart](docs/public/getting-started/local-quickstart.mdx).

## Change contracts together

A change is incomplete when it alters a public API, SDK export, CLI command, environment variable, dashboard workflow, permission, deployment contract, provider behavior, or operational procedure without updating the corresponding types, tests, generated contract, examples, and documentation.

- API changes: update runtime routes, OpenAPI, SDKs, dashboard clients, fixtures, reference output, and drift tests.
- Documentation routes: use typed route IDs from `packages/docs-core`; validate dashboard and repository links.
- Durable work: keep nondeterministic I/O in Temporal activities and add replay/integration coverage.
- Database changes: add forward migrations, repository tests, and tenant-isolation coverage.
- SDK changes: update the package README, canonical guide, runnable demo, and parity matrix.

## Validation

Run focused checks while working. Before submitting, run the applicable full gates:

```bash
bun run format:check
bun run typecheck
bun run lint
bun run docs:check
bun run docs:build
bun run test:scripts
bun run test:unit
bun run test:integration
bun run test:e2e
bun run export:oss
git diff --check
```

Do not weaken or skip a test to produce a green result. A skipped provider, browser, database, or deployment suite is not evidence that the suite passed. Document infrastructure-dependent validation honestly in the pull request.

## Documentation and accessibility

Public pages require validated frontmatter and belong under `docs/public`; implementation plans, audits, and evidence belong under `docs/internal`. Keep headings linkable, code samples executable or mechanically validated, and UI flows keyboard and screen-reader operable. Run relevant browser and axe checks for user-facing changes.

## Pull requests

Use the pull-request template. Explain the user-visible outcome, contract/security impact, validation actually run, generated artifacts, and documentation changes. Keep secrets and private logs out of screenshots and pasted output. Maintainers may request a smaller slice when a change cannot be reviewed safely.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
