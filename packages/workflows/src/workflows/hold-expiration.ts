import {
  ActivityFailure,
  continueAsNew,
  isCancellation,
  patched,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  expireStaleHoldsActivity,
  expireStaleSessionsActivity,
  processWaitlistOffersActivity,
  recoverQueuedMessageHandoffsActivity,
  enforcePrivacyRetentionActivity,
  cleanupMigrationMediaObjectsActivity,
  processProviderAccountCleanupActivity,
} = proxyActivities<{
  expireStaleHoldsActivity(): Promise<WorkflowActivityResult<{ expiredCount: number }>>;
  expireStaleSessionsActivity(): Promise<WorkflowActivityResult<{ expiredCount: number }>>;
  processWaitlistOffersActivity(): Promise<
    WorkflowActivityResult<{
      expiredCount: number;
      offeredCount: number;
      queuedEmailCount: number;
    }>
  >;
  recoverQueuedMessageHandoffsActivity(): Promise<
    WorkflowActivityResult<{ recoveredEmailCount: number; recoveredSmsCount: number }>
  >;
  enforcePrivacyRetentionActivity(): Promise<
    WorkflowActivityResult<{ inspectedCount: number; repairedCount: number; skippedCount: number }>
  >;
  cleanupMigrationMediaObjectsActivity(): Promise<
    WorkflowActivityResult<{ completed: number; retained: number; failed: number }>
  >;
  processProviderAccountCleanupActivity(): Promise<
    WorkflowActivityResult<{ completed: number; retried: number; manualReview: number }>
  >;
}>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

const { eraseExpiredAgentMemoryActivity } = proxyActivities<{
  eraseExpiredAgentMemoryActivity(): Promise<{ erasedCount: number }>;
}>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

const { eraseExpiredProviderIncidentEvidenceActivity } = proxyActivities<{
  eraseExpiredProviderIncidentEvidenceActivity(): Promise<{ erasedCount: number }>;
}>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

export type HoldExpirationWorkflowInput = {
  version?: number;
  tickIntervalSeconds?: number;
  maxIterations?: number;
  continueAsNewAfterIterations?: number;
};

export const DEFAULT_HOLD_EXPIRATION_CONTINUE_AS_NEW_ITERATIONS = 1_440;

function throwIfMaintenanceFailed(label: string, result: WorkflowActivityResult<unknown>) {
  if (!result.ok && result.retryable) {
    throw new Error(`${label} failed (${result.errorCode}): ${result.message}`);
  }
}

export async function holdExpirationWorkflow(input?: HoldExpirationWorkflowInput): Promise<void> {
  // Version is accepted for contract consistency with other workflows. The value
  // is intentionally not branched on so replays stay deterministic across versions;
  // future schema changes should introduce new versions and gated migrations instead.
  const tickIntervalSeconds = input?.tickIntervalSeconds ?? 60;
  const maxIterations = input?.maxIterations;
  const continueAsNewAfterIterations = Math.max(
    1,
    input?.continueAsNewAfterIterations ?? DEFAULT_HOLD_EXPIRATION_CONTINUE_AS_NEW_ITERATIONS,
  );
  let iterations = 0;

  // This is a long-running workflow that periodically expires stale holds,
  // sessions, waitlist offers, and privacy-retention repairs. `maxIterations`
  // keeps unit tests bounded; production starts omit it so the workflow rolls
  // over with continue-as-new before history grows without bound.
  while (true) {
    if (maxIterations !== undefined && iterations >= maxIterations) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- scheduled maintenance workflow intentionally runs one tick at a time for deterministic history.
    const staleHoldsResult = await expireStaleHoldsActivity();
    throwIfMaintenanceFailed('Stale hold expiration', staleHoldsResult);
    // eslint-disable-next-line no-await-in-loop -- stale sessions expire after stale holds in the same deterministic tick.
    const staleSessionsResult = await expireStaleSessionsActivity();
    throwIfMaintenanceFailed('Stale session expiration', staleSessionsResult);
    // eslint-disable-next-line no-await-in-loop -- waitlist maintenance follows inventory cleanup so newly freed capacity can be offered.
    const waitlistOffersResult = await processWaitlistOffersActivity();
    throwIfMaintenanceFailed('Waitlist offer processing', waitlistOffersResult);
    if (patched('message-handoff-recovery-v1')) {
      // eslint-disable-next-line no-await-in-loop -- durable message handoff repair runs once per deterministic maintenance tick.
      const messageHandoffResult = await recoverQueuedMessageHandoffsActivity();
      throwIfMaintenanceFailed('Message handoff recovery', messageHandoffResult);
    }
    if (patched('privacy-retention-maintenance-v1')) {
      // eslint-disable-next-line no-await-in-loop -- privacy retention repair runs once per deterministic maintenance tick.
      const privacyRetentionResult = await enforcePrivacyRetentionActivity();
      throwIfMaintenanceFailed('Privacy retention repair', privacyRetentionResult);
    }
    if (patched('portable-media-cleanup-v1')) {
      // eslint-disable-next-line no-await-in-loop -- durable media cleanup runs once per deterministic maintenance tick.
      const mediaCleanupResult = await cleanupMigrationMediaObjectsActivity();
      throwIfMaintenanceFailed('Portable media cleanup', mediaCleanupResult);
    }
    if (patched('provider-account-cleanup-v1')) {
      // eslint-disable-next-line no-await-in-loop -- leased provider cleanup runs once per deterministic maintenance tick.
      const providerCleanupResult = await processProviderAccountCleanupActivity();
      throwIfMaintenanceFailed('Provider account cleanup', providerCleanupResult);
    }
    if (patched('agent-memory-retention-v1')) {
      try {
        // eslint-disable-next-line no-await-in-loop -- durable memory erasure runs once per deterministic maintenance tick.
        await eraseExpiredAgentMemoryActivity();
      } catch (error) {
        if (isCancellation(error) || !(error instanceof ActivityFailure)) throw error;
        // Exhausted activity retries must not terminate the only recurring maintenance workflow.
        // The next deterministic tick invokes a fresh activity run and preserves eventual erasure.
      }
    }
    if (patched('provider-incident-retention-v1')) {
      try {
        // eslint-disable-next-line no-await-in-loop -- encrypted provider evidence expires on every deterministic maintenance tick.
        await eraseExpiredProviderIncidentEvidenceActivity();
      } catch (error) {
        if (isCancellation(error) || !(error instanceof ActivityFailure)) throw error;
        // The next tick invokes a fresh activity run and preserves eventual deletion.
      }
    }
    iterations += 1;
    if (maxIterations !== undefined && iterations >= maxIterations) {
      return;
    }
    if (maxIterations === undefined && iterations >= continueAsNewAfterIterations) {
      await continueAsNew<typeof holdExpirationWorkflow>({
        version: input?.version,
        tickIntervalSeconds,
        continueAsNewAfterIterations,
      });
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- Temporal sleep spaces recurring maintenance ticks.
    await sleep(`${tickIntervalSeconds} seconds`);
  }
}
