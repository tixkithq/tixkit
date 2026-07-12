import { readFile } from 'node:fs/promises';
import { NativeConnection } from '@temporalio/worker';
import { createDb } from '@tixkit/db';
import { config } from './config.js';

async function healthcheck(): Promise<void> {
  const marker = JSON.parse(await readFile('/tmp/tixkit-worker-ready', 'utf8')) as {
    pid?: unknown;
    heartbeatAt?: unknown;
  };
  if (
    marker.pid !== 1 ||
    typeof marker.heartbeatAt !== 'number' ||
    Date.now() - marker.heartbeatAt > 20_000
  )
    throw new Error('worker heartbeat is missing or stale');
  process.kill(marker.pid, 0);
  const db = createDb(config.databaseUrl);
  try {
    const tables = await db.introspection.getTables({ withInternalKyselyTables: false });
    if (!tables.some((table) => table.name === 'events'))
      throw new Error('events table is missing');
  } finally {
    await db.destroy();
  }
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  await connection.close();
}

healthcheck().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
