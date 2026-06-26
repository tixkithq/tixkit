import { resetDatabase } from './migrate.js';

/**
 * Drop all GateKit tables and re-run migrations from scratch.
 *
 * Usage: bun run --env-file=.env.local --filter @gatekit/db reset
 *        (or `bun run db:reset` from the repo root)
 *
 * This is destructive: all local data is lost. Intended for local development
 * and CI setup when the schema is in a partial or stale state that
 * `bun run db:migrate` cannot repair.
 */
resetDatabase()
  .then(() => {
    console.log('Database reset completed');
  })
  .catch((err) => {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(
      [
        'GateKit database reset failed.',
        '- Start local infrastructure with `bun run infra:up`.',
        '- Verify DATABASE_URL points at the local database from `.env.local`.',
        '- Retry with `bun run db:reset`.',
        '',
        `Original error: ${detail}`,
      ].join('\n'),
    );
    process.exit(1);
  });
