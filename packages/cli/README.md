# `tixkit` CLI

Developer-experience commands for scaffolding integrations, validating configuration, running the source checkout, generating embeds, forwarding local provider webhooks, and seeding test data.

## Purpose

The CLI turns repository setup and supported integration tasks into explicit, testable commands. It does not provision a managed Tixkit service or hide provider/database requirements.

## Consumers

Use it as a contributor or self-hoster inside a Tixkit source checkout, or as an integrator using `tixkit init` and `embed:generate` from another directory.

## Status

Beta. Commands and flags are parity-tested with public documentation; provider-backed behavior still requires the named provider CLI and test/production configuration.

## Installation

Inside this workspace:

```bash
bun run --filter tixkit -- --help
```

From a published package channel, use the package manager and version approved by your organization. Do not run an unpinned remote CLI in a production automation path.

## Example

From the repository root:

```bash
cp .env.local.example .env.local
bun run setup:check -- --mode local
bun run quickstart -- --no-open
```

`quickstart` checks Docker and ports, starts local infrastructure, runs migrations, starts API/worker/checkout/admin/docs, waits for health, and seeds idempotent sample data. It stays in the foreground until interrupted.

## Public exports

The package exports the `tixkit` executable. Its supported commands are:

| Command                  | Purpose                                 | Important behavior                                                       |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------ |
| `init <dir>`             | Scaffold a supported SDK template       | Validates template/name/port; optional install and Git initialization    |
| `embed:generate`         | Generate widget markup and CSP guidance | Requires event and brand IDs; never accepts a secret                     |
| `setup:check` (`doctor`) | Validate an environment file            | Exits 0 on success and 1 on invalid configuration                        |
| `quickstart`             | Start the source-checkout stack         | Requires Docker and repository files; stays in foreground                |
| `seed:sample-data`       | Seed deterministic local sample state   | Intended to be idempotent and test-only                                  |
| `sandbox:reset`          | Rebuild an isolated integration sandbox | Refuses shared/provider-mode DBs and rotates a 24-hour scoped credential |
| `migration:*`            | Operate durable tenant migration jobs   | Commit/rollback require exact job-bound confirmation; supports JSON      |
| `seed:email-templates`   | Seed/restyle scoped lifecycle templates | Requires tenant, organization, and brand IDs; supports dry run           |
| `dev:webhooks`           | Run local Stripe forwarding             | Supports dry run and secret-write opt-out; live mode remains foreground  |

Run `tixkit --help` for the authoritative flag list. Key examples:

```bash
tixkit init ./my-integration --template nextjs --install
tixkit embed:generate --event-id evt_example --brand-id brd_example --mode inline --platform plain
tixkit setup:check --env-file .env.local --mode production
tixkit quickstart --no-open --skip-seed
tixkit dev:webhooks --api-url http://localhost:4000 --dry-run --no-write-secret
tixkit seed:sample-data
tixkit sandbox:reset
tixkit migration:create --request-file ./migration-request.json --json
tixkit migration:dry-run imp_example --json
tixkit migration:commit imp_example --confirm 'COMMIT imp_example' --json
```

## Runtime

The workspace pins Bun 1.3.14 and supports Node.js 20 or newer. `quickstart` additionally requires Docker Compose and the repository source tree. Live webhook forwarding requires the supported Stripe CLI.

## Configuration

`setup:check` reads `.env.local` by default and supports `local`, `provider`, and `production` modes. Production mode must use production-appropriate origins, credentials, signing material, database, Temporal, storage, auth, payment, and messaging configuration.

`dev:webhooks` reads `STRIPE_API_KEY` or `STRIPE_SECRET_KEY` when present. By default it writes the captured forwarding secret to the selected local env file; use `--no-write-secret` when another secret store owns it.

`sandbox:initialize` persists the destructive-reset marker for a dedicated migrated database. `sandbox:reset` requires that marker and an anchored sandbox/test database name. See [sandbox operations](../../docs/public/operators/sandbox-operations.mdx) before enabling remote reset.

Migration commands use `TIXKIT_API_KEY` and `TIXKIT_API_URL` (or `--api-url`). The create request is JSON; lifecycle commands take the job ID as their first positional argument. Use `--json` in automation. Review the [migration operations runbook](../../docs/public/operators/migration-operations.mdx) before committing or rolling back a job.

## Security

Never pass API keys or provider secrets in URLs or embed-generator arguments. Avoid shell history for secrets. `init` templates must keep server keys out of public environment variables. Treat a forwarding secret as sensitive and rotate it after exposure.

## Validation

```bash
bun run --filter tixkit typecheck
bun run --filter tixkit lint
bun run --filter tixkit test:unit
bun run docs:examples
```

## Compatibility

CLI help, root scripts, the local quickstart, public guides, and OSS export are one contract. A command/flag rename requires synchronized code, tests, and documentation.

## Related guides

- [Run Tixkit locally](../../docs/public/getting-started/local-quickstart.mdx)
- [Embed checkout](../../docs/public/developers/widget/embedding.mdx)
- [Test webhooks](../../docs/public/developers/webhooks/testing.mdx)
- [Operate migrations](../../docs/public/operators/migration-operations.mdx)
