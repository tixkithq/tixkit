import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  syncUserActivity,
  syncOrganizationActivity,
  deleteUserActivity,
  markProviderEventProcessedActivity,
} = proxyActivities<{
  syncUserActivity(input: {
    clerkUserId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    avatarUrl?: string;
  }): Promise<WorkflowActivityResult<{ userId: string; created: boolean }>>;
  syncOrganizationActivity(input: {
    clerkOrgId: string;
    name: string;
  }): Promise<WorkflowActivityResult<{ orgId: string; created: boolean }>>;
  deleteUserActivity(input: {
    clerkUserId: string;
  }): Promise<WorkflowActivityResult<{ suspended: boolean }>>;
  markProviderEventProcessedActivity(input: {
    provider: string;
    providerEventId: string;
  }): Promise<WorkflowActivityResult<{ processed: boolean }>>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

export type ClerkIdentitySyncWorkflowInput = {
  version: number;
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

function throwIfRetryableFailure(result: Exclude<WorkflowActivityResult<unknown>, { ok: true }>) {
  if (result.retryable) {
    throw new Error(`Clerk identity sync failed (${result.errorCode}): ${result.message}`);
  }
}

async function markClerkProviderEventProcessed(
  providerEventId: string,
): Promise<{ status: 'failed' } | undefined> {
  const result = await markProviderEventProcessedActivity({
    provider: 'clerk',
    providerEventId,
  });
  if (!result.ok) {
    throwIfRetryableFailure(result);
    return { status: 'failed' };
  }
  return undefined;
}

export async function clerkIdentitySyncWorkflow(
  input: ClerkIdentitySyncWorkflowInput,
): Promise<{ status: string }> {
  switch (input.eventType) {
    case 'user.created':
    case 'user.updated': {
      if (!input.clerkUserId || !input.email) {
        return (
          (await markClerkProviderEventProcessed(input.providerEventId)) ?? { status: 'skipped' }
        );
      }
      const result = await syncUserActivity({
        clerkUserId: input.clerkUserId,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        avatarUrl: input.avatarUrl,
      });
      if (!result.ok) {
        throwIfRetryableFailure(result);
        return { status: 'failed' };
      }
      return (await markClerkProviderEventProcessed(input.providerEventId)) ?? { status: 'synced' };
    }
    case 'user.deleted': {
      if (!input.clerkUserId) {
        return (
          (await markClerkProviderEventProcessed(input.providerEventId)) ?? { status: 'skipped' }
        );
      }
      const result = await deleteUserActivity({ clerkUserId: input.clerkUserId });
      if (!result.ok) {
        throwIfRetryableFailure(result);
        return { status: 'failed' };
      }
      return (await markClerkProviderEventProcessed(input.providerEventId)) ?? { status: 'synced' };
    }
    case 'organization.created':
    case 'organization.updated': {
      if (!input.clerkOrgId || !input.orgName) {
        return (
          (await markClerkProviderEventProcessed(input.providerEventId)) ?? { status: 'skipped' }
        );
      }
      const result = await syncOrganizationActivity({
        clerkOrgId: input.clerkOrgId,
        name: input.orgName,
      });
      if (!result.ok) {
        throwIfRetryableFailure(result);
        return { status: 'failed' };
      }
      return (await markClerkProviderEventProcessed(input.providerEventId)) ?? { status: 'synced' };
    }
    default:
      return (
        (await markClerkProviderEventProcessed(input.providerEventId)) ?? {
          status: 'unhandled',
        }
      );
  }
}
