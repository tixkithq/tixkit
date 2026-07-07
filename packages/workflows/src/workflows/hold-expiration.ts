import { continueAsNew, patched, proxyActivities, sleep } from '@temporalio/workflow';
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
    if (patched('privacy-retention-maintenance-v1')) {
      // eslint-disable-next-line no-await-in-loop -- privacy retention repair runs once per deterministic maintenance tick.
      const privacyRetentionResult = await enforcePrivacyRetentionActivity();
      throwIfMaintenanceFailed('Privacy retention repair', privacyRetentionResult);
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
