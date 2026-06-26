/**
 * Vitest globalSetup for API integration tests.
 *
 * When DATABASE_URL is present (env-backed run via `bun --env-file=.env.local
 * run test:integration`), this ensures the database schema is migrated before
 * DB-backed suites (inventory concurrency, load harnesses) execute. When
 * DATABASE_URL is absent, the setup is a no-op and those suites skip via
 * `describe.skipIf(!process.env.DATABASE_URL)`.
 *
 * This removes the tribal-knowledge requirement of running `bun run
 * db:migrate` before env-backed integration tests.
 */
export async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    // No DB configured; DB-backed suites will skip. Nothing to do.
    return;
  }

  // Import dynamically so the db package is only loaded when needed and so
  // the root config (which may be used without a DB) does not fail resolving
  // the workspace dependency.
  const { runMigrations } = await import('@gatekit/db/migrate');

  try {
    await runMigrations(databaseUrl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      [
        'API integration test migration bootstrap failed.',
        'DATABASE_URL is set but migrations could not be applied.',
        'Run `bun run db:reset` to drop and recreate the schema, then retry.',
        '',
        `Original error: ${detail}`,
      ].join('\n'),
    );
  }
}

export async function teardown(): Promise<void> {
  // Nothing to clean up; test suites own their data lifecycle.
}
