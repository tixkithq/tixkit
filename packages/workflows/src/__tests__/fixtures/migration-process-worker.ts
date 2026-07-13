import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createDb } from '@tixkit/db';
import {
  assessMigrationRollbackActivity,
  beginMigrationCommitActivity,
  cancelMigrationCommitActivity,
  completeMigrationCommitActivity,
  executeMigrationRollbackActivity,
  failMigrationCommitActivity,
  processMigrationStageActivity,
  reconcileMigrationActivity,
  recordMigrationProgressActivity,
  registerMigrationActivityService,
  setMigrationPausedActivity,
  type MigrationCommitStage,
} from '../../activities/migration.js';
import { createProductionMigrationCommitters } from '../../activities/migration-domain-committers.js';
import { createRepositoryMigrationActivityService } from '../../activities/migration-repository-service.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = requiredEnvironment('TIXKIT_TEST_DATABASE_URL');
const temporalAddress = requiredEnvironment('TEMPORAL_ADDRESS');
const taskQueue = requiredEnvironment('TIXKIT_MIGRATION_TASK_QUEUE');
const crashAfterRowStage = process.env.TIXKIT_MIGRATION_CRASH_AFTER_ROW_STAGE as
  | MigrationCommitStage
  | undefined;
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const db = createDb(databaseUrl);
let crashTriggered = false;
const unregisterService = registerMigrationActivityService(
  createRepositoryMigrationActivityService(db, createProductionMigrationCommitters(db), undefined, {
    async afterRowCompletion(input) {
      if (!crashTriggered && crashAfterRowStage === input.stage) {
        crashTriggered = true;
        console.log(`TIXKIT_MIGRATION_CRASH_POINT stage=${input.stage}`);
        await new Promise<never>(() => undefined);
      }
    },
  }),
);
const connection = await NativeConnection.connect({ address: temporalAddress });
const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL('../../workflows/index.ts', import.meta.url)),
  maxCachedWorkflows: 0,
  activities: {
    beginMigrationCommitActivity,
    processMigrationStageActivity,
    recordMigrationProgressActivity,
    setMigrationPausedActivity,
    cancelMigrationCommitActivity,
    reconcileMigrationActivity,
    assessMigrationRollbackActivity,
    executeMigrationRollbackActivity,
    completeMigrationCommitActivity,
    failMigrationCommitActivity,
  },
});

let shutdownRequested = false;
const requestShutdown = () => {
  if (shutdownRequested || worker.getState() !== 'RUNNING') return;
  shutdownRequested = true;
  worker.shutdown();
};
process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  const running = worker.run();
  console.log(`TIXKIT_MIGRATION_PROCESS_WORKER_READY taskQueue=${taskQueue}`);
  await running;
} finally {
  unregisterService();
  await db.destroy();
  await connection.close();
}
