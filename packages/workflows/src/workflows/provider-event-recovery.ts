import {
  ParentClosePolicy,
  continueAsNew,
  proxyActivities,
  sleep,
  startChild,
  workflowInfo,
} from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';
import {
  CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
  PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
  clerkIdentitySyncRecoveryWorkflowId,
  paymentReconciliationRecoveryWorkflowId,
} from '../shared/types.js';
import { clerkIdentitySyncWorkflow } from './clerk-identity-sync.js';
import { paymentReconciliationWorkflow } from './payment-reconciliation.js';

type ProviderEventRecoveryItem =
  | {
      id: string;
      provider: 'stripe';
      providerEventId: string;
      eventType: string;
      recoveryAttempts: number;
      workflow: 'payment_reconciliation';
      input: {
        providerEventId: string;
        provider: string;
        eventType: string;
        data: Record<string, unknown>;
      };
    }
  | {
      id: string;
      provider: 'clerk';
      providerEventId: string;
      eventType: string;
      recoveryAttempts: number;
      workflow: 'clerk_identity_sync';
      input: {
        providerEventId: string;
        eventType: string;
        clerkUserId?: string;
        clerkOrgId?: string;
        email?: string;
        firstName?: string;
        lastName?: string;
        avatarUrl?: string;
        orgName?: string;
      };
    };

const {
  claimUnprocessedProviderEventsActivity,
  markProviderEventRecoveryDispatchedActivity,
  markProviderEventRecoveryFailedActivity,
} = proxyActivities<{
  claimUnprocessedProviderEventsActivity(input: {
    ownerId: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<WorkflowActivityResult<{ events: ProviderEventRecoveryItem[] }>>;
  markProviderEventRecoveryDispatchedActivity(input: {
    id: string;
    ownerId: string;
    recoveryAttempts: number;
  }): Promise<WorkflowActivityResult<{ dispatched: boolean }>>;
  markProviderEventRecoveryFailedActivity(input: {
    id: string;
    ownerId: string;
    recoveryAttempts: number;
    message: string;
    retryable?: boolean;
  }): Promise<WorkflowActivityResult<{ failed: boolean }>>;
}>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

export type ProviderEventRecoveryWorkflowInput = {
  version?: number;
  tickIntervalSeconds?: number;
  batchSize?: number;
  leaseMs?: number;
  maxIterations?: number;
  continueAsNewAfterIterations?: number;
};

export const DEFAULT_PROVIDER_EVENT_RECOVERY_CONTINUE_AS_NEW_ITERATIONS = 1_440;

function throwIfRecoveryActivityFailed(label: string, result: WorkflowActivityResult<unknown>) {
  if (!result.ok && result.retryable) {
    throw new Error(`${label} failed (${result.errorCode}): ${result.message}`);
  }
}

async function dispatchProviderEventRecovery(
  ownerId: string,
  event: ProviderEventRecoveryItem,
): Promise<void> {
  try {
    if (event.workflow === 'payment_reconciliation') {
      await startChild(paymentReconciliationWorkflow, {
        workflowId: paymentReconciliationRecoveryWorkflowId(
          event.providerEventId,
          event.recoveryAttempts,
        ),
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        args: [
          {
            version: PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
            ...event.input,
          },
        ],
      });
    } else {
      await startChild(clerkIdentitySyncWorkflow, {
        workflowId: clerkIdentitySyncRecoveryWorkflowId(
          event.providerEventId,
          event.recoveryAttempts,
        ),
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        args: [
          {
            version: CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
            ...event.input,
          },
        ],
      });
    }

    const dispatched = await markProviderEventRecoveryDispatchedActivity({
      id: event.id,
      ownerId,
      recoveryAttempts: event.recoveryAttempts,
    });
    throwIfRecoveryActivityFailed('Provider event recovery dispatch mark', dispatched);
  } catch (err) {
    const failed = await markProviderEventRecoveryFailedActivity({
      id: event.id,
      ownerId,
      recoveryAttempts: event.recoveryAttempts,
      message: err instanceof Error ? err.message : 'Unknown provider event recovery error',
      retryable: true,
    });
    throwIfRecoveryActivityFailed('Provider event recovery failure mark', failed);
  }
}

export async function providerEventRecoveryWorkflow(
  input?: ProviderEventRecoveryWorkflowInput,
): Promise<void> {
  const tickIntervalSeconds = input?.tickIntervalSeconds ?? 60;
  const batchSize = input?.batchSize ?? 25;
  const leaseMs = input?.leaseMs ?? 5 * 60_000;
  const maxIterations = input?.maxIterations;
  const continueAsNewAfterIterations = Math.max(
    1,
    input?.continueAsNewAfterIterations ??
      DEFAULT_PROVIDER_EVENT_RECOVERY_CONTINUE_AS_NEW_ITERATIONS,
  );
  let iterations = 0;

  while (true) {
    if (maxIterations !== undefined && iterations >= maxIterations) return;

    const info = workflowInfo();
    const ownerId = `provider-event-recovery:${info.workflowId}:${info.runId}:${iterations}`;
    // eslint-disable-next-line no-await-in-loop -- recovery scanner claims one deterministic batch per tick.
    const claimed = await claimUnprocessedProviderEventsActivity({
      ownerId,
      limit: batchSize,
      leaseMs,
    });
    throwIfRecoveryActivityFailed('Provider event recovery claim', claimed);
    if (claimed.ok) {
      // eslint-disable-next-line no-await-in-loop -- starts are tied to the claimed lease owner.
      await Promise.all(
        claimed.value.events.map((event) => dispatchProviderEventRecovery(ownerId, event)),
      );
    }

    iterations += 1;
    if (maxIterations !== undefined && iterations >= maxIterations) return;
    if (maxIterations === undefined && iterations >= continueAsNewAfterIterations) {
      await continueAsNew<typeof providerEventRecoveryWorkflow>({
        version: input?.version,
        tickIntervalSeconds,
        batchSize,
        leaseMs,
        continueAsNewAfterIterations,
      });
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- Temporal sleep spaces provider-event recovery ticks.
    await sleep(`${tickIntervalSeconds} seconds`);
  }
}
