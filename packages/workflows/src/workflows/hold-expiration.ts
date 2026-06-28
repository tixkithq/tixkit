import { patched, proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  expireStaleHoldsActivity,
  expireStaleSessionsActivity,
  processWaitlistOffersActivity,
  enforcePrivacyRetentionActivity,
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
  enforcePrivacyRetentionActivity(): Promise<
    WorkflowActivityResult<{ inspectedCount: number; repairedCount: number; skippedCount: number }>
  >;
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
};

function throwIfPrivacyRetentionFailed(
  result: WorkflowActivityResult<{
    inspectedCount: number;
    repairedCount: number;
    skippedCount: number;
  }>,
) {
  if (!result.ok && result.retryable) {
    throw new Error(`Privacy retention repair failed (${result.errorCode}): ${result.message}`);
  }
}

export async function holdExpirationWorkflow(input?: HoldExpirationWorkflowInput): Promise<void> {
  // Version is accepted for contract consistency with other workflows. The value
  // is intentionally not branched on so replays stay deterministic across versions;
  // future schema changes should introduce new versions and gated migrations instead.
  const tickIntervalSeconds = input?.tickIntervalSeconds ?? 60;
  const maxIterations = input?.maxIterations;
  let iterations = 0;

  // This is a long-running workflow that periodically expires stale holds,
  // sessions, waitlist offers, and privacy-retention repairs. `maxIterations` keeps unit tests bounded;
  // production starts omit it so the workflow continues running.
  while (true) {
    if (maxIterations !== undefined && iterations >= maxIterations) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- scheduled maintenance workflow intentionally runs one tick at a time for deterministic history.
    await expireStaleHoldsActivity();
    // eslint-disable-next-line no-await-in-loop -- stale sessions expire after stale holds in the same deterministic tick.
    await expireStaleSessionsActivity();
    // eslint-disable-next-line no-await-in-loop -- waitlist maintenance follows inventory cleanup so newly freed capacity can be offered.
    await processWaitlistOffersActivity();
    if (patched('privacy-retention-maintenance-v1')) {
      // eslint-disable-next-line no-await-in-loop -- privacy retention repair runs once per deterministic maintenance tick.
      const privacyRetentionResult = await enforcePrivacyRetentionActivity();
      throwIfPrivacyRetentionFailed(privacyRetentionResult);
    }
    iterations += 1;
    if (maxIterations !== undefined && iterations >= maxIterations) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- Temporal sleep spaces recurring maintenance ticks.
    await sleep(`${tickIntervalSeconds} seconds`);
  }
}
